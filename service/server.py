#!/usr/bin/env python3
"""Mosh generative model service (05 §4).

A separate Python process — NOT built by CMake. Local job protocol: control over
HTTP/JSON; audio over files + manifests (never giant JSON). The native Generative
Job Manager (src/generative/) spawns/detects it, does a capability handshake +
warmup, monitors heartbeat, and cancels jobs on project close.

Stage 5 (FakeAdapter): submit_job / get_job_status / progress / cancel +
capabilities/health. The StableAudio3Adapter swaps in later behind the same API
(external deps via env vars; not built here). Dependency-free (stdlib only).

Run:  python3 service/server.py        # 127.0.0.1:8770
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from adapters import fake_adapter  # noqa: E402

SERVICE_VERSION = "0.1.0"
SERVICE_BUILD = "fake-0.1.0"
START_TIME = time.time()

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

_jobs: dict[str, dict] = {}
_lock = threading.Lock()


def _run_job(job_id: str) -> None:
    with _lock:
        job = _jobs[job_id]
        job["status"] = "rendering"
    try:
        # Simulate render time with progress (debounced renders are slow IRL).
        for step in range(1, 6):
            with _lock:
                if _jobs[job_id].get("cancel"):
                    _jobs[job_id]["status"] = "cancelled"
                    return
                _jobs[job_id]["progress"] = step / 6.0
            time.sleep(0.05)

        manifest = fake_adapter.render(job["input_wav"], job["output_wav"], job["params"])
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
            self._send(200, {"ok": True, "service": "mosh-generative",
                             "version": SERVICE_VERSION, "build": SERVICE_BUILD,
                             "uptime_s": round(time.time() - START_TIME, 1),
                             "adapters": ["fake"]})
        elif path == "/capabilities":
            self._send(200, {"ok": True, "adapters": [FAKE_ADAPTER], "service_build": SERVICE_BUILD})
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
                                 "manifest": job.get("result")})
        else:
            self._send(404, {"ok": False, "error": f"unknown path: {path}"})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        data = self._read_json()
        if path == "/submit":
            input_wav = data.get("inputWav", "")
            output_wav = data.get("outputWav", "")
            if not input_wav or not os.path.exists(input_wav):
                self._send(400, {"ok": False, "error": "inputWav missing"})
                return
            job_id = uuid.uuid4().hex[:12]
            with _lock:
                _jobs[job_id] = {
                    "status": "queued", "progress": 0.0,
                    "input_wav": input_wav, "output_wav": output_wav,
                    "manifest": data.get("manifest", output_wav + ".manifest.json"),
                    "params": data.get("params", {}), "cancel": False,
                }
            threading.Thread(target=_run_job, args=(job_id,), daemon=True).start()
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
    httpd = ThreadingHTTPServer((host, port), Handler)
    sys.stderr.write(f"[service] Mosh generative service v{SERVICE_VERSION} "
                     f"on http://{host}:{port} (FakeAdapter)\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
