#!/usr/bin/env python3
"""Mosh generative model service (05 §4).

A separate Python process — NOT built by CMake. Local job protocol: control over
HTTP/JSON; audio over files + manifests (never giant JSON). The native Generative
Job Manager (src/generative/) spawns/detects it, does a capability handshake +
warmup, monitors heartbeat, and cancels jobs on project close.

Adapters: `fake` (stdlib stub) and `stable_audio3` (the carved MLX SA3 model — full
carve: re-imagine/generate, ASTD colour rack, init-latent cache, judge QA). One
SINGLE serialized worker owns the SA3 model (MLX is not concurrent). SA3 is
advertised only when its model is present, so FakeAdapter-only runs are unaffected.

Run:  service/run.sh         # picks the MLX venv python when MOSH_ENABLE_SA3=1
      python3 service/server.py
"""
from __future__ import annotations

import hashlib
import itertools
import json
import os
import queue
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# On Windows a JUCE GUI parent may launch this service with stdout/stderr pipes
# that are not drained. Keep service logging file-backed unless a developer asks
# for console output explicitly.
if os.name == "nt" and os.environ.get("MOSH_SERVICE_CONSOLE", "") != "1":
    try:
        import tempfile
        _logfh = open(os.path.join(tempfile.gettempdir(), "mosh-service.log"),
                      "a", buffering=1, encoding="utf-8", errors="replace")
        sys.stdout = _logfh
        sys.stderr = _logfh
    except OSError:
        pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from adapters import fake_adapter  # noqa: E402
from adapters import stable_audio3_adapter  # noqa: E402  (path-only checks; heavy imports stay lazy)

SERVICE_VERSION = "0.2.0"
START_TIME = time.time()
SA3_ENABLED = os.environ.get("MOSH_ENABLE_SA3", "1") == "1" and stable_audio3_adapter.available()


def _colorrack_hash() -> str:
    try:
        from colors import runtime as CR
        return hashlib.md5(json.dumps(CR.registry(), sort_keys=True).encode()).hexdigest()[:8]
    except Exception:  # noqa: BLE001
        return "none"


# service_build feeds the native render-cache fingerprint: changing the engine/colors
# must invalidate cached renders, so it encodes the carve identity.
if SA3_ENABLED:
    SERVICE_BUILD = (f"sa3-1.0.0+{stable_audio3_adapter.backend_name()}"
                     f"+colors{_colorrack_hash()}+sec{os.environ.get('SA3_SECONDS', '8.0')}")
else:
    SERVICE_BUILD = "fake-0.1.0"

FAKE_ADAPTER = {
    "id": "fake", "version": "0.0.1",
    "generation_modes": ["text_to_audio", "audio_to_audio"],
    "conditioning_inputs": ["prompt", "init_audio", "negative_prompt"],
    "duration_limits": {"min": 0.1, "max": 600.0},
    "sample_rates": [44100], "channel_modes": ["stereo"],
    "runtime_requirements": ["cpu"], "packaging_mode": "python_service",
    "supports_seed": True, "supports_semantic_controls": False,
    "service_build": SERVICE_BUILD,
}


def _sa3_descriptor() -> dict:
    return {
        "id": "stable_audio3", "version": "1.0.0", "available": SA3_ENABLED,
        "generation_modes": ["text_to_audio", "audio_to_audio"],
        "conditioning_inputs": ["prompt", "init_audio", "negative_prompt", "colors"],
        "duration_limits": {"min": 0.5, "max": float(os.environ.get("SA3_SECONDS", "8.0"))},
        "sample_rates": [44100], "channel_modes": ["stereo"],
        "runtime_requirements": [stable_audio3_adapter.backend_name()], "packaging_mode": "python_service",
        "supports_seed": True, "supports_semantic_controls": True,
        "semantic_controls": "colors", "service_build": SERVICE_BUILD,
    }


_jobs: dict[str, dict] = {}
_lock = threading.Lock()
_job_q: "queue.PriorityQueue" = queue.PriorityQueue()
_seq = itertools.count()


def _adapter_for(adapter_id: str):
    if adapter_id in ("stable_audio3", "sa3"):
        from adapters import stable_audio3_adapter as ad
        return ad
    return fake_adapter


def _run_job(job_id: str) -> None:
    with _lock:
        job = _jobs[job_id]
        if job.get("cancel"):
            job["status"] = "cancelled"
            return
        job["status"] = "rendering"
        adapter_id = job.get("adapter", "fake")
    try:
        if adapter_id == "fake":
            # Stepped progress for the cheap stub (debounced renders are slow IRL).
            for step in range(1, 6):
                with _lock:
                    if _jobs[job_id].get("cancel"):
                        _jobs[job_id]["status"] = "cancelled"
                        return
                    _jobs[job_id]["progress"] = step / 6.0
                time.sleep(0.05)
        else:
            with _lock:
                _jobs[job_id]["progress"] = 0.3   # coarse: real model render is one shot

        ad = _adapter_for(adapter_id)
        if (job["params"] or {}).get("mode") == "text_to_audio":
            # Pure generation — no input audio. Adapters opt in via generate().
            if not hasattr(ad, "generate"):
                raise RuntimeError(f"adapter '{adapter_id}' does not support text_to_audio")
            manifest = ad.generate(job["output_wav"], job["params"])
        else:
            manifest = ad.render(job["input_wav"], job["output_wav"], job["params"])
        with open(job["manifest"], "w") as f:
            json.dump(manifest, f)
        with _lock:
            _jobs[job_id]["progress"] = 1.0
            _jobs[job_id]["status"] = "ready"
            _jobs[job_id]["result"] = manifest
    except Exception as e:  # noqa: BLE001
        with _lock:
            _jobs[job_id]["status"] = "error"
            _jobs[job_id]["error"] = str(e)


