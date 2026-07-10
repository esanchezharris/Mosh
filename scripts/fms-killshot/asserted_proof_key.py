"""Key estimation for the ACE cover spike.

Krumhansl-Schmuckler profile correlation over a 12-bin pitch-class
histogram. Two feeders share this scorer: the melody histogram from the
raw take's RMVPE contour (pure, here) and a librosa chroma vector from the
full-song reference (via the worker's `key` subcommand, transcribe venv).
Keyscale strings use ACE's accepted format ("C major", "F# minor").
"""

from __future__ import annotations

import math

KRUMHANSL_MAJOR = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88)
KRUMHANSL_MINOR = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)
PITCH_CLASS_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")


def hz_to_pitch_class(hz: float) -> int:
    return round(69.0 + 12.0 * math.log2(hz / 440.0)) % 12


def pitch_class_histogram_from_f0(f0_points: list[dict]) -> list[float]:
    histogram = [0.0] * 12
    for point in f0_points:
        hz = float(point.get("hz", 0.0))
        if hz > 0.0:
            histogram[hz_to_pitch_class(hz)] += 1.0
    return histogram


def _correlation(left: tuple[float, ...] | list[float], right: tuple[float, ...] | list[float]) -> float:
    size = len(left)
    mean_left, mean_right = sum(left) / size, sum(right) / size
    numerator = sum((a - mean_left) * (b - mean_right) for a, b in zip(left, right))
    denominator = math.sqrt(sum((a - mean_left) ** 2 for a in left) * sum((b - mean_right) ** 2 for b in right))
    return numerator / denominator if denominator else 0.0


def rank_keys(histogram: list[float]) -> list[dict]:
    ranked = []
    for tonic in range(12):
        rotated = [histogram[(tonic + offset) % 12] for offset in range(12)]
        for mode, profile in (("major", KRUMHANSL_MAJOR), ("minor", KRUMHANSL_MINOR)):
            ranked.append(
                {
                    "keyscale": f"{PITCH_CLASS_NAMES[tonic]} {mode}",
                    "tonicPitchClass": tonic,
                    "mode": mode,
                    "correlation": round(_correlation(profile, rotated), 4),
                }
            )
    ranked.sort(key=lambda entry: (-entry["correlation"], entry["tonicPitchClass"], entry["mode"]))
    return ranked


def estimate_key(histogram: list[float]) -> dict:
    if sum(histogram) <= 0.0:
        return {"ok": False, "best": None, "ranked": [], "margin": None}
    ranked = rank_keys(histogram)
    return {
        "ok": True,
        "best": ranked[0],
        "ranked": ranked[:5],
        "margin": round(ranked[0]["correlation"] - ranked[1]["correlation"], 4),
        "histogram": [round(value, 4) for value in histogram],
    }
