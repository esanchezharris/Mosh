#!/usr/bin/env python3
"""FMS-Bench mumble synthesizer: turn a CLEAR vocal into a realistic "mumble".

Two parts:
  1. WORD SELECTION (pure, stdlib, seeded-deterministic) — pick a fraction ρ of words to
     mumble, biased toward function / short / unstressed words first, because a real mumble
     keeps the stressed content words clearer. Golden-testable with no audio.
  2. DEGRADATION (lazy numpy/scipy/librosa) — the design-panel + adversarial-verify winner
     (`formant_shift`): cepstral envelope flattening + FULL excitation-phase randomization +
     a ~1750 Hz lowpass + an energy-envelope re-match, applied only inside the selected word
     spans (raised-cosine crossfade; bit-clean outside).

Why phase randomization is the lever (measured, not guessed): Whisper reads words from
phase-carried consonant/formant transitions, so scrambling phase destroys intelligibility —
while pyin/YIN F0 is autocorrelation-based (power spectrum only, phase-blind), so the pitch
survives as long as the harmonic comb is kept in the magnitude. Fresh-span measurement:
ASR conf drop ≈0.57 (degraded_conf ≈0.41), F0 median Δ ≈0.2 st (voiced_kept ≈0.95), energy
corr ≈0.98. See mumble_probe.py for the ruler.
"""
from __future__ import annotations

import math

# ── 1. word selection (pure, stdlib) ───────────────────────────────────────────────────

# Common English function words — mumbled FIRST (a real mumble keeps content words clearer).
FUNCTION_WORDS = frozenset("""
a an the and or but nor so yet for of to in on at by up out off over under
is am are was were be been being do does did have has had will would shall should
can could may might must i you he she it we they me him her us them my your his its our their
this that these those there here as if then than with from into onto about
""".split())


def _norm(word):
    return "".join(c for c in word.lower() if c.isalpha() or c == "'")


def mumble_priority(word, stress=None):
    """Higher = mumble sooner. Function words + short/unstressed words go first."""
    w = _norm(word)
    p = 0.0
    if w in FUNCTION_WORDS:
        p += 2.0
    if len(w) <= 3:
        p += 1.0
    if stress is not None and not stress:      # explicitly unstressed
        p += 1.0
    return p


def _seed_key(word, i, seed):
    """Deterministic tiebreak within a priority band (stdlib, no RNG state)."""
    h = 1469598103934665603 ^ (seed & 0xFFFFFFFFFFFFFFFF)
    for ch in f"{i}:{_norm(word)}":
        h = ((h ^ ord(ch)) * 1099511628211) & 0xFFFFFFFFFFFFFFFF
    return h


def select_mumble_words(words, ratio, seed=0):
    """Indices of the ceil(ratio*N) words to mumble, chosen by (−priority, seeded-hash) and
    returned time-sorted. Deterministic in (words, ratio, seed). ratio 0 → none, 1 → all."""
    n = len(words)
    if n == 0 or ratio <= 0.0:
        return []
    k = min(n, math.ceil(ratio * n))
    order = sorted(range(n),
                   key=lambda i: (-mumble_priority(words[i].get("word", ""), words[i].get("stress")),
                                  _seed_key(words[i].get("word", ""), i, seed)))
    return sorted(order[:k])


def spans_for(words, indices):
    """[(start_s, end_s)] for the selected word indices."""
    return [(float(words[i]["start"]), float(words[i]["end"])) for i in indices]


# ── 2. degradation (lazy numpy/scipy/librosa) ───────────────────────────────────────────

NFFT, HOP = 2048, 512
Q_LOW, Q_HIGH = 1, 40          # zero the low-quefrency formant envelope; keep gain + pitch comb
LP_HZ = 1750.0                 # plateau center of the ASR-drop sweep (1650–1850 Hz)
XFADE_MS = 10.0


