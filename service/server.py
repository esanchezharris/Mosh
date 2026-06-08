#!/usr/bin/env python3
"""Mosh generative model service — health stub + FakeAdapter job protocol.

A SEPARATE process from the C++ DAW. The C++ app's "Generative Job Manager"
spawns this process and talks to it over a local HTTP + file/manifest protocol.

The service answers a health check and runs the generative **job protocol**:
submit a render job, poll its status/progress, and cancel it. Audio is handed
back over **files + manifests** (a WAV plus a sidecar manifest JSON), never inline
in the HTTP body. The heavy generative work (StableAudio3 / MLX) lands much later
behind the same interface and stays external/optional — this stage ships the
deterministic FakeAdapter so the orchestration is proven before SA3 exists.

ZERO external dependencies by design: standard library only (http.server, json,
threading, uuid, argparse + the adapter's wave/struct/math). This guarantees the
stub + FakeAdapter run anywhere/CI without the heavy SA3/MLX stack. See README.md.

Adapter selection is module-level (`ADAPTER`) so concrete adapters can be plugged
in later without touching the HTTP layer.
"""

import argparse
import json
import os
import signal
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from adapters import load_adapter

SERVICE_NAME = "mosh-generative"
VERSION = "0.0.0"

# When spawned by the C++ host (a GUI app), our stdout/stderr handles may be invalid
# or an undrained pipe — and torch/Stable-Audio-3 log heavily, which would error or
# block. Redirect both to a log file BEFORE importing any heavy adapter. Standalone:
# set MOSH_SERVICE_CONSOLE=1 to keep console output. The log path is printed nowhere
# (no console), so: %TEMP%\mosh-service.log.
if os.environ.get("MOSH_SERVICE_CONSOLE", "") != "1":
    try:
        import tempfile
        _logfh = open(os.path.join(tempfile.gettempdir(), "mosh-service.log"),
                      "a", buffering=1, encoding="utf-8", errors="replace")
        sys.stdout = _logfh
        sys.stderr = _logfh
    except OSError:
        pass

# Adapter selection via env (MOSH_ADAPTER), default the dependency-free FakeAdapter.
# The real CUDA StableAudio3Adapter is selected with MOSH_ADAPTER=stable_audio_3 and
# is imported lazily (load_adapter) so the Fake/CI path never pulls in torch. The
# HTTP layer below is model-agnostic and does not change between adapters.
ADAPTER = load_adapter(os.environ.get("MOSH_ADAPTER", "fake"))

# In-memory job store, owned by the JobManager below. Jobs do not survive a
# restart — the C++ host treats this process as disposable and re-submits.
JOBS = None  # set in main() once the adapter/store are ready


def _log(message: str) -> None:
    """Write a single clean line to stderr (stdout stays clear for protocol use)."""
    print(message, file=sys.stderr, flush=True)


