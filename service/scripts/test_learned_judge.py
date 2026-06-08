#!/usr/bin/env python3
"""Validate the learned-judge integration path end to end (no Mosh app needed):
quality_readout.LearnedJudge -> spawns the producer-lab venv sidecar -> Audiobox PQ.

Run with any python that has numpy+soundfile (e.g. the ComfyUI venv); it spawns the
producer-lab venv itself. GPU-warden-wrap it (the sidecar loads Audiobox on the GPU)."""
from __future__ import annotations

import os
import sys
import tempfile

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

import quality_readout as qr  # noqa: E402


def tone(path, freq, secs=4.0, sr=44100):
    t = np.linspace(0, secs, int(sr * secs), endpoint=False)
    x = 0.2 * np.sin(2 * np.pi * freq * t).astype(np.float32)
    sf.write(path, np.stack([x, x], axis=1), sr, subtype="PCM_24")
    return path


def main():
    wav = tone(os.path.join(tempfile.gettempdir(), "mosh_judge_test.wav"), 220.0)
    fails = []

    lj = qr.LearnedJudge()
    print(f"[info] judge python: {qr._JUDGE_PYTHON}")
    print(f"[info] judge script: {qr._JUDGE_SCRIPT}")
    print(f"[chk ] available: {lj.available()}")
    if not lj.available():
        print("[FAIL] sidecar python/script not found")
        return 1

    print(f"[info] DSP pq (baseline): {qr.analyze_wav(wav)['pq']}")
    print("[info] starting sidecar (loads Audiobox; may download a ckpt on first run)...")
    ready = lj.start()
    print(f"[chk ] sidecar ready: {ready}")
    if not ready:
        fails.append("sidecar did not become ready")

    s1 = lj.score(wav)
    print(f"[chk ] learned score #1: {s1}")
    if not (s1 and "PQ" in s1):
        fails.append("no PQ in learned score")
    else:
        print(f"[ ok ] PQ={s1['PQ']:.2f} PC={s1.get('PC')} CE={s1.get('CE')} CU={s1.get('CU')}")

    # second score should reuse the loaded model (fast, no reload)
    s2 = lj.score(tone(os.path.join(tempfile.gettempdir(), "mosh_judge_test2.wav"), 440.0))
    print(f"[chk ] learned score #2 (warm reuse): {s2}")
    if not (s2 and "PQ" in s2):
        fails.append("warm reuse failed")

    lj.close()
    print(f"\n==== {'PASS' if not fails else 'FAIL'} ====")
    if fails:
        print("FAILURES: " + "; ".join(fails))
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
