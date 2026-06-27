"""Cheap, deterministic role guesser (kick/snare/hat/clap/perc/other) for role-filtered
queries and the index manifest. Rule-based on a few robust descriptors — not a trained
model; it narrows candidates, it doesn't have to be perfect. The Recipe's `role` enum
(§0) is the controlled vocabulary; this returns a subset of it as plain strings.
"""
from __future__ import annotations

import numpy as np

# subset of recipe.Role values this heuristic emits
ROLE_VALUES = ("kick", "snare", "hat", "clap", "perc", "other")


def classify_role(y: np.ndarray, sr: int) -> str:
    """Guess a drum role from spectral centroid, duration, ZCR and flatness."""
    import librosa

    y = np.asarray(y, dtype=np.float32)
    if y.size == 0:
        return "other"

    dur = len(y) / float(sr)
    centroid = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
    zcr = float(np.mean(librosa.feature.zero_crossing_rate(y)))
    flatness = float(np.mean(librosa.feature.spectral_flatness(y=y)))

    # bright + short + buzzy → hi-hat / cymbal
    if centroid >= 6000.0 and dur <= 0.35 and zcr >= 0.10:
        return "hat"
    # very low, tonal → kick
    if centroid <= 350.0 and flatness <= 0.10:
        return "kick"
    # noisy, mid-bright, medium length → snare vs clap (clap is noisier/flatter)
    if 1200.0 <= centroid <= 5500.0 and flatness >= 0.02:
        return "clap" if flatness >= 0.20 else "snare"
    # low-ish tonal but not deep enough for a kick → percussion
    if centroid < 1200.0:
        return "perc"
    return "other"
