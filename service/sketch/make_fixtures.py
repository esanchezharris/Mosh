#!/usr/bin/env python3
"""Synthesise the committed Sketch test fixtures (a boom-bap + a trap-hat pattern).

These are NOT recordings — they are deterministically synthesised "beatbox" loops
(kick / snare / closed-hat one-shots placed on a known 16th grid) using only the
Python standard library, so the gated selftest (MOSH_SELFTEST_SKETCH=1) has a clean,
rights-free, byte-stable input whose ground-truth pattern is known. Each one-shot is
the same kind of sines+seeded-noise synthesis as resources/drumkits/generate_kit.py,
so the spectral classes the heuristic keys on (low kick, mid+noisy snare, high/noisy
hat) are clearly separated. Distinct onsets per step (no overlaps) keep classification
unambiguous for the proof.

Run `python3 make_fixtures.py` to (re)produce fixtures/*.wav (committed; the C++ build
and selftest never need Python — they read the committed WAVs).
"""
import math
import os
import random
import struct
import wave

SR = 44100
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures")


def _n(seconds):
    return int(seconds * SR)


def _env_exp(n, tau, attack=0.002):
    a = max(1, int(attack * SR))
    return [(i / a) if i < a else math.exp(-(i - a) / (tau * SR)) for i in range(n)]


def _noise(n, seed):
    rng = random.Random(seed)
    return [rng.uniform(-1.0, 1.0) for _ in range(n)]


def _highpass(x, alpha=0.9):
    out = [0.0] * len(x)
    px = py = 0.0
    for i, xi in enumerate(x):
        y = alpha * (py + xi - px)
        out[i] = y
        px, py = xi, y
    return out


def _peaknorm(s, peak=0.95):
    m = max((abs(v) for v in s), default=0.0)
    return [v * (peak / m) for v in s] if m > 1e-9 else s


def kick():
    n = _n(0.36)
    env = _env_exp(n, tau=0.11)
    out = []
    for i in range(n):
        t = i / SR
        phase = 2 * math.pi * (48.0 * t + (155.0 - 48.0) * 0.035 * (1 - math.exp(-t / 0.035)))
        body = math.sin(phase)
        click = math.sin(2 * math.pi * 1800 * t) * math.exp(-t / 0.004) * 0.4
        out.append((body + click) * env[i])
    return _peaknorm(out)


def snare():
    n = _n(0.22)
    et = _env_exp(n, tau=0.06)
    en = _env_exp(n, tau=0.05)
    nz = _noise(n, seed=101)
    out = []
    for i in range(n):
        t = i / SR
        tone = (math.sin(2 * math.pi * 185 * t) + 0.6 * math.sin(2 * math.pi * 278 * t)) * et[i]
        out.append(0.55 * tone + 0.85 * nz[i] * en[i])
    return _peaknorm(out)


def closed_hat():
    n = _n(0.06)
    nz = _highpass(_noise(n, seed=303), alpha=0.9)
    env = _env_exp(n, tau=0.014)
    return _peaknorm([nz[i] * env[i] for i in range(n)])


# Cached one-shots (deterministic).
ONESHOTS = {"kick": kick(), "snare": snare(), "hat": closed_hat()}
# Relative gains so velocity-from-energy yields a believable spread (kick loud → hat soft).
GAIN = {"kick": 1.0, "snare": 0.8, "hat": 0.5}


def render(bpm, bars, pattern):
    """pattern: {role: [step, ...]}. Returns a mono float buffer of the boxed loop."""
    sec_per_16th = 60.0 / bpm / 4.0
    total = _n(bars * 4 * 60.0 / bpm) + _n(0.15)   # loop + a short tail for the last ring
    buf = [0.0] * total
    for role, steps in pattern.items():
        one = ONESHOTS[role]
        g = GAIN[role]
        for s in steps:
            start = _n(s * sec_per_16th)
            for j, v in enumerate(one):
                k = start + j
                if k < total:
                    buf[k] += v * g
    return buf


def write_wav(name, buf):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        frames = bytearray()
        for s in buf:
            frames += struct.pack("<h", int(max(-1.0, min(1.0, s)) * 32767.0))
        w.writeframes(bytes(frames))
    return path, os.path.getsize(path)


FIXTURES = {
    # Boom-bap @ 90 BPM, 1 bar: kick on the downbeats, snare on the backbeats, hats on
    # the off-eighths. Distinct onsets → unambiguous 3-class ground truth.
    "boombap_90.wav": (90.0, 1, {"kick": [0, 8], "snare": [4, 12], "hat": [2, 6, 10, 14]}),
    # Trap @ 140 BPM, 1 bar: kick triplet-ish, snare on the 3, busy hats incl. a 16th roll.
    "trap_140.wav": (140.0, 1, {"kick": [0, 6, 10], "snare": [8], "hat": [2, 4, 12, 13, 14, 15]}),
}


def main():
    for name, (bpm, bars, pat) in FIXTURES.items():
        path, size = write_wav(name, render(bpm, bars, pat))
        hits = sum(len(v) for v in pat.values())
        print(f"  {name:16s} {size:7d} bytes  ({bpm:g} BPM, {bars} bar, {hits} hits)")
    print(f"wrote {len(FIXTURES)} fixtures -> {OUT}")


if __name__ == "__main__":
    main()
