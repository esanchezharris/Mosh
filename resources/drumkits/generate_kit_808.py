#!/usr/bin/env python3
"""Generate the second bundled kit, "mosh-808".

Same rules as generate_kit.py: every pad is SYNTHESISED from scratch with only the
standard library, so the kit is rights-clean and the build depends on no third-party
audio. Deterministic — each pad seeds its own RNG, so regenerating is byte-stable.

It exists so the kit picker has something to pick BETWEEN. A one-entry list is a picker
that cannot be wrong, and a `list_drum_kits` test against it could not tell a working
enumeration from a hardcoded constant.

The voicing is deliberately different from mosh-kit rather than a re-tuning of it: a long
sine-body 808 kick, a short noisy snare, tight metallic hats. Same eight GM pitches, same
filenames, so it drops into the same loader with no special-casing.

Run `python3 generate_kit_808.py` to (re)produce mosh-808/*.wav. Outputs are committed so
the app build and `Mosh --selftest` never depend on Python.
"""

import math
import os
import random
import struct
import wave

SR = 44100
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "mosh-808")


def _n(seconds):
    return int(seconds * SR)


def _normalize(samples, peak=0.89):
    m = max((abs(s) for s in samples), default=0.0)
    if m <= 1e-9:
        return samples
    g = peak / m
    return [s * g for s in samples]


def _write(name, samples):
    samples = _normalize(samples)
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        frames = bytearray()
        for s in samples:
            v = int(max(-1.0, min(1.0, s)) * 32767.0)
            frames += struct.pack("<h", v)
        w.writeframes(bytes(frames))
    return path


def _env(n, tau, attack=0.002):
    a = max(1, int(attack * SR))
    out = []
    for i in range(n):
        rise = min(1.0, i / a)
        out.append(rise * math.exp(-i / (tau * SR)))
    return out


def _noise(n, seed):
    rng = random.Random(seed)
    return [rng.uniform(-1.0, 1.0) for _ in range(n)]


def _bandpass(x, lo=0.55, hi=0.92):
    """One-pole high-pass into a one-pole low-pass — enough to colour noise."""
    hp, prev_x, prev_y = [], 0.0, 0.0
    for s in x:
        y = hi * (prev_y + s - prev_x)
        hp.append(y)
        prev_x, prev_y = s, y
    lp, y = [], 0.0
    for s in hp:
        y += lo * (s - y)
        lp.append(y)
    return lp


def kick():
    # The 808 signature: a long sine whose pitch drops fast, then sustains.
    n = _n(0.90)
    env = _env(n, 0.28, attack=0.001)
    out, phase = [], 0.0
    for i in range(n):
        t = i / SR
        f = 52.0 + 95.0 * math.exp(-t / 0.030)   # snappy pitch drop into a deep body
        phase += 2 * math.pi * f / SR
        out.append(math.sin(phase) * env[i])
    click = _noise(_n(0.004), 11)
    for i, c in enumerate(click):
        out[i] += c * 0.25 * (1 - i / len(click))
    return out


def snare():
    n = _n(0.22)
    env = _env(n, 0.055)
    body_env = _env(n, 0.030)
    noise = _bandpass(_noise(n, 22))
    out, p1, p2 = [], 0.0, 0.0
    for i in range(n):
        p1 += 2 * math.pi * 186.0 / SR
        p2 += 2 * math.pi * 331.0 / SR
        tone = (math.sin(p1) * 0.6 + math.sin(p2) * 0.4) * body_env[i]
        out.append(tone * 0.45 + noise[i] * env[i] * 0.85)
    return out


def clap():
    # Three fast bursts then a tail — the classic stacked-hands illusion.
    n = _n(0.30)
    out = [0.0] * n
    for k, delay in enumerate((0.0, 0.011, 0.023)):
        start = _n(delay)
        burst = _bandpass(_noise(_n(0.045), 33 + k), lo=0.62, hi=0.94)
        env = _env(len(burst), 0.012, attack=0.0006)
        for i, s in enumerate(burst):
            if start + i < n:
                out[start + i] += s * env[i] * 0.8
    tail = _bandpass(_noise(n, 99), lo=0.5, hi=0.9)
    tenv = _env(n, 0.070, attack=0.030)
    for i in range(n):
        out[i] += tail[i] * tenv[i] * 0.35
    return out


def _hat(seconds, tau, seed):
    # Metallic: a stack of inharmonic squares, high-passed hard.
    n = _n(seconds)
    env = _env(n, tau, attack=0.0004)
    ratios = (2.0, 3.02, 4.17, 5.43, 6.79, 8.21)
    out = []
    for i in range(n):
        t = i / SR
        v = 0.0
        for r in ratios:
            v += 1.0 if math.sin(2 * math.pi * 317.0 * r * t) >= 0 else -1.0
        out.append(v / len(ratios) * env[i])
    noise = _noise(n, seed)
    for i in range(n):
        out[i] = out[i] * 0.75 + noise[i] * env[i] * 0.25
    return _bandpass(out, lo=0.92, hi=0.97)


def closed_hat():
    return _hat(0.055, 0.013, 44)


def open_hat():
    return _hat(0.42, 0.13, 55)


def tom(f0, f1, length, seed):
    n = _n(length)
    env = _env(n, length * 0.32)
    out, phase = [], 0.0
    for i in range(n):
        t = i / SR
        f = f1 + (f0 - f1) * math.exp(-t / (length * 0.20))
        phase += 2 * math.pi * f / SR
        out.append(math.sin(phase) * env[i])
    noise = _noise(_n(0.005), seed)
    for i, s in enumerate(noise):
        out[i] += s * 0.18 * (1 - i / len(noise))
    return out


def crash():
    n = _n(1.30)
    env = _env(n, 0.42, attack=0.001)
    ratios = (1.0, 1.71, 2.39, 3.14, 4.03, 5.11, 6.42, 7.77)
    out = []
    for i in range(n):
        t = i / SR
        v = 0.0
        for r in ratios:
            v += math.sin(2 * math.pi * 402.0 * r * t)
        out.append(v / len(ratios) * env[i])
    noise = _noise(n, 77)
    for i in range(n):
        out[i] = out[i] * 0.55 + noise[i] * env[i] * 0.45
    return _bandpass(out, lo=0.88, hi=0.96)


PADS = {
    "kick.wav": kick,
    "snare.wav": snare,
    "clap.wav": clap,
    "hat_closed.wav": closed_hat,
    "hat_open.wav": open_hat,
    "tom_low.wav": lambda: tom(150, 68, 0.46, seed=606),
    "tom_mid.wav": lambda: tom(205, 96, 0.38, seed=707),
    "crash.wav": crash,
}


def main():
    for name, fn in PADS.items():
        path = _write(name, fn())
        print(f"  {name:16s} {os.path.getsize(path):6d} bytes")
    print(f"wrote {len(PADS)} pads -> {OUT}")


if __name__ == "__main__":
    main()
