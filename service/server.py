#!/usr/bin/env python3
"""Mosh generative model service (05 §4).

A separate Python process — NOT built by CMake. It exposes a local job protocol
(control over HTTP/JSON; audio over files + manifests). The native Generative Job
Manager (src/generative/) spawns/detects it, does a capability handshake + warmup,
monitors heartbeat, and cancels jobs on project close.

Stage 0: only `/health` and `/capabilities` (FakeAdapter), proving the stub
answers a health check. Stage 5 fills in submit_job / get_job_status / progress /
cancel against the GenerativeModelAdapter interface — FakeAdapter first, then the
StableAudio3Adapter (carved research; external deps stay external).

Dependency-free (stdlib only) so it runs with no pip install. Run:
    python3 service/server.py            # default 127.0.0.1:8770
    MOSH_SERVICE_PORT=8771 python3 service/server.py
"""
from __future__ import annotations

import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SERVICE_VERSION = "0.0.1"
START_TIME = time.time()

# The FakeAdapter capability descriptor (05 §2). The real adapters
# (StableAudio3Adapter, ...) register their own descriptors in Stage 5.
FAKE_ADAPTER = {
    "id": "fake",
    "version": "0.0.1",
    "generation_modes": ["text_to_audio", "audio_to_audio"],
    "conditioning_inputs": ["prompt", "init_audio", "negative_prompt"],
    "duration_limits": {"min": 0.1, "max": 600.0},
    "sample_rates": [44100],
    "channel_modes": ["stereo"],
    "runtime_requirements": ["cpu"],
    "packaging_mode": "python_service",
    "supports_seed": True,
    "supports_semantic_controls": False,
    "license_meta": "n/a (deterministic stub)",
}


class Handler(BaseHTTPRequestHandler):
    server_version = f"MoshService/{SERVICE_VERSION}"

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path == "/health":
            self._send(200, {
                "ok": True,
                "service": "mosh-generative",
                "version": SERVICE_VERSION,
                "uptime_s": round(time.time() - START_TIME, 1),
                "adapters": ["fake"],
            })
        elif path == "/capabilities":
            self._send(200, {"ok": True, "adapters": [FAKE_ADAPTER]})
        else:
            self._send(404, {"ok": False, "error": f"unknown path: {path}"})

    def do_POST(self) -> None:  # noqa: N802
        # Stage 5: submit_job / cancel_job / pause_queue / resume_queue land here.
        self._send(501, {"ok": False, "error": "job protocol not implemented (Stage 5)"})

    def log_message(self, fmt: str, *args) -> None:  # quieter logs
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
        sys.stderr.write("[service] shutting down\n")
        httpd.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
