"""Judge-panel QA (05 §7) — attach a production-quality readout to a render's
manifest. Audiobox `PQ` for the output (`pq`) and the source (`pq_base`).

The Audiobox model takes ~25s to load, so we DON'T reload it per render. Instead a
long-lived **judge sidecar** (`judge_sidecar.py`, under the judges venv) loads the
model ONCE and answers PQ requests over a pipe — QA then costs ~1–2s per render. The
single server worker calls this serially, so the sidecar is never hit concurrently.

Best-effort + crash/timeout-guarded: a missing venv, a load timeout, or a sidecar
crash NEVER fails the render — it just sets `flags=["qa_unavailable"]` and (on the
next call) respawns the sidecar.
"""
from __future__ import annotations

import atexit
import json
import os
import queue
import subprocess
import threading
import time

JUDGES_PY = os.environ.get(
    "MOSH_JUDGES_PY", os.path.expanduser("~/AI/judges_venv/bin/python"))
SIDECAR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "judge_sidecar.py")
QA_TIMEOUT_S = float(os.environ.get("MOSH_QA_TIMEOUT", "90"))         # per request
WARMUP_TIMEOUT_S = float(os.environ.get("MOSH_QA_WARMUP_TIMEOUT", "180"))  # model load
MARK = "@@MOSH@@"

_lock = threading.Lock()      # serialize access to the one sidecar
_proc: "subprocess.Popen | None" = None
_q: "queue.Queue | None" = None


def _drain(stream, q: "queue.Queue") -> None:
    """Pump the sidecar's stdout onto a queue so reads can be deadline-bounded
    (avoids blocking forever if the judge wedges). `None` marks EOF."""
    try:
        for line in stream:
            q.put(line)
    except (ValueError, OSError):
        pass
    finally:
        q.put(None)


def _read_marked(q: "queue.Queue", timeout: float):
    """Return the JSON payload of the next `@@MOSH@@`-marked line, or None on
    timeout / EOF. Non-marked lines (stray library noise) are skipped."""
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        try:
            line = q.get(timeout=remaining)
        except queue.Empty:
            return None
        if line is None:                       # sidecar died
            return None
        line = line.strip()
        if line.startswith(MARK):
            try:
                return json.loads(line[len(MARK):])
            except (ValueError, json.JSONDecodeError):
                return None


def _kill(proc) -> None:
    try:
        proc.kill()
    except OSError:
        pass


def _reset() -> None:
    global _proc, _q
    if _proc is not None:
        _kill(_proc)
    _proc = None
    _q = None


def _spawn():
    """Start the sidecar and block on its ready handshake (the one-time model load).
    Returns (proc, queue) or None if the venv/sidecar is absent or load failed."""
    if not os.path.exists(JUDGES_PY) or not os.path.exists(SIDECAR):
        return None
    try:
        proc = subprocess.Popen(
            [JUDGES_PY, SIDECAR],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1)
    except OSError:
        return None
    q: "queue.Queue" = queue.Queue()
    threading.Thread(target=_drain, args=(proc.stdout, q), daemon=True).start()
    ready = _read_marked(q, WARMUP_TIMEOUT_S)
    if not ready or not ready.get("ready"):
        _kill(proc)
        return None
    return proc, q


def _pq(paths):
    """PQ scores via the persistent sidecar. One respawn retry on a dead/wedged
    sidecar; any unrecoverable failure returns None (→ qa_unavailable)."""
    global _proc, _q
    paths = [p for p in paths if p and os.path.exists(p)]
    if not paths:
        return None
    with _lock:
        for _attempt in range(2):                # spawn (or respawn) + one retry
            if _proc is None or _proc.poll() is not None:
                spawned = _spawn()
                if spawned is None:
                    return None
                _proc, _q = spawned
            try:
                _proc.stdin.write(json.dumps({"paths": paths}) + "\n")
                _proc.stdin.flush()
            except (BrokenPipeError, OSError):
                _reset()
                continue
            resp = _read_marked(_q, QA_TIMEOUT_S)
            if resp is None:                     # timeout or crash → drop + retry once
                _reset()
                continue
            if "error" in resp:
                return None
            return resp
        return None


def warm() -> bool:
    """Pre-load the judge model (spawn the sidecar) so the first render's QA is fast.
    Safe to call at boot; a no-op when QA is disabled or the venv is absent."""
    if os.environ.get("MOSH_SA3_QA", "1") != "1":
        return False
    global _proc, _q
    with _lock:
        if _proc is not None and _proc.poll() is None:
            return True
        spawned = _spawn()
        if spawned is None:
            return False
        _proc, _q = spawned
        return True


@atexit.register
def _shutdown() -> None:
    _reset()


def augment_manifest(manifest: dict, output_wav: str, source_wav=None) -> None:
    if os.environ.get("MOSH_SA3_QA", "1") != "1":          # QA opt-out (fast renders)
        manifest.setdefault("flags", []).append("qa_disabled")
        return
    scores = _pq([output_wav, source_wav] if source_wav else [output_wav])
    if not scores:
        manifest.setdefault("flags", []).append("qa_unavailable")
        return
    if output_wav in scores:
        manifest["pq"] = round(scores[output_wav], 3)
    if source_wav and source_wav in scores:
        manifest["pq_base"] = round(scores[source_wav], 3)
        if manifest.get("pq") is not None and manifest["pq_base"] - manifest["pq"] > 0.5:
            manifest.setdefault("flags", []).append("quality_degraded")
