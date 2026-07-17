#!/usr/bin/env python3
"""RunPod-hosted LoRA training server (Lane C) — the SERVER side of the
`service/training/trainer_job.py::_remote_train` client contract.

A Mosh training job dispatched with MOSH_TRAINING_BACKEND=remote_http +
MOSH_TRAINING_REMOTE_URL=http://<pod-host>:<port> POSTs a base64 corpus bundle here;
this server trains an SA3 LoRA on the pod GPU and returns the finished `.safetensors`
(base64) — which `service/loras/install.py` enrolls into the rack, instantly usable
via the runtime `apply_loras` slider. No new native commands: the 11 training commands
+ `_remote_train` already cover the round-trip.

Endpoints (exactly the client's shape):
  GET  /health              -> {ok, backend, gpu}
  POST /training/jobs       {config, bundle:{archive_b64, bundle_hash, ...}, output_dir}
                            -> {job_id, status_url, adapter_id}
  GET  /training/jobs/<id>  -> {status: queued|running|ready|error,
                                result:{artifact_b64, manifest_json, adapter_id, quality}, error}

Trainer backend (auto-selected, mirrors the SA3 adapter's real→fake posture):
  real — the PROVEN pipeline (pre_encode_dataset.py -> train_lora.py --model medium-base
         --rank 16 --adapter_type dora-rows -> .ckpt -> .safetensors via install._ckpt_to_
         safetensors). Runs when `stable_audio_3` imports (i.e. on the pod).
  fake — a deterministic, tiny, VALID dora-rows `.safetensors` (stdlib, no GPU). The default
         when the SA3 stack is absent OR MOSH_TRAINER_IMPL=fake — so the contract is
         hermetically testable on any machine.

Run on the pod:  python3 service/training/runpod_server.py --port 8799
                 (the bootstrap `runpod_serve.sh` installs deps + launches this)
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import struct
import subprocess
import sys
import threading
import time
import uuid
import zipfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

# ── job store ────────────────────────────────────────────────────────────────────
_jobs: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()

if os.name == "nt":
    # Windows has no /tmp; %TMP%/%TEMP% via tempfile (FIT-013 local-4070 lane).
    import tempfile
    _tmp_default = tempfile.gettempdir()
else:
    _tmp_default = os.environ.get("TMPDIR", "/tmp")
WORK_ROOT = Path(os.environ.get("MOSH_TRAINER_WORK",
                                os.path.join(_tmp_default, "mosh-runpod-train")))
# The proven SA3 code tree (holds scripts/pre_encode_dataset.py + scripts/train_lora.py).
SA3_TRAIN_DIR = os.environ.get("SA3_TRAIN_DIR", "/workspace/stable-audio-3")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# ── minimal safetensors serializer (stdlib) — used by the fake trainer ──────────────
def _safetensors_bytes(tensors: dict[str, tuple[list[int], bytes, str]],
                       metadata: dict[str, str]) -> bytes:
    """tensors: {name: (shape, raw_bytes, dtype_str)}. Emits the safetensors container
    that service/sa3/lora_merge.read_safetensors reads (u64 header-len + JSON header
    with __metadata__ + packed tensor bytes)."""
    header: dict[str, Any] = {}
    body = bytearray()
    off = 0
    for name, (shape, raw, dtype) in tensors.items():
        header[name] = {"dtype": dtype, "shape": list(shape), "data_offsets": [off, off + len(raw)]}
        body += raw
        off += len(raw)
    header["__metadata__"] = {k: str(v) for k, v in metadata.items()}
    hb = json.dumps(header).encode("utf-8")
    return struct.pack("<Q", len(hb)) + hb + bytes(body)


def _fake_lora_safetensors(rank: int, out_dim: int = 8, in_dim: int = 8) -> bytes:
    """A minimal VALID dora-rows LoRA: one module carrying lora_A/lora_B/magnitude (f16
    zeros). install._validate accepts it (adapter_type dora-rows, groups > 0, all parts
    present) so the whole enroll→rack→apply path is exercised without a GPU."""
    def zeros(n: int) -> bytes:
        return b"\x00\x00" * n                       # f16 zero = 0x0000
    m = "model.transformer_blocks.0.attn.to_q"       # any DiT-shaped module name
    p = f"{m}.parametrizations.weight.0."
    tensors = {
        p + "lora_A": ([rank, in_dim], zeros(rank * in_dim), "F16"),
        p + "lora_B": ([out_dim, rank], zeros(out_dim * rank), "F16"),
        p + "magnitude": ([out_dim], zeros(out_dim), "F16"),
    }
    return _safetensors_bytes(tensors, {"lora_config": json.dumps(
        {"adapter_type": "dora-rows", "rank": rank})})


# ── trainer backends ────────────────────────────────────────────────────────────
def _real_available() -> bool:
    if os.environ.get("MOSH_TRAINER_IMPL", "").strip().lower() in {"fake", "stub"}:
        return False
    if os.environ.get("MOSH_TRAINER_IMPL", "").strip().lower() == "real":
        return True
    try:
        import stable_audio_3  # noqa: F401
        return True
    except Exception:
        return False


def backend_name() -> str:
    return "real" if _real_available() else "fake"


def _extract_bundle(archive_b64: str, dest: Path) -> Path:
    dest.mkdir(parents=True, exist_ok=True)
    raw = base64.b64decode(archive_b64.encode("ascii"))
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        # guard against path traversal in the archive
        for name in zf.namelist():
            p = (dest / name).resolve()
            if not str(p).startswith(str(dest.resolve())):
                raise ValueError(f"unsafe archive path: {name}")
        zf.extractall(dest)
    return dest


def _bundle_audio_dir(bundle_dir: Path) -> Path:
    src = bundle_dir / "sources"
    return src if src.is_dir() else bundle_dir


def _train_fake(bundle_dir: Path, config: dict[str, Any], bundle_hash: str) -> tuple[bytes, dict[str, Any]]:
    rank = int(config.get("rank", 16))
    audio = sorted(str(p.name) for p in _bundle_audio_dir(bundle_dir).glob("*") if p.is_file()
                   and p.suffix.lower() in (".wav", ".mp3", ".flac", ".aif", ".aiff", ".m4a"))
    adapter_id = hashlib.sha256(
        json.dumps({"bundle_hash": bundle_hash, "config": config, "backend": "fake"},
                   sort_keys=True).encode("utf-8")).hexdigest()[:16]
    blob = _fake_lora_safetensors(rank)
    manifest = {
        "schema_version": 1, "adapter_id": adapter_id, "backend": "fake",
        "adapter_type": "dora-rows", "n_modules": 1, "rank": rank,
        "steps": int(config.get("steps", 2000)), "base_model": config.get("base_model", "medium-base"),
        "bundle_hash": bundle_hash, "source_count": len(audio), "created_at": _now(),
        "note": "hermetic fake trainer (no GPU) — swap MOSH_TRAINER_IMPL=real on the pod",
    }
    quality = {"source_count": len(audio), "stub": True, "backend": "fake"}
    return blob, {"manifest": manifest, "quality": quality, "adapter_id": adapter_id}


def _train_real(bundle_dir: Path, config: dict[str, Any], bundle_hash: str,
                workdir: Path) -> tuple[bytes, dict[str, Any]]:
    """The proven SA3 pipeline: pre_encode_dataset.py -> train_lora.py -> .ckpt ->
    .safetensors. Mirrors ~/mosh-loras/work/pod_run_sa3.sh (medium-base, rank16,
    dora-rows). Runs only on the pod (stable_audio_3 present)."""
    sa3 = Path(SA3_TRAIN_DIR)
    py = sys.executable
    audio_dir = _bundle_audio_dir(bundle_dir)
    latents = workdir / "latents"
    out = workdir / "out"
    latents.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    name = "corpus"
    rank = int(config.get("rank", 16))
    steps = int(config.get("steps", 2000))

    # S2 — pre-encode the corpus audio to latents (same-l VAE).
    subprocess.run([py, str(sa3 / "scripts" / "pre_encode_dataset.py"),
                    "--model", "same-l", "--data_dir", str(audio_dir),
                    "--output_path", str(latents), "--batch_size", "1", "--model_half"],
                   check=True, cwd=str(sa3))
    # S3 — train the LoRA (the exact proven invocation).
    subprocess.run([py, str(sa3 / "scripts" / "train_lora.py"),
                    "--model", str(config.get("base_model") or "medium-base"),
                    "--encoded_dir", str(latents), "--rank", str(rank),
                    "--adapter_type", "dora-rows", "--steps", str(steps),
                    "--batch_size", "4", "--duration", "20",
                    "--checkpoint_every", "500", "--demo_every", "100000",
                    "--log_every", "50", "--logger", "csv", "--name", name,
                    "--save_dir", str(out)],
                   check=True, cwd=str(sa3))

    ckpts = sorted(out.rglob("*.ckpt"), key=lambda p: p.stat().st_mtime)
    if not ckpts:
        # some builds export a .safetensors directly
        sts = sorted(out.rglob("*.safetensors"), key=lambda p: p.stat().st_mtime)
        if not sts:
            raise RuntimeError("training produced no .ckpt or .safetensors")
        blob = sts[-1].read_bytes()
    else:
        # convert the latest .ckpt -> .safetensors using install.py's proven converter
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # service/
        from loras import install as LORA_INSTALL  # type: ignore
        st_path = workdir / "adapter.safetensors"
        LORA_INSTALL._ckpt_to_safetensors(str(ckpts[-1]), str(st_path))
        blob = st_path.read_bytes()

    adapter_id = hashlib.sha256(
        json.dumps({"bundle_hash": bundle_hash, "config": config, "backend": "real"},
                   sort_keys=True).encode("utf-8")).hexdigest()[:16]
    manifest = {
        "schema_version": 1, "adapter_id": adapter_id, "backend": "real",
        "adapter_type": "dora-rows", "rank": rank, "steps": steps,
        "base_model": config.get("base_model", "medium-base"),
        "bundle_hash": bundle_hash, "created_at": _now(),
    }
    return blob, {"manifest": manifest, "quality": {"backend": "real", "steps": steps}, "adapter_id": adapter_id}


def _run_job(job_id: str, archive_b64: str, config: dict[str, Any], bundle_hash: str) -> None:
    workdir = WORK_ROOT / job_id
    try:
        bundle_dir = _extract_bundle(archive_b64, workdir / "bundle")
        if _real_available():
            blob, extra = _train_real(bundle_dir, config, bundle_hash, workdir)
        else:
            blob, extra = _train_fake(bundle_dir, config, bundle_hash)
        result = {
            "artifact_b64": base64.b64encode(blob).decode("ascii"),
            "manifest_json": extra["manifest"],
            "adapter_id": extra["adapter_id"],
            "quality": extra["quality"],
        }
        with _lock:
            _jobs[job_id].update({"status": "ready", "result": result,
                                  "quality": extra["quality"], "finished_at": _now()})
    except subprocess.CalledProcessError as e:
        with _lock:
            _jobs[job_id].update({"status": "error", "error": f"training subprocess failed: {e}"})
    except Exception as e:  # noqa: BLE001
        with _lock:
            _jobs[job_id].update({"status": "error", "error": f"{type(e).__name__}: {e}"})


# ── HTTP ─────────────────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # quiet
        pass

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        n = int(self.headers.get("Content-Length", 0) or 0)
        if n <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path == "/health":
            self._send(200, {"ok": True, "backend": backend_name(),
                             "gpu": os.environ.get("CUDA_VISIBLE_DEVICES", ""),
                             "sa3_dir": SA3_TRAIN_DIR})
            return
        if path.startswith("/training/jobs/"):
            job_id = path.rsplit("/", 1)[-1]
            with _lock:
                job = _jobs.get(job_id)
            if job is None:
                self._send(404, {"status": "error", "error": "unknown job_id"})
                return
            out = {"status": job["status"]}
            if job.get("error"):
                out["error"] = job["error"]
            if job.get("quality"):
                out["quality"] = job["quality"]
            if job["status"] == "ready" and job.get("result"):
                out["result"] = job["result"]
            self._send(200, out)
            return
        self._send(404, {"error": f"unknown path: {path}"})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path != "/training/jobs":
            self._send(404, {"error": f"unknown path: {path}"})
            return
        data = self._read_json()
        bundle = data.get("bundle") or {}
        archive_b64 = bundle.get("archive_b64") or ""
        if not archive_b64:
            self._send(400, {"error": "bundle.archive_b64 required"})
            return
        config = data.get("config") or {}
        bundle_hash = str(bundle.get("bundle_hash", ""))
        job_id = uuid.uuid4().hex[:16]
        with _lock:
            _jobs[job_id] = {"status": "queued", "created_at": _now(),
                             "bundle_hash": bundle_hash, "result": None, "error": None}
        threading.Thread(target=_run_job, args=(job_id, archive_b64, config, bundle_hash),
                         daemon=True).start()
        self._send(200, {"job_id": job_id, "status_url": f"/training/jobs/{job_id}",
                         "backend": backend_name()})


def main() -> int:
    ap = argparse.ArgumentParser(description="Mosh RunPod LoRA training server (Lane C)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("MOSH_TRAINER_PORT", "8799")))
    ap.add_argument("--host", default=os.environ.get("MOSH_TRAINER_HOST", "0.0.0.0"))
    args = ap.parse_args()
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"mosh-runpod-train: backend={backend_name()} listening on {args.host}:{args.port} "
          f"(sa3_dir={SA3_TRAIN_DIR}, work={WORK_ROOT})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
