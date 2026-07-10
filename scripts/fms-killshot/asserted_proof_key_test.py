from __future__ import annotations

import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from asserted_proof_key import (  # noqa: E402
    estimate_key,
    hz_to_pitch_class,
    pitch_class_histogram_from_f0,
    rank_keys,
)


def _contour(hz_values: list[float]) -> list[dict]:
    return [{"t": round(index * 0.02, 4), "hz": float(hz)} for index, hz in enumerate(hz_values)]


def test_hz_to_pitch_class() -> None:
    assert hz_to_pitch_class(440.0) == 9  # A
    assert hz_to_pitch_class(261.626) == 0  # C
    assert hz_to_pitch_class(370.0) == 6  # F#


def test_histogram_counts_voiced_frames_only() -> None:
    contour = _contour([261.626, 261.626, 0.0, 440.0])
    histogram = pitch_class_histogram_from_f0(contour)
    assert histogram[0] == 2.0  # C
    assert histogram[9] == 1.0  # A
    assert sum(histogram) == 3.0


def test_c_major_melody_ranks_c_major_first() -> None:
    # Tonic/dominant-weighted diatonic melody in C: lots of C and G, scale support.
    c4, d4, e4, f4, g4, a4, b4 = 261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88
    melody = [c4] * 20 + [g4] * 12 + [e4] * 8 + [d4] * 4 + [f4] * 3 + [a4] * 3 + [b4] * 2
    result = estimate_key(pitch_class_histogram_from_f0(_contour(melody)))
    assert result["ok"] is True
    assert result["best"]["keyscale"] == "C major"
    assert result["margin"] > 0.0
    assert len(result["ranked"]) == 5


def test_a_minor_melody_ranks_a_minor_first() -> None:
    a3, b3, c4, d4, e4, f4, g4 = 220.0, 246.94, 261.63, 293.66, 329.63, 349.23, 392.0
    melody = [a3] * 20 + [e4] * 12 + [c4] * 10 + [d4] * 4 + [b3] * 3 + [f4] * 3 + [g4] * 2
    result = estimate_key(pitch_class_histogram_from_f0(_contour(melody)))
    assert result["best"]["keyscale"] == "A minor"


def test_rank_keys_covers_all_24_and_is_sorted() -> None:
    histogram = [1.0] * 12
    ranked = rank_keys(histogram)
    assert len(ranked) == 24
    assert all(ranked[i]["correlation"] >= ranked[i + 1]["correlation"] for i in range(23))
    assert {entry["mode"] for entry in ranked} == {"major", "minor"}


def test_empty_contour_is_not_ok() -> None:
    result = estimate_key(pitch_class_histogram_from_f0(_contour([0.0, 0.0])))
    assert result["ok"] is False
    assert result["best"] is None


def test_keyscale_strings_are_ace_valid_format() -> None:
    ranked = rank_keys([1.0, 0, 0, 0, 0, 0, 0, 0.8, 0, 0, 0, 0])
    for entry in ranked:
        note, mode = entry["keyscale"].rsplit(" ", 1)
        assert mode in ("major", "minor")
        assert note[0] in "ABCDEFG"
        assert len(note) == 1 or note[1] == "#"