def _cepstral_flatten(x, sr, phase_rand, seed):
    import numpy as np
    import librosa
    x = np.asarray(x, dtype=np.float64)
    n = len(x)
    S = librosa.stft(x, n_fft=NFFT, hop_length=HOP, window="hann", center=True)
    mag, phase = np.abs(S), np.angle(S)
    if phase_rand > 0.0:
        rng = np.random.default_rng(seed)
        phase = phase + phase_rand * rng.uniform(-np.pi, np.pi, size=phase.shape)
    logm = np.log(mag + 1e-8)
    cep = np.fft.irfft(logm, n=NFFT, axis=0)               # real, even-symmetric
    lifter = np.ones(NFFT)
    lifter[Q_LOW:Q_HIGH + 1] = 0.0
    lifter[NFFT - Q_HIGH:NFFT - Q_LOW + 1] = 0.0           # mirror half
    cep *= lifter[:, None]
    mag2 = np.exp(np.fft.rfft(cep, n=NFFT, axis=0).real)
    e_in = np.sqrt((mag ** 2).sum(axis=0) + 1e-12)
    e_out = np.sqrt((mag2 ** 2).sum(axis=0) + 1e-12)
    mag2 *= (e_in / e_out)[None, :]                        # per-frame energy renorm
    return librosa.istft(mag2 * np.exp(1j * phase), hop_length=HOP, window="hann", length=n)


def _match_envelope(clean, deg, sr, win_ms=30.0):
    import numpy as np
    w = max(1, int(sr * win_ms / 1000.0))
    k = np.ones(w) / w

    def env(x):
        return np.sqrt(np.convolve(x ** 2, k, mode="same") + 1e-12)
    return deg * np.clip(env(clean) / env(deg), 0.0, 12.0)


def degrade(mono, sr, spans, *, seed=0, phase_rand=1.0, lp_hz=LP_HZ, xfade_ms=XFADE_MS):
    """Mumble the audio ONLY inside `spans` (raised-cosine crossfade, bit-clean outside)."""
    import numpy as np
    from scipy.signal import butter, sosfiltfilt
    mono = np.asarray(mono, dtype=np.float64)
    n = len(mono)
    deg = _cepstral_flatten(mono, sr, phase_rand, seed)
    deg = sosfiltfilt(butter(6, lp_hz / (sr / 2.0), btype="low", output="sos"), deg)
    deg = _match_envelope(mono, deg, sr)

    # merge touching/overlapping spans so shared boundaries never dip to clean
    idx = sorted(((max(0, int(round(s * sr))), min(n, int(round(e * sr)))) for s, e in spans),
                 key=lambda p: p[0])
    merged = []
    for i0, i1 in idx:
        if i1 <= i0:
            continue
        if merged and i0 <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], i1)
        else:
            merged.append([i0, i1])
    mask = np.zeros(n)
    r = max(1, int(sr * xfade_ms / 1000.0))
    ramp = 0.5 * (1.0 - np.cos(np.linspace(0.0, np.pi, r)))
    for i0, i1 in merged:
        seg = np.ones(i1 - i0)
        rr = min(r, (i1 - i0) // 2)
        if rr > 0:
            seg[:rr] = ramp[:rr]
            seg[-rr:] = ramp[:rr][::-1]
        mask[i0:i1] = np.maximum(mask[i0:i1], seg)
    return mono * (1.0 - mask) + deg * mask


def mumble_wav(clean_wav, words, ratio, out_wav, *, seed=0):
    """Mumble a fraction ρ of `words` in clean_wav → out_wav. Returns the selection + spans."""
    import numpy as np
    import soundfile as sf
    idx = select_mumble_words(words, ratio, seed=seed)
    spans = spans_for(words, idx)
    y, sr = sf.read(clean_wav)
    if getattr(y, "ndim", 1) > 1:
        y = y.mean(axis=1)
    out = degrade(np.asarray(y, dtype=np.float64), sr, spans, seed=seed)
    sf.write(out_wav, out.astype(np.float32), sr)
    return {"ratio": ratio, "seed": seed, "n_words": len(words),
            "mumbled": [{"word": words[i].get("word", ""), "start": float(words[i]["start"]),
                         "end": float(words[i]["end"])} for i in idx],
            "spans": [list(s) for s in spans]}
