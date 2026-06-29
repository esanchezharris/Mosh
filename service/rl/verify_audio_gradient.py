#!/usr/bin/env python3
"""Smoke gate: does the GRPO loop get a REAL, non-degenerate audio-reward gradient?

Parses a `grpo.py --smoke` stderr log + its audio work dir and asserts the gate that proves
seeding renderable rollouts worked. THE gate is (1) reward μ > 0 AND (2) signal > 0 — grpo.py
zeros a group's advantage when reward std < 1e-6, so signal=0 (all-uniform groups, even with
μ>0) means NO gradient. We also confirm renders happened and the non-silent floor holds.

  verify_audio_gradient.py --log grpo.smoke.log --work <grpo --out>/_work/audio

Exit 0 = gate PASS, 1 = gate FAIL, 2 = could not evaluate (no steps parsed).

Determinism note: same-program→same-reward determinism is proven directly (PCM-identical renders;
see the Step-2 seed proof) and corroborated here by any score_audio_cli cache-hits (the cache
returns the identical reward for a repeated program fingerprint).
"""
from __future__ import annotations

import argparse
import glob
import os
import re
import sys

STEP_RE = re.compile(r"reward μ=([\d.]+)\s+def=([\d.]+)\s+signal=(\d+)/(\d+)")
SCORE_RE = re.compile(r"(\d+)\s+rendered,\s+(\d+)\s+cache-hit,\s+(\d+)\s+render-fail")
ACT_RE = re.compile(r"ACTIVATED composite reward")


def read_rms(path: str):
    """Mono RMS + peak of a WAV. Prefer soundfile (handles 16/24/32-bit + float, the bit
    depths Mosh exports); fall back to stdlib wave for 8/16-bit only."""
    try:
        import numpy as np
        import soundfile as sf
        y, _ = sf.read(path, dtype="float32", always_2d=True)
        if y.size == 0:
            return 0.0, 0.0
        y = y.mean(axis=1)
        return float(np.sqrt(np.mean(y ** 2))), float(np.max(np.abs(y)))
    except Exception:
        pass
    import wave
    import struct
    try:
        with wave.open(path, "rb") as w:
            n, sw, ch = w.getnframes(), w.getsampwidth(), w.getnchannels()
            raw = w.readframes(n)
        if n == 0 or sw != 2:
            return 0.0, 0.0
        cnt = len(raw) // 2
        vals = struct.unpack("<%dh" % cnt, raw[: cnt * 2])
        if ch > 1:
            vals = vals[::ch]  # left channel is a fine proxy for non-silence
        if not vals:
            return 0.0, 0.0
        peak = max(abs(v) for v in vals) / 32768.0
        rms = (sum(v * v for v in vals) / len(vals)) ** 0.5 / 32768.0
        return rms, peak
    except Exception:
        return 0.0, 0.0


def main() -> int:
    ap = argparse.ArgumentParser(description="GRPO audio-gradient smoke gate")
    ap.add_argument("--log", required=True, help="grpo.py --smoke stderr log")
    ap.add_argument("--work", default="", help="audio work dir (<grpo --out>/_work/audio) for WAV floor check")
    a = ap.parse_args()

    text = open(a.log, errors="replace").read() if os.path.exists(a.log) else ""
    steps = [(float(m[0]), float(m[1]), int(m[2]), int(m[3])) for m in STEP_RE.findall(text)]
    scores = [(int(m[0]), int(m[1]), int(m[2])) for m in SCORE_RE.findall(text)]
    activated = bool(ACT_RE.search(text))

    if not steps:
        print("  ✖ no step lines parsed from the log — grpo did not complete a step", file=sys.stderr)
        return 2

    max_mu = max(s[0] for s in steps)
    max_signal = max(s[2] for s in steps)
    rendered = sum(s[0] for s in scores)
    cache_hits = sum(s[1] for s in scores)
    fails = sum(s[2] for s in scores)

    # non-silent floor: ≥1 rendered WAV with rms>1e-3, peak<0.999
    floor_ok, floor_detail = None, "no work dir given"
    if a.work and os.path.isdir(a.work):
        wavs = sorted(glob.glob(os.path.join(a.work, "*.wav")))
        nons = [(os.path.basename(p), *read_rms(p)) for p in wavs]
        good = [t for t in nons if t[1] > 1e-3 and t[2] < 0.999]
        floor_ok = len(good) > 0
        floor_detail = f"{len(good)}/{len(wavs)} WAVs non-silent" + (f" (e.g. {good[0][0]} rms={good[0][1]:.4f})" if good else "")

    print("── GRPO audio-gradient smoke gate ──")
    print(f"  reward = {'composite (REAL, has_pull)' if activated else 'FLOOR-ONLY (composite head NOT activated)'}")
    print(f"  steps parsed: {len(steps)}  | per-step (μ, def, signal/G):")
    for i, (mu, df, sig, g) in enumerate(steps, 1):
        print(f"    step {i}: μ={mu:.3f} def={df:.2f} signal={sig}/{g}")
    print(f"  renders: {rendered} rendered, {cache_hits} cache-hit, {fails} render-fail")
    print(f"  floor: {floor_detail}")

    # ── the gate ─────────────────────────────────────────────────────────────────────────
    g1 = max_mu > 0.0
    g2 = max_signal >= 1
    g3 = (rendered + cache_hits) > 0
    print("\n  GATE:")
    print(f"    [{'PASS' if g1 else 'FAIL'}] (1) reward μ > 0           (max μ = {max_mu:.3f})")
    print(f"    [{'PASS' if g2 else 'FAIL'}] (2) signal > 0 (gradient)  (max signal = {max_signal})")
    print(f"    [{'PASS' if g3 else 'FAIL'}] (3) renders happened       (rendered+cache = {rendered + cache_hits}, fails = {fails})")
    if floor_ok is not None:
        print(f"    [{'PASS' if floor_ok else 'WARN'}] (4) non-silent floor       ({floor_detail})")
    if not activated:
        print("    ⚠ composite head NOT activated → this is a FLOOR-ONLY mechanics smoke, NOT the real reward.")

    gate = g1 and g2 and g3
    print(f"\n  → GATE {'PASS — real, non-degenerate gradient' if gate else 'FAIL'}")
    return 0 if gate else 1


if __name__ == "__main__":
    raise SystemExit(main())
