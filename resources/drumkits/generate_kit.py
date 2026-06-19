#!/usr/bin/env python3
"""Generate the bundled default drum kit ("mosh-kit").

The eight one-shots are SYNTHESISED from scratch (sines + seeded noise +
envelopes) using only the Python standard library — no samples are copied from
anywhere, so the kit is rights-clean and the build needs no third-party audio.
This mirrors how service/adapters/fake_adapter.py manufactures recognisable
audio with stdlib `wave`.

Each pad is mapped (by mosh's native sampler) to the GM percussion pitch the UI
drum sequencer uses (ui/src/ui/drumGrid.ts → DRUM_LANES):

    kick 36 · snare 38 · clap 39 · closed-hat 42 · open-hat 46 ·
    low-tom 45 · mid-tom 47 · crash 49

Run `python3 generate_kit.py` to (re)produce mosh-kit/*.wav. The outputs are
committed so the app build (and `Mosh --selftest`) never depends on Python.
Deterministic: every pad seeds its own RNG, so regenerating is byte-stable.
"""

import math
import os
import random
import struct
import wave

SR = 44100
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "mosh-kit")


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


def _n(seconds):
    return int(seconds * SR)


def _env_exp(n, tau, attack=0.002):
    """Fast linear attack then exponential decay."""
    a = max(1, int(attack * SR))
    out = []
    for i in range(n):
        amp = (i / a) if i < a else math.exp(-(i - a) / (tau * SR))
        out.append(amp)
    return out


def _noise(n, seed):
    rng = random.Random(seed)
    return [rng.uniform(-1.0, 1.0) for _ in range(n)]


def _highpass(x, alpha=0.85):
    """One-pole high-pass (difference-ish) — brightens noise into a hat/cymbal."""
    out = [0.0] * len(x)
    prev_x = 0.0
    prev_y = 0.0
    for i, xi in enumerate(x):
        y = alpha * (prev_y + xi - prev_x)
        out[i] = y
        prev_x = xi
        prev_y = y
    return out


def kick():
    n = _n(0.36)
    env = _env_exp(n, tau=0.11)
    out = []
    for i in range(n):
        t = i / SR
        # pitch glide 155 Hz -> 48 Hz
        f = 48.0 + (155.0 - 48.0) * math.exp(-t / 0.035)
        phase = 2 * math.pi * (48.0 * t + (155.0 - 48.0) * 0.035 * (1 - math.exp(-t / 0.035)))
        body = math.sin(phase)
        click = math.sin(2 * math.pi * 1800 * t) * math.exp(-t / 0.004) * 0.4
        out.append((body + click) * env[i])
    return out


def snare():
    n = _n(0.22)
    env_t = _env_exp(n, tau=0.06)
    env_n = _env_exp(n, tau=0.05)
    nz = _noise(n, seed=101)
    out = []
    for i in range(n):
        t = i / SR
        tone = (math.sin(2 * math.pi * 185 * t) + 0.6 * math.sin(2 * math.pi * 278 * t)) * env_t[i]
        noise = nz[i] * env_n[i]
        out.append(0.55 * tone + 0.85 * noise)
    return out


def clap():
    n = _n(0.22)
    nz = _highpass(_noise(n, seed=202), alpha=0.7)
    out = [0.0] * n
    # three quick bursts then a softer tail
    bursts = [0.0, 0.009, 0.018]
    for b in bursts:
        start = _n(b)
        env = _env_exp(n - start, tau=0.012)
        for j, e in enumerate(env):
            out[start + j] += nz[start + j] * e
    tail_start = _n(0.026)
    tenv = _env_exp(n - tail_start, tau=0.07)
    for j, e in enumerate(tenv):
        out[tail_start + j] += nz[tail_start + j] * e * 0.6
    return out


def closed_hat():
    n = _n(0.06)
    nz = _highpass(_noise(n, seed=303), alpha=0.9)
    env = _env_exp(n, tau=0.014)
    return [nz[i] * env[i] for i in range(n)]


def open_hat():
    n = _n(0.34)
    nz = _highpass(_noise(n, seed=404), alpha=0.9)
    env = _env_exp(n, tau=0.13)
    return [nz[i] * env[i] for i in range(n)]


def tom(freq0, freq1, length, seed):
    n = _n(length)
    env = _env_exp(n, tau=length * 0.45)
    out = []
    for i in range(n):
        t = i / SR
        f = freq1 + (freq0 - freq1) * math.exp(-t / (length * 0.3))
        out.append(math.sin(2 * math.pi * f * t) * env[i])
    return out


def crash():
    n = _n(1.1)
    nz = _highpass(_noise(n, seed=505), alpha=0.92)
    env = _env_exp(n, tau=0.5, attack=0.001)
    out = []
    for i in range(n):
        t = i / SR
        shimmer = (math.sin(2 * math.pi * 5200 * t) + math.sin(2 * math.pi * 7300 * t)) * 0.15
        out.append((nz[i] + shimmer) * env[i])
    return out


PADS = {
    "kick.wav": kick,
    "snare.wav": snare,
    "clap.wav": clap,
    "hat_closed.wav": closed_hat,
    "hat_open.wav": open_hat,
    "tom_low.wav": lambda: tom(120, 82, 0.40, seed=606),
    "tom_mid.wav": lambda: tom(165, 120, 0.34, seed=707),
    "crash.wav": crash,
}


def main():
    for name, fn in PADS.items():
        path = _write(name, fn())
        size = os.path.getsize(path)
        print(f"  {name:16s} {size:6d} bytes")
    print(f"wrote {len(PADS)} pads -> {OUT}")


if __name__ == "__main__":
    main()
