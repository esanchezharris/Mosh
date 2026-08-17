from __future__ import annotations

import base64
import hashlib
import json
import os
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .rights import write_json


def _digest_json(payload: dict[str, Any]) -> str:
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def _backend_mode() -> str:
    """Which trainer runs: a real local fine-tune, a rented GPU, or the stub.

    NOTE the bare `"local"` alias deliberately maps to `local_pmetal`, not to
    `fake`. It used to mean the stub, which was harmless while no real local
    trainer existed and is a live footgun now — anyone asking for "local"
    means "train on this machine".  `local_fake` still selects the stub
    explicitly, which is what the tests want.
    """
    forced = os.environ.get("MOSH_TRAINING_BACKEND", "").strip().lower()
    if forced in {"fake", "stub", "local_fake"}:
        return "fake"
    if forced in {"local", "local_pmetal", "pmetal"}:
        return "local_pmetal"
    if forced in {"remote", "remote_http", "remote-gpu", "gpu"}:
        return "remote_http"
    remote_url = os.environ.get("MOSH_TRAINING_REMOTE_URL", "").strip()
    if remote_url:
        return "remote_http"
    try:
        from . import local_pmetal
        if local_pmetal.available():
            return "local_pmetal"
    except Exception:  # noqa: BLE001 — a missing/broken local trainer must not break the service
        pass
    return "fake"


def backend_name() -> str:
    return _backend_mode()


def available() -> bool:
    return True


def _load_manifest(bundle_path: Path) -> dict[str, Any]:
    manifest_path = bundle_path / "corpus.manifest.json"
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def _config_payload(config: dict[str, Any]) -> dict[str, Any]:
    return {
        "rank": int(config.get("rank", 16)),
        "steps": int(config.get("steps", 2000)),
        "lr": float(config.get("lr", 1e-4)),
        "base_model": str(config.get("base_model", "")),
        "backend": str(config.get("backend", backend_name())),
    }


def _archive_bundle(bundle_path: Path) -> Path:
    tmp = tempfile.NamedTemporaryFile(prefix="mosh-corpus-", suffix=".zip", delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()
    with zipfile.ZipFile(tmp_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(bundle_path.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(bundle_path).as_posix())
    return tmp_path


def _extract_inline_json(value: Any) -> dict[str, Any] | None:
    if isinstance(value, str) and value:
        try:
            parsed = json.loads(value)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            return None
    if isinstance(value, dict):
        return value
    return None


def _normalize_result(result: Any) -> dict[str, Any]:
    if isinstance(result, dict):
        return result
    if isinstance(result, str):
        try:
            data = json.loads(result)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}
    return {}


def _post_json(url: str, payload: dict[str, Any], headers: dict[str, str] | None = None) -> dict[str, Any]:
    req_headers = {"Content-Type": "application/json"}
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=req_headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"remote trainer HTTP {exc.code}: {body}") from exc
    return json.loads(data) if data else {}


