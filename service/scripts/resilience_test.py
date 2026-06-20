#!/usr/bin/env python3
"""Service resilience checks — adapter dest-dir creation + job cancel honoring.

In-process (no HTTP/port, stdlib only): exercises the two hardening fixes so a
regression is caught without a model or the native client.

  1. FakeAdapter.render() into a not-yet-created directory succeeds (was an
     unhandled FileNotFoundError surfaced to the client as a cryptic job error).
  2. _run_job honors a cancel that lands AT entry and IN the entry->render window
     (the latter via a monkeypatched _adapter_for that flips cancel during the
     call) — the expensive adapter.render() is skipped and no output is written.

Run:  python3 service/scripts/resilience_test.py     (exit 0 = all pass)
"""
import os
import struct
import sys
import tempfile
import wave

os.environ["MOSH_ENABLE_SA3"] = "0"  # FakeAdapter only, before importing server

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

import server  # noqa: E402
from adapters import fake_adapter  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def _write_wav(path, n_frames=2000, framerate=44100):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    body = struct.pack("<%dh" % n_frames, *([1000] * n_frames))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(framerate)
        w.writeframes(body)


with tempfile.TemporaryDirectory() as tmp:
    # ── 1. FakeAdapter renders into a fresh (nonexistent) destination dir ──
    inp = os.path.join(tmp, "in.wav")
    _write_wav(inp)
    out_fresh = os.path.join(tmp, "does", "not", "exist", "out.wav")
    check("fake render dest dir absent before render", not os.path.exists(os.path.dirname(out_fresh)))
    try:
        manifest = fake_adapter.render(inp, out_fresh, {"seed": 1, "nl": 0.4})
        rendered_ok = os.path.isfile(out_fresh) and os.path.getsize(out_fresh) > 44
    except Exception as e:  # noqa: BLE001
        rendered_ok = False
        manifest = {"error": str(e)}
    check("fake render auto-creates the dest dir and writes output", rendered_ok, str(manifest)[:120])

    # ── 2a. _run_job honors a cancel set BEFORE the worker picks the job up ──
    jid_a = "resil-cancel-entry"
    out_a = os.path.join(tmp, "a", "out.wav")
    server._jobs[jid_a] = {
        "status": "queued", "cancel": True, "adapter": "fake",
        "input_wav": inp, "output_wav": out_a,
        "manifest": os.path.join(tmp, "a", "out.manifest.json"),
        "params": {}, "progress": 0.0,
    }
    server._run_job(jid_a)
    check("cancel-at-entry -> status cancelled", server._jobs[jid_a]["status"] == "cancelled",
          server._jobs[jid_a]["status"])
    check("cancel-at-entry -> no output written", not os.path.exists(out_a))

    # ── 2b. _run_job honors a cancel that lands in the entry->render window ──
    # Simulate the race by flipping cancel=True inside _adapter_for (called after
    # the entry/progress checks, immediately before the pre-render guard).
    jid_b = "resil-cancel-prerender"
    out_b = os.path.join(tmp, "b", "out.wav")
    server._jobs[jid_b] = {
        "status": "queued", "cancel": False, "adapter": "fake",
        "input_wav": inp, "output_wav": out_b,
        "manifest": os.path.join(tmp, "b", "out.manifest.json"),
        "params": {}, "progress": 0.0,
    }
    render_called = {"v": False}

    class _StubAdapter:
        @staticmethod
        def render(i, o, p):
            render_called["v"] = True
            return {"ok": True}

    orig_adapter_for = server._adapter_for

    def _racing_adapter_for(_aid):
        with server._lock:
            server._jobs[jid_b]["cancel"] = True   # cancel arrives mid-flight
        return _StubAdapter

    server._adapter_for = _racing_adapter_for
    try:
        server._run_job(jid_b)
    finally:
        server._adapter_for = orig_adapter_for

    check("pre-render cancel -> adapter.render() not called", not render_called["v"])
    check("pre-render cancel -> status cancelled", server._jobs[jid_b]["status"] == "cancelled",
          server._jobs[jid_b]["status"])
    check("pre-render cancel -> no output written", not os.path.exists(out_b))

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failure(s)")
sys.exit(len(fails))
