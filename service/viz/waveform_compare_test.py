#!/usr/bin/env python3
"""Golden tests for the waveform_compare pure numeric core (peaks, mel, envelope, corr,
click detection). Deterministic (3x identical digest). Run under a numpy venv:
  ~/Library/Mosh/venvs/teardown/bin/python service/viz/waveform_compare_test.py
"""
import hashlib
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import waveform_compare as wc  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# ── peak_buckets ────────────────────────────────────────────────────────────────────────
y = np.linspace(-1.0, 1.0, 1000)
mins, maxs = wc.peak_buckets(y, 10)
check("peak_buckets width", len(mins) == 10 and len(maxs) == 10)
check("peak_buckets monotone ramp: first bucket min<max, last>first",
      mins[0] < maxs[0] and maxs[-1] > maxs[0], f"{maxs[0]:.3f} {maxs[-1]:.3f}")
check("peak_buckets covers the full range", abs(maxs[-1] - 1.0) < 0.05 and abs(mins[0] + 1.0) < 0.05)
check("peak_buckets empty -> zeros", wc.peak_buckets(np.array([]), 5)[0].tolist() == [0] * 5)
m2, x2 = wc.peak_buckets(y, 10)
check("peak_buckets deterministic", np.array_equal(mins, m2) and np.array_equal(maxs, x2))

# ── mel filterbank + mel_db ─────────────────────────────────────────────────────────────
fb = wc._mel_filterbank(wc.SR, wc.N_FFT, wc.N_MELS, wc.FMIN, wc.FMAX)
check("filterbank shape", fb.shape == (wc.N_MELS, wc.N_FFT // 2 + 1), str(fb.shape))
check("filterbank non-negative", float(fb.min()) >= 0.0)
check("filterbank each mel has energy", bool(np.all(fb.sum(axis=1) > 0)))

# a 440 Hz tone should light up a low-ish mel bin more than a high one
t = np.arange(int(wc.SR * 0.5)) / wc.SR
tone = np.sin(2 * np.pi * 440 * t)
mel = wc.mel_db(tone)
check("mel_db shape [n_mels, T]", mel.shape[0] == wc.N_MELS and mel.shape[1] > 1, str(mel.shape))
peak_bin_440 = int(np.argmax(mel.mean(axis=1)))
tone2 = np.sin(2 * np.pi * 4000 * t)
peak_bin_4k = int(np.argmax(wc.mel_db(tone2).mean(axis=1)))
check("mel_db localizes pitch (440Hz bin < 4kHz bin)", peak_bin_440 < peak_bin_4k,
      f"{peak_bin_440} vs {peak_bin_4k}")
check("mel_db deterministic", np.array_equal(wc.mel_db(tone), mel))

# ── rms_envelope + env_corr ─────────────────────────────────────────────────────────────
env = wc.rms_envelope(tone, wc.SR, hop_ms=10.0)
check("rms_envelope length ~ dur/hop", abs(len(env) - 50) <= 1, str(len(env)))
check("env_corr identity == 1.0", abs(wc.env_corr(tone, tone, wc.SR) - 1.0) < 1e-9)
# an amplitude-modulated tone vs its inverse-modulated twin -> negative env corr
ramp = np.linspace(0.05, 1.0, len(t))
a = tone * ramp
b = tone * ramp[::-1]
check("env_corr anti-correlated < 0", wc.env_corr(a, b, wc.SR) < 0, str(wc.env_corr(a, b, wc.SR)))

# ── click_spikes ────────────────────────────────────────────────────────────────────────
clean = 0.3 * np.sin(2 * np.pi * 200 * t)
check("no clicks in a clean tone", wc.click_spikes(clean, wc.SR, thresh=0.15) == [])
clicked = clean.copy()
clicked[int(wc.SR * 0.25)] += 0.8            # inject a 1-sample discontinuity at 0.25s
sp = wc.click_spikes(clicked, wc.SR, thresh=0.15)
check("detects an injected click near 0.25s", any(abs(s - 0.25) < 0.01 for s in sp), str(sp))
check("click_spikes deterministic", wc.click_spikes(clicked, wc.SR, thresh=0.15) == sp)

# ── determinism (3x) ────────────────────────────────────────────────────────────────────
def digest():
    payload = {
        "peaks": [round(float(v), 6) for v in wc.peak_buckets(y, 8)[1]],
        "mel_mean": [round(float(v), 4) for v in wc.mel_db(tone).mean(axis=1)[:8]],
        "env": round(wc.env_corr(a, b, wc.SR), 6),
        "clicks": wc.click_spikes(clicked, wc.SR, thresh=0.15),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


d = {digest() for _ in range(3)}
check("3x deterministic", len(d) == 1, str(d))

if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print("\nOK: 0 failure(s)")
