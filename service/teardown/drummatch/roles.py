"""Cheap, deterministic role guesser (kick/snare/hat/clap/perc/other) for role-filtered
queries and the index manifest. Rule-based on a few robust descriptors — not a trained
model; it narrows candidates, it doesn't have to be perfect. The Recipe's `role` enum
(§0) is the controlled vocabulary; this returns a subset of it as plain strings.
"""
from __future__ import annotations

import numpy as np

# subset of recipe.Role values this heuristic emits. "808" splits off the sustained,
# pitched low end (vs the punchy short kick) — the gap that left 808s scattered across
# kick/perc/other on real libraries.
ROLE_VALUES = ("kick", "808", "snare", "hat", "clap", "perc", "other")


def classify_role(y: np.ndarray, sr: int) -> str:
    """Guess a drum role from spectral centroid, duration, ZCR and flatness."""
    import librosa

    y = np.asarray(y, dtype=np.float32)
    if y.size == 0:
        return "other"

    dur = len(y) / float(sr)
    # one-shots are often shorter than the default 2048-sample window → size n_fft to the
    # signal (power of two ≤ 2048) so short kicks/claps don't trigger librosa's pad warning
    # and the spectral stats stay meaningful.
    nfft = 2048
    if len(y) < 2048:
        nfft = max(256, 1 << int(np.floor(np.log2(max(256, len(y))))))
    centroid = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr, n_fft=nfft)))
    zcr = float(np.mean(librosa.feature.zero_crossing_rate(y)))
    flatness = float(np.mean(librosa.feature.spectral_flatness(y=y, n_fft=nfft)))

    # bright + short + buzzy → hi-hat / cymbal
    if centroid >= 6000.0 and dur <= 0.35 and zcr >= 0.10:
        return "hat"
    # low + tonal: the punchy short transient is a kick; the sustained pitched body is an
    # 808 (or sub-bass one-shot). Duration is the discriminator. Centroid/flatness bounds
    # are a touch wider than the old kick-only rule so pitched 808s (which carry harmonics
    # and a click → a slightly higher centroid) are no longer dropped to perc/other.
    if centroid <= 500.0 and flatness <= 0.18:
        return "808" if dur >= 0.45 else "kick"
    # noisy, mid-bright, medium length → snare vs clap (clap is noisier/flatter)
    if 1200.0 <= centroid <= 5500.0 and flatness >= 0.02:
        return "clap" if flatness >= 0.20 else "snare"
    # low-ish tonal but not deep enough for a kick/808 → percussion
    if centroid < 1200.0:
        return "perc"
    return "other"
