#!/usr/bin/env python3
"""Build the FMS-Bench synthetic sanity triple for the metric-validity smoke.

reference.wav — clean 3-note sung-ish tone (A3/B3/C4) with rests (the "human vocal").
good.wav      — reference + faint −60 dB dither (a faithful, clean render; same pitch+timing).
bad.wav       — reference transposed +3 semitones, shifted +150 ms, AND −22 dB noise. A proper
                known-bad is worse on EVERY axis: wrong register (correctness) + noisy (pq).

NOTE (2026-07-17): an earlier version noised the GOOD sample (−44 dB) and left BAD a clean
transposed tone. pq (production quality) then ranked BAD above GOOD — pq doing its job on the
noise, but the fixture mislabeled good/bad on the naturalness axis. Fixed here so BAD is worse
on both axes; the correctness ruler was already validated (see the metric-validity verdict doc).

These are ARTIFACTS, not committed — they land under ~/mosh-fms-ksb/bench/sanity/ by default.
Stdlib only (wave/struct/math + a seeded LCG for reproducible noise); no numpy needed.

Usage:  bench_sanity_make.py [out_dir]
"""
import math
import os
import struct
import sys
import wave

SR = 22050
NOTES = [220.0, 246.94, 261.63]   # A3, B3, C4
NOTE_S = 0.5
REST_S = 0.25
LEAD_S = 0.2
SEMITONE = 2.0 ** (1.0 / 12.0)


def _env(i, n, fade_s=0.03):
    """Raised-cosine attack/release so pyin locks and it reads sung, not clicky."""
    f = int(fade_s * SR)
    if i < f:
        return 0.5 * (1 - math.cos(math.pi * i / f))
    if i > n - f:
        return 0.5 * (1 - math.cos(math.pi * (n - i) / f))
    return 1.0


def note(freq, dur_s=NOTE_S, amp=0.6):
    n = int(dur_s * SR)
    return [amp * _env(i, n) * math.sin(2 * math.pi * freq * i / SR) for i in range(n)]


def silence(dur_s):
    return [0.0] * int(dur_s * SR)


def sung(freqs):
    sig = silence(LEAD_S)
    for f in freqs:
        sig += note(f) + silence(REST_S)
    return sig


def lcg_noise(n, amp, seed=1234567):
    """Deterministic uniform noise in [-amp, amp] (a fixed LCG — reproducible wavs)."""
    x, out = seed, []
    for _ in range(n):
        x = (1103515245 * x + 12345) & 0x7FFFFFFF
        out.append(amp * (2.0 * (x / 0x7FFFFFFF) - 1.0))
    return out


def write_wav(path, mono):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b"".join(
            struct.pack("<h", int(max(-32767, min(32767, x * 32767)))) for x in mono))


def main():
    out = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~/mosh-fms-ksb/bench/sanity")
    os.makedirs(out, exist_ok=True)

    reference = sung(NOTES)
    write_wav(os.path.join(out, "reference.wav"), reference)

    # GOOD: a faithful clean render — faint −60 dB dither so it's distinct but pq-equivalent.
    dither = lcg_noise(len(reference), amp=0.0006, seed=99)
    good = [r + n for r, n in zip(reference, dither)]
    write_wav(os.path.join(out, "good.wav"), good)

    # BAD: worse on EVERY axis — +3 st, +150 ms, and −22 dB noise (drops production quality).
    bad = silence(0.15) + sung([f * (SEMITONE ** 3) for f in NOTES])
    bad_noise = lcg_noise(len(bad), amp=0.05, seed=7)
    bad = [b + n for b, n in zip(bad, bad_noise)]
    write_wav(os.path.join(out, "bad.wav"), bad)

    print(f"wrote reference/good/bad.wav under {out} "
          f"(ref {len(reference)/SR:.2f}s, bad {len(bad)/SR:.2f}s)")


if __name__ == "__main__":
    main()