class JobManager:
    """In-memory job store + background render worker for the FakeAdapter.

    Each submitted job runs on its own daemon thread (so a long render never blocks
    the HTTP server's accept loop). State is guarded by a single lock; the public
    methods are the only things the HTTP layer touches.

    Job records are plain dicts with: ``jobId``, ``status``
    (``queued``/``running``/``done``/``error``/``canceled``), ``progress``
    (0.0..1.0), and once finished either ``manifest`` or ``error``. A per-job
    ``_cancel`` event is the cooperative cancellation channel — the adapter polls it
    via the ``is_canceled`` callback and aborts cleanly.
    """

    def __init__(self, adapter):
        self._adapter = adapter
        self._lock = threading.Lock()
        self._jobs = {}
        self._cancels = {}
        self._threads = {}

    def submit(self, request: dict) -> dict:
        """Register a job and start its render thread. Returns the queued record."""
        job_id = request.get("jobId") or uuid.uuid4().hex
        request["jobId"] = job_id

        with self._lock:
            self._jobs[job_id] = {
                "jobId": job_id,
                "status": "queued",
                "progress": 0.0,
            }
            cancel = threading.Event()
            self._cancels[job_id] = cancel

        thread = threading.Thread(
            target=self._run,
            args=(request, cancel),
            name="mosh-job-%s" % job_id[:8],
            daemon=True,
        )
        with self._lock:
            self._threads[job_id] = thread
        thread.start()

        return {"jobId": job_id, "status": "queued"}

    def get(self, job_id: str):
        """Return a copy of the job record, or ``None`` if there is no such job."""
        with self._lock:
            record = self._jobs.get(job_id)
            return dict(record) if record is not None else None

    def cancel(self, job_id: str) -> bool:
        """Request cooperative cancellation. Returns False if there's no such job.

        A queued/running job is flipped to ``canceled`` and its cancel event is set;
        the worker observes the event and stops producing. A job that has already
        finished (``done``/``error``) keeps its terminal status — cancel is a no-op
        beyond confirming the job exists.
        """
        with self._lock:
            record = self._jobs.get(job_id)
            if record is None:
                return False
            cancel = self._cancels.get(job_id)
            if cancel is not None:
                cancel.set()
            if record["status"] in ("queued", "running"):
                record["status"] = "canceled"
        return True

    def _run(self, request: dict, cancel: threading.Event) -> None:
        """Worker body: drive the adapter render, recording status/progress/result."""
        job_id = request["jobId"]

        # Honour a cancel that arrived between submit() and thread start-up.
        if cancel.is_set():
            self._set(job_id, status="canceled")
            return

        self._set(job_id, status="running")

        def on_progress(pct: float) -> None:
            # Don't overwrite a terminal status (e.g. a late cancel) with progress.
            with self._lock:
                record = self._jobs.get(job_id)
                if record is not None and record["status"] == "running":
                    record["progress"] = max(0.0, min(1.0, float(pct)))

        try:
            manifest = self._adapter.render(request, on_progress, cancel.is_set)
        except Exception as exc:  # noqa: BLE001 — surface any adapter failure as job error
            _log("[job %s] render failed: %r" % (job_id, exc))
            self._set(job_id, status="error", error=str(exc))
            return

        if manifest is None:
            # Adapter aborted because it was canceled mid-render.
            self._set(job_id, status="canceled")
            return

        self._set(job_id, status="done", progress=1.0, manifest=manifest)

    def _set(self, job_id: str, **fields) -> None:
        """Atomically merge ``fields`` into a job record if it still exists."""
        with self._lock:
            record = self._jobs.get(job_id)
            if record is not None:
                record.update(fields)


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

    def _read_json_body(self):
        """Read and parse the request body as JSON. Returns ``{}`` when empty.

        Raises ``ValueError`` on malformed JSON so callers can return a 400.
        """
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    @staticmethod
    def _job_id_from_path(path: str):
        """Extract ``<jobId>`` from ``/jobs/<jobId>``; ``None`` if not that shape."""
        parts = path.split("/")
        # ["", "jobs", "<jobId>"] for a well-formed single-segment job path.
        if len(parts) == 3 and parts[1] == "jobs" and parts[2]:
            return parts[2]
        return None

    def do_GET(self):  # noqa: N802 (stdlib signature)
        # Strip any query string; we only key off the path.
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

        # The Color Rack descriptor: each color's ASTD ceiling + metadata so the UI can
        # clamp its 0–100 sliders (05 §6). Adapters without semantic colors return [].
        if path == "/colors":
            colors = ADAPTER.colors() if hasattr(ADAPTER, "colors") else []
            self._send_json(200, {"colors": colors})
            return

        job_id = self._job_id_from_path(path)
        if job_id is not None:
            record = JOBS.get(job_id)
            if record is None:
                self._send_json(404, {"ok": False, "error_code": "NO_SUCH_JOB"})
                return
            payload = {
                "ok": True,
                "jobId": record["jobId"],
                "status": record["status"],
                "progress": record.get("progress", 0.0),
            }
            if "manifest" in record:
                payload["manifest"] = record["manifest"]
            if "error" in record:
                payload["error"] = record["error"]
            self._send_json(200, payload)
            return

        self._send_json(404, {"ok": False, "error_code": "NOT_FOUND"})

    def do_POST(self):  # noqa: N802 (stdlib signature)
        path = self.path.split("?", 1)[0].rstrip("/") or "/"

        if path == "/jobs":
            try:
                body = self._read_json_body()
            except ValueError:
                self._send_json(
                    400, {"ok": False, "error_code": "BAD_JSON"}
                )
                return

            missing = [k for k in ("mode", "prompt", "cacheKey", "outDir") if k not in body]
            if missing:
                self._send_json(
                    400,
                    {
                        "ok": False,
                        "error_code": "BAD_REQUEST",
                        "error": "missing fields: %s" % ", ".join(missing),
                    },
                )
                return

            result = JOBS.submit(body)
            self._send_json(
                200,
                {"ok": True, "jobId": result["jobId"], "status": result["status"]},
            )
            return

        self._send_json(404, {"ok": False, "error_code": "NOT_FOUND"})

    def do_DELETE(self):  # noqa: N802 (stdlib signature)
        path = self.path.split("?", 1)[0].rstrip("/") or "/"

        job_id = self._job_id_from_path(path)
        if job_id is not None:
            if JOBS.cancel(job_id):
                self._send_json(200, {"ok": True, "status": "canceled"})
            else:
                self._send_json(404, {"ok": False, "error_code": "NO_SUCH_JOB"})
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

    global JOBS
    JOBS = JobManager(ADAPTER)

    # Preload heavy models in the background (the SA3 weights are ~9 GB and slow to
    # load from an HDD) so the first render isn't a multi-minute stall. Best-effort.
    if hasattr(ADAPTER, "warmup"):
        threading.Thread(target=ADAPTER.warmup, name="mosh-warmup", daemon=True).start()

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
    _log(
        "Endpoints: GET /health, GET /capabilities, "
        "POST /jobs, GET /jobs/<id>, DELETE /jobs/<id>"
    )
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
