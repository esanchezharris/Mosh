#!/usr/bin/env python3
"""End-to-end FakeAdapter job-protocol test — no SA3/MLX, stdlib only.

Spins up the real server.py HTTP service (FakeAdapter, ephemeral port) and drives
the exact contract the native GenerativeJobManager uses: /health, POST /submit,
poll /status, read the output manifest. This is the service's CI-able smoke: it
proves submit→render→manifest works without any model, and that the FakeAdapter
transform is deterministic (same seed → identical bytes) and reports QA flags.

Run:  python3 service/scripts/fake_adapter_test.py     (exit 0 = all pass)
"""
import json
import math
import os
import struct
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import wave
from http.server import ThreadingHTTPServer

# Force FakeAdapter-only BEFORE importing the server (skips all SA3 probing).
os.environ["MOSH_ENABLE_SA3"] = "0"

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


def write_sine_wav(path, seconds=0.2, sr=44100, freq=220.0, channels=2):
    n = int(seconds * sr)
    frames = []
    for i in range(n):
        v = int(0.5 * 32767 * math.sin(2 * math.pi * freq * i / sr))
        frames.extend([v] * channels)
    body = struct.pack("<%dh" % len(frames), *frames)
    with wave.open(path, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(body)


def get_json(base, path):
    try:
        with urllib.request.urlopen(base + path, timeout=5) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:  # 4xx still carries a JSON body (e.g. 404 unknown jobId)
        return json.loads(e.read().decode())


def post_json(base, path, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(base + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read().decode())


def main():
    # ── 1. Direct adapter contract (deterministic transform + manifest) ──────────
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "input.wav")
        out_a = os.path.join(d, "out_a.wav")
        out_b = os.path.join(d, "out_b.wav")
        write_sine_wav(src)

        params = {"seed": 7, "nl": 0.4, "colors": [{"name": "grit", "value": 90}]}
        man = fake_adapter.render(src, out_a, params)
        check("adapter manifest ok", man.get("ok") is True, str(man.get("adapter")))
        check("manifest carries pq readout", isinstance(man.get("pq"), (int, float)), f"pq={man.get('pq')}")
        check("heavy_drive flag at grit=90", "heavy_drive" in man.get("flags", []), str(man.get("flags")))
        check("output wav written", os.path.exists(out_a) and os.path.getsize(out_a) > 44)

        fake_adapter.render(src, out_b, params)
        with open(out_a, "rb") as fa, open(out_b, "rb") as fb:
            check("deterministic: same seed -> identical bytes", fa.read() == fb.read())

    # ── 2. Full HTTP job protocol via the real server (submit -> status -> result) ─
    threading.Thread(target=server._worker_loop, daemon=True).start()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    try:
        health = get_json(base, "/health")
        check("/health ok, fake advertised", health.get("ok") and "fake" in health.get("adapters", []), str(health.get("adapters")))

        caps = get_json(base, "/capabilities")
        check("/capabilities lists fake adapter", any(a.get("id") == "fake" for a in caps.get("adapters", [])))

        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "input.wav")
            out = os.path.join(d, "output.wav")
            man_path = os.path.join(d, "output_manifest.json")
            write_sine_wav(src)

            submit = post_json(base, "/submit", {
                "adapter": "fake", "inputWav": src, "outputWav": out,
                "manifest": man_path, "params": {"seed": 3, "nl": 0.4},
            })
            check("/submit returns jobId", bool(submit.get("ok") and submit.get("jobId")), str(submit))
            job_id = submit.get("jobId")

            status, deadline = {}, time.time() + 10
            while time.time() < deadline:
                status = get_json(base, f"/status?jobId={job_id}")
                if status.get("status") in ("ready", "error", "cancelled"):
                    break
                time.sleep(0.05)
            check("job reaches ready", status.get("status") == "ready", str(status.get("status")))
            check("status carries manifest", isinstance(status.get("manifest"), dict) and status["manifest"].get("ok"))
            check("output + manifest files written", os.path.exists(out) and os.path.exists(man_path))
            if os.path.exists(man_path):
                with open(man_path) as f:
                    check("written manifest parses", json.load(f).get("ok") is True)

            missing = get_json(base, "/status?jobId=deadbeef")
            check("unknown jobId -> not-ok", missing.get("ok") is False)
    finally:
        httpd.shutdown()

    print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