def _worker_loop() -> None:
    """The ONE thread that ever runs an adapter — serializes inference so the
    process-global MLX model is never touched concurrently (05 §6 priority queue)."""
    while True:
        _prio, _seq_n, job_id = _job_q.get()
        try:
            _run_job(job_id)
        finally:
            _job_q.task_done()


class Handler(BaseHTTPRequestHandler):
    server_version = f"MoshService/{SERVICE_VERSION}"

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        n = int(self.headers.get("Content-Length", 0))
        if n <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        query = {}
        if "?" in self.path:
            for kv in self.path.split("?", 1)[1].split("&"):
                if "=" in kv:
                    k, v = kv.split("=", 1)
                    query[k] = v

        if path == "/health":
            adapters = ["fake"] + (["stable_audio3"] if SA3_ENABLED else [])
            self._send(200, {"ok": True, "service": "mosh-generative",
                             "version": SERVICE_VERSION, "build": SERVICE_BUILD,
                             "uptime_s": round(time.time() - START_TIME, 1),
                             "adapters": adapters})
        elif path == "/capabilities":
            adapters = [FAKE_ADAPTER] + ([_sa3_descriptor()] if SA3_ENABLED else [])
            self._send(200, {"ok": True, "adapters": adapters, "service_build": SERVICE_BUILD})
        elif path == "/colors":
            try:
                from colors import runtime as CR
                self._send(200, {"ok": True, "colors": CR.descriptor(),
                                 "lab_alpha_max": CR._meta().get("lab_alpha_max", 0.4)})
            except Exception as e:  # noqa: BLE001
                self._send(503, {"ok": False, "error": f"colors unavailable: {e}", "colors": []})
        elif path == "/status":
            jid = query.get("jobId", "")
            with _lock:
                job = _jobs.get(jid)
                if job is None:
                    self._send(404, {"ok": False, "error": "unknown jobId"})
                    return
                self._send(200, {"ok": True, "jobId": jid, "status": job["status"],
                                 "progress": job.get("progress", 0.0),
                                 "outputWav": job["output_wav"],
                                 "error": job.get("error"),
                                 "manifest": job.get("result")})
        else:
            self._send(404, {"ok": False, "error": f"unknown path: {path}"})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        data = self._read_json()
        if path == "/submit":
            adapter_id = data.get("adapter", "fake")
            if adapter_id in ("stable_audio3", "sa3") and not SA3_ENABLED:
                self._send(503, {"ok": False, "error": "stable_audio3 unavailable "
                                 "(model/venv absent or MOSH_ENABLE_SA3 not set)"})
                return
            input_wav = data.get("inputWav", "")
            output_wav = data.get("outputWav", "")
            mode = (data.get("params") or {}).get("mode", "audio_to_audio")
            # text_to_audio jobs have no input audio (latent.generate, phase0 §3.3).
            if mode != "text_to_audio" and (not input_wav or not os.path.exists(input_wav)):
                self._send(400, {"ok": False, "error": "inputWav missing"})
                return
            job_id = uuid.uuid4().hex[:12]
            with _lock:
                _jobs[job_id] = {
                    "status": "queued", "progress": 0.0, "adapter": adapter_id,
                    "input_wav": input_wav, "output_wav": output_wav,
                    "manifest": data.get("manifest", output_wav + ".manifest.json"),
                    "params": data.get("params", {}), "cancel": False,
                }
            _job_q.put((int(data.get("priority", 5)), next(_seq), job_id))
            self._send(200, {"ok": True, "jobId": job_id})
        elif path == "/cancel":
            jid = data.get("jobId", "")
            with _lock:
                if jid in _jobs:
                    _jobs[jid]["cancel"] = True
            self._send(200, {"ok": True})
        else:
            self._send(404, {"ok": False, "error": f"unknown path: {path}"})

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[service] " + (fmt % args) + "\n")


def main() -> int:
    host = os.environ.get("MOSH_SERVICE_HOST", "127.0.0.1")
    port = int(os.environ.get("MOSH_SERVICE_PORT", "8770"))
    threading.Thread(target=_worker_loop, daemon=True).start()
    if SA3_ENABLED and stable_audio3_adapter.backend_name() == "mlx":
        # Pre-load the judge model off the worker thread so the first render's QA
        # is ~1–2s, not ~25s. Background + best-effort: never blocks /health.
        from sa3 import qa  # noqa: PLC0415
        threading.Thread(target=qa.warm, daemon=True).start()
    httpd = ThreadingHTTPServer((host, port), Handler)
    mode = "FakeAdapter + StableAudio3" if SA3_ENABLED else "FakeAdapter"
    sys.stderr.write(f"[service] Mosh generative service v{SERVICE_VERSION} "
                     f"on http://{host}:{port} ({mode}) build={SERVICE_BUILD}\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
