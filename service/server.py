#!/usr/bin/env python3
"""Mosh generative model service — Stage-0 health stub.

A SEPARATE process from the C++ DAW. The C++ app's "Generative Job Manager"
spawns this process and talks to it over a local HTTP + file/manifest protocol.

For Stage 0 this only needs to answer a health check. The heavy generative
work (StableAudio3 / MLX) lands much later and stays external/optional.

ZERO external dependencies by design: standard library only (http.server, json,
argparse). This guarantees the stub + future FakeAdapter run anywhere/CI without
the heavy SA3/MLX stack. See README.md for the rationale.

Adapter selection is module-level (`ADAPTER`) so concrete adapters can be plugged
in later without touching the HTTP layer.
"""

import argparse
import json
import signal
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from adapters import FakeAdapter

SERVICE_NAME = "mosh-generative"
VERSION = "0.0.0"

# Module-level adapter selection. Stage 0 ships the dependency-free FakeAdapter.
# Later stages swap in StableAudio3Adapter (MLX, Apple Silicon only) behind the
# same interface — the HTTP layer below should not need to change.
ADAPTER = FakeAdapter()


def _log(message: str) -> None:
    """Write a single clean line to stderr (stdout stays clear for protocol use)."""
    print(message, file=sys.stderr, flush=True)


class MoshServiceHandler(BaseHTTPRequestHandler):
    """Routes the minimal Stage-0 surface. Adapters answer the capability queries."""

    # Silence the default noisy per-request stderr format; we log our own lines.
    def log_message(self, fmt, *args):  # noqa: N802 (stdlib signature)
        _log("[%s] %s" % (self.address_string(), fmt % args))

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 (stdlib signature)
        # Strip any query string; we only key off the path for Stage 0.
        path = self.path.split("?", 1)[0].rstrip("/") or "/"

        if path == "/health":
            caps = ADAPTER.health()
            self._send_json(
                200,
                {
                    "ok": True,
                    "service": SERVICE_NAME,
                    "version": VERSION,
                    "adapter": ADAPTER.name,
                    "capabilities": caps,
                },
            )
            return

        if path == "/capabilities":
            self._send_json(200, {"capabilities": ADAPTER.health()})
            return

        self._send_json(404, {"ok": False, "error_code": "NOT_FOUND"})


def _make_server(host: str, port: int) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), MoshServiceHandler)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="mosh-generative",
        description="Mosh generative model service (Stage-0 health stub).",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Bind address (default: 127.0.0.1).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8765,
        help="Bind port (default: 8765).",
    )
    args = parser.parse_args(argv)

    server = _make_server(args.host, args.port)

    def _shutdown(_signum, _frame):
        _log("Received shutdown signal; stopping...")
        # shutdown() must run off the serve_forever thread; signal handler is fine
        # here because serve_forever blocks the main thread below.
        raise KeyboardInterrupt

    # SIGINT (Ctrl-C) is the primary stop path; SIGTERM when the C++ host kills us.
    signal.signal(signal.SIGINT, _shutdown)
    try:
        signal.signal(signal.SIGTERM, _shutdown)
    except (AttributeError, ValueError):
        # SIGTERM may be unavailable on some Windows configurations; ignore.
        pass

    _log(
        "%s v%s (adapter=%s) listening on http://%s:%d"
        % (SERVICE_NAME, VERSION, ADAPTER.name, args.host, args.port)
    )
    _log("Endpoints: GET /health, GET /capabilities")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
        _log("Stopped cleanly.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