def _get_json(url: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    req = urllib.request.Request(url, headers=headers or {}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"remote trainer HTTP {exc.code}: {body}") from exc
    return json.loads(data) if data else {}


def _download_bytes(url: str, headers: dict[str, str] | None = None) -> bytes:
    req = urllib.request.Request(url, headers=headers or {}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.read()
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"remote trainer HTTP {exc.code}: {body}") from exc


def _write_result_files(out: Path,
                        artifact_payload: bytes | dict[str, Any] | None,
                        manifest_payload: bytes | dict[str, Any] | None) -> tuple[Path, Path]:
    out.mkdir(parents=True, exist_ok=True)
    artifact_path = out / "adapter.lora.json"
    manifest_path = out / "adapter.manifest.json"

    if isinstance(artifact_payload, bytes):
        artifact_path.write_bytes(artifact_payload)
    elif isinstance(artifact_payload, dict):
        artifact_path.write_text(json.dumps(artifact_payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    else:
        artifact_path.write_text("{}\n", encoding="utf-8")

    if isinstance(manifest_payload, bytes):
        manifest_path.write_bytes(manifest_payload)
    elif isinstance(manifest_payload, dict):
        write_json(manifest_path, manifest_payload)
    else:
        write_json(manifest_path, {"schema_version": 1, "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")})

    return artifact_path, manifest_path


def _fake_train(corpus_bundle: str, output_dir: str, config: dict[str, Any]) -> dict[str, Any]:
    bundle_path = Path(corpus_bundle)
    manifest = _load_manifest(bundle_path)

    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    artifact_path = out / "adapter.lora.json"
    artifact_manifest_path = out / "adapter.manifest.json"

    config_payload = _config_payload({**config, "backend": "fake"})
    adapter_id = _digest_json({"bundle_hash": manifest.get("bundle_hash"), "config": config_payload})[:16]
    quality = {
        "source_count": int(manifest.get("source_count", 0)),
        "adapter_density": round(min(1.0, max(0.05, int(manifest.get("source_count", 0)) / 8.0)), 3),
        "stub": True,
        "backend": "fake",
    }
    artifact = {
        "schema_version": 1,
        "adapter_id": adapter_id,
        "bundle_hash": manifest.get("bundle_hash", ""),
        "corpus_bundle": str(bundle_path),
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "config": config_payload,
        "quality": quality,
        "output_format": "json_stub",
    }
    artifact_path.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    manifest_payload = {
        "schema_version": 1,
        "adapter_id": adapter_id,
        "bundle_hash": manifest.get("bundle_hash", ""),
        "corpus_bundle": str(bundle_path),
        "artifact_path": str(artifact_path),
        "artifact_manifest_path": str(artifact_manifest_path),
        "config": config_payload,
        "quality": quality,
        "output_format": "json_stub",
    }
    write_json(artifact_manifest_path, manifest_payload)
    return {
        "ok": True,
        "adapter_id": adapter_id,
        "artifact_path": str(artifact_path),
        "manifest_path": str(artifact_manifest_path),
        "bundle_hash": manifest.get("bundle_hash", ""),
        "quality": quality,
        "backend": "fake",
    }


def _remote_train(corpus_bundle: str, output_dir: str, config: dict[str, Any]) -> dict[str, Any]:
    remote_url = os.environ.get("MOSH_TRAINING_REMOTE_URL", "").strip().rstrip("/")
    if not remote_url:
        raise RuntimeError("MOSH_TRAINING_REMOTE_URL is required for the remote training backend")
    bundle_path = Path(corpus_bundle)
    manifest = _load_manifest(bundle_path)
    config_payload = _config_payload(config)
    archive_path = _archive_bundle(bundle_path)
    try:
        archive_b64 = base64.b64encode(archive_path.read_bytes()).decode("ascii")
        submit_payload = {
            "config": config_payload,
            "corpus_bundle": str(bundle_path),
            "bundle": {
                "bundle_id": manifest.get("bundle_id", bundle_path.name),
                "bundle_hash": manifest.get("bundle_hash", ""),
                "archive_format": "zip",
                "archive_name": archive_path.name,
                "archive_b64": archive_b64,
            },
            "output_dir": output_dir,
        }
        submit = _post_json(f"{remote_url}/training/jobs", submit_payload)
        if not isinstance(submit, dict):
            submit = {}
        job_id = str(submit.get("job_id") or submit.get("jobId") or "").strip()
        if not job_id:
            raise RuntimeError("remote trainer did not return a job_id")
        status_url = str(submit.get("status_url") or submit.get("statusUrl") or "").strip()
        if not status_url:
            status_url = f"{remote_url}/training/jobs/{job_id}"
        elif status_url.startswith("/"):
            status_url = f"{remote_url}{status_url}"
        poll_interval = float(os.environ.get("MOSH_TRAINING_REMOTE_POLL_SECONDS", "2.0"))
        deadline = time.monotonic() + float(os.environ.get("MOSH_TRAINING_REMOTE_TIMEOUT_SECONDS", "7200"))
        status: dict[str, Any] = {}
        while True:
            status = _get_json(status_url)
            state = str(status.get("status", "")).lower()
            if state in {"ready", "complete", "succeeded", "success"}:
                break
            if state in {"error", "failed", "cancelled", "canceled"}:
                raise RuntimeError(status.get("error") or f"remote trainer job {job_id} ended with {state}")
            if time.monotonic() > deadline:
                raise RuntimeError(f"remote trainer job {job_id} timed out")
            time.sleep(poll_interval)

        result = _normalize_result(status.get("result"))
        out = Path(output_dir)
        artifact_payload: bytes | dict[str, Any] | None = None
        manifest_payload: bytes | dict[str, Any] | None = None

        artifact_b64 = result.get("artifact_b64") or result.get("artifactBase64")
        if isinstance(artifact_b64, str) and artifact_b64:
            artifact_payload = base64.b64decode(artifact_b64.encode("ascii"))
        elif isinstance(result.get("artifact_json"), dict):
            artifact_payload = result.get("artifact_json")
        elif isinstance(result.get("artifact"), dict):
            artifact_payload = result.get("artifact")
        elif isinstance(result.get("artifact_url"), str) and result.get("artifact_url"):
            artifact_payload = _download_bytes(str(result["artifact_url"]))

        if artifact_payload is None:
            artifact_payload = _extract_inline_json(result.get("artifact_json_str"))
        if artifact_payload is None:
            artifact_path_input = str(result.get("artifact_path", "")).strip() or str(result.get("artifactPath", "")).strip()
            if artifact_path_input:
                artifact_file = Path(artifact_path_input)
                if artifact_file.is_file():
                    try:
                        artifact_payload = artifact_file.read_bytes()
                    except Exception:
                        artifact_payload = None

        manifest_b64 = result.get("manifest_b64") or result.get("manifestBase64")
        if isinstance(manifest_b64, str) and manifest_b64:
            manifest_payload = base64.b64decode(manifest_b64.encode("ascii"))
        elif isinstance(result.get("manifest_json"), dict):
            manifest_payload = result.get("manifest_json")
        elif isinstance(result.get("manifest"), dict):
            manifest_payload = result.get("manifest")
        elif isinstance(result.get("manifest_url"), str) and result.get("manifest_url"):
            manifest_payload = _download_bytes(str(result["manifest_url"]))

        if manifest_payload is None:
            manifest_payload = _extract_inline_json(result.get("manifest_json_str"))
        if manifest_payload is None:
            manifest_path_input = str(result.get("manifest_path", "")).strip() or str(result.get("manifestPath", "")).strip()
            if manifest_path_input:
                manifest_file = Path(manifest_path_input)
                if manifest_file.is_file():
                    try:
                        manifest_payload = manifest_file.read_bytes()
                    except Exception:
                        manifest_payload = None

        if artifact_payload is None and manifest_payload is None:
            raise RuntimeError(f"remote trainer job {job_id} did not return artifact or manifest")

        artifact_path, manifest_path = _write_result_files(out, artifact_payload, manifest_payload)
        quality = result.get("quality") if isinstance(result.get("quality"), dict) else status.get("quality", {})
        adapter_id = str(result.get("adapter_id") or result.get("adapterId") or submit.get("adapter_id") or submit.get("adapterId") or artifact_path.stem)

        artifact_data = {
            "schema_version": 1,
            "adapter_id": adapter_id,
            "bundle_hash": manifest.get("bundle_hash", ""),
            "corpus_bundle": str(bundle_path),
            "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "config": config_payload,
            "quality": quality,
            "backend": "remote_http",
        }
        if artifact_payload is None:
            artifact_path.write_text(json.dumps(artifact_data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        elif isinstance(artifact_payload, bytes):
            artifact_path.write_bytes(artifact_payload)
        else:
            artifact_path.write_text(json.dumps(artifact_payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")

        manifest_data = {
            "schema_version": 1,
            "adapter_id": adapter_id,
            "bundle_hash": manifest.get("bundle_hash", ""),
            "corpus_bundle": str(bundle_path),
            "artifact_path": str(artifact_path),
            "artifact_manifest_path": str(manifest_path),
            "config": config_payload,
            "quality": quality,
            "output_format": "remote_http",
        }
        if manifest_payload is None:
            write_json(manifest_path, manifest_data)
        elif isinstance(manifest_payload, bytes):
            manifest_path.write_bytes(manifest_payload)
        else:
            write_json(manifest_path, manifest_payload)

        return {
            "ok": True,
            "adapter_id": adapter_id,
            "artifact_path": str(artifact_path),
            "manifest_path": str(manifest_path),
            "bundle_hash": manifest.get("bundle_hash", ""),
            "quality": quality,
            "backend": "remote_http",
            "remote_job_id": job_id,
        }
    finally:
        try:
            archive_path.unlink(missing_ok=True)
        except Exception:
            pass


def train(corpus_bundle: str, output_dir: str, config: dict[str, Any],
          should_cancel: Any = None, on_progress: Any = None) -> dict[str, Any]:
    mode = _backend_mode()
    if mode == "remote_http":
        return _remote_train(corpus_bundle, output_dir, config)
    if mode == "local_pmetal":
        return _local_train(corpus_bundle, output_dir, config,
                            should_cancel=should_cancel, on_progress=on_progress)
    return _fake_train(corpus_bundle, output_dir, config)


def _local_train(corpus_bundle: str, output_dir: str, config: dict[str, Any],
                 should_cancel: Any = None, on_progress: Any = None) -> dict[str, Any]:
    """A real fine-tune on this machine: precompute -> pmetal -> collect.

    Returns the same envelope shape the fake and remote paths return, so
    `server.py`'s result handling is unchanged. The distinguishing field is
    `output_format`: `"safetensors"` here versus the stub's `"json_stub"` —
    which is what the artifact-shape test keys on to prove this ran.
    """
    from . import local_pmetal as LP
    from . import recipe as R
    from . import sa3_precompute as PC

    ready, blockers = LP.readiness()
    if not ready:
        raise RuntimeError("local trainer unavailable: " + "; ".join(blockers))

    bundle_path = Path(corpus_bundle)
    manifest = _load_manifest(bundle_path)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    # ── phase 1: precompute (in-process, holds the MLX lock via the caller) ──
    clips = _clips_from_bundle(bundle_path, manifest)
    if not clips:
        raise RuntimeError("corpus bundle contains no usable clips")
    pre_dir = out / "precompute"
    pre = PC.precompute(clips, str(pre_dir), on_progress=None)
    if pre["count"] == 0:
        raise RuntimeError(f"precompute produced no samples (skipped: {pre['skipped']})")

    # ── recipe: caller's explicit steps win; otherwise the measured curve ──
    plan = R.recommend_recipe(pre["count"])
    cfg = {
        "rank": int(config.get("rank", 16)),
        "alpha": float(config.get("alpha", config.get("rank", 16))),
        "lr": float(config.get("lr", 1e-4)),
        "seed": int(config.get("seed", 42)),
        "batch_size": int(config.get("batch_size", plan["batchSize"])),
        "grad_accum": int(config.get("grad_accum", plan["gradAccum"])),
        "steps": int(config.get("steps", plan["steps"])),
        "checkpoint_every": int(config.get("checkpoint_every", max(1, plan["steps"] // 6))),
        "probe_every": int(config.get("probe_every", 100)),
        "dtype": str(config.get("dtype", "bf16")),
    }

    # ── phase 2: train ──
    run_dir = out / "run"
    run_dir.mkdir(parents=True, exist_ok=True)
    argv = LP.build_argv(LP.trainer_bin(), LP.base_dit_path(), pre["manifest_path"], str(run_dir), cfg)
    code = LP.run_training(argv, run_dir, cfg["steps"],
                           should_cancel=should_cancel, on_progress=on_progress)
    if code == 130:
        raise RuntimeError("training cancelled")
    if code != 0:
        raise RuntimeError(f"trainer exited {code} — see {run_dir / 'progress.json'} and ~/.cache/pmetal/logs/pmetal.log")

    final = run_dir / "mosh_lora.safetensors"
    if not final.is_file():
        raise RuntimeError("trainer finished but produced no adapter (missing mosh_lora.safetensors)")

    checkpoints = LP._scan_checkpoints(run_dir)
    config_payload = _config_payload({**config, **cfg, "backend": "local_pmetal"})
    adapter_id = _digest_json({"bundle_hash": manifest.get("bundle_hash"), "config": config_payload})[:16]
    quality = {
        "source_count": pre["count"],
        "steps": cfg["steps"],
        "epochs": round(cfg["steps"] * cfg["batch_size"] * cfg["grad_accum"] / max(1, pre["count"]), 1),
        "checkpoints": len(checkpoints),
        "backend": "local_pmetal",
        # NOT a quality score: the probe has repeatedly pointed the opposite way
        # from how an adapter actually sounds. Kept for diagnostics only.
        "probes": len(LP._read_probes(run_dir)),
    }
    manifest_payload = {
        "schema_version": 1,
        "adapter_id": adapter_id,
        "bundle_hash": manifest.get("bundle_hash", ""),
        "corpus_bundle": str(bundle_path),
        "artifact_path": str(final),
        "config": config_payload,
        "quality": quality,
        "output_format": "safetensors",
        "run_dir": str(run_dir),
        "checkpoints": checkpoints,
    }
    manifest_path = out / "adapter.manifest.json"
    write_json(manifest_path, manifest_payload)
    return {
        "ok": True,
        "adapter_id": adapter_id,
        "artifact_path": str(final),
        "manifest_path": str(manifest_path),
        "bundle_hash": manifest.get("bundle_hash", ""),
        "quality": quality,
        "backend": "local_pmetal",
        "output_format": "safetensors",
        "run_dir": str(run_dir),
        "checkpoints": checkpoints,
    }


def _clips_from_bundle(bundle_path: Path, manifest: dict[str, Any]) -> list[dict[str, Any]]:
    """Corpus-bundle sources -> the {id, wav, caption} triples precompute wants.

    The caption is the prompt the adapter learns to answer, so an absent one is
    a real weakness rather than a cosmetic gap — fall back through the fields
    most likely to carry human description before giving up on empty.
    """
    clips: list[dict[str, Any]] = []
    for src in manifest.get("sources", []) or []:
        rel = src.get("audio_path") or src.get("path") or src.get("file") or ""
        if not rel:
            continue
        p = Path(rel)
        if not p.is_absolute():
            p = bundle_path / rel
        clips.append({
            "id": str(src.get("id") or p.stem),
            "wav": str(p),
            "caption": str(src.get("caption") or src.get("title") or src.get("notes") or "").strip(),
        })
    return clips
