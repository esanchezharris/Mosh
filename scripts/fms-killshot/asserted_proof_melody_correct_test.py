from __future__ import annotations

import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from asserted_proof_melody_correct import (  # noqa: E402
    paste_segment,
    segment_shifts,
    syllable_targets_from_plan,
)

HOP_S = 0.02


def _plan() -> dict:
    return {
        "clip": {"start": 0.35, "end": 7.90},
        "words": [
            {"text": "yeah", "ownerId": "src-0-0", "start": 0.395, "end": 0.560, "syllables": [{"start": 0.395, "end": 0.560, "midiPitch": 48, "phones": ["Y", "AE1"]}]},
            {
                "text": "invincible",
                "ownerId": "src-6-0",
                "start": 2.401,
                "end": 3.341,
                "syllables": [
                    {"start": 2.401, "end": 2.641, "midiPitch": 58, "phones": ["IH2", "N"]},
                    {"start": 2.641, "end": 2.941, "midiPitch": 58, "phones": ["V", "IH1", "N"]},
                ],
            },
        ],
    }


def test_syllable_targets_are_clip_relative_with_midi() -> None:
    targets = syllable_targets_from_plan(_plan())
    assert len(targets) == 3
    first = targets[0]
    assert first["ownerId"] == "src-0-0-syl0"  # per-syllable ids stay unique
    assert first["startS"] == pytest.approx(0.045)
    assert first["endS"] == pytest.approx(0.21)
    assert first["targetMidi"] == 48
    assert targets[1]["startS"] == pytest.approx(2.051)


def _f0_constant(midi: float, frames: int, start_frame: int = 0) -> list[dict]:
    hz = 440.0 * (2.0 ** ((midi - 69.0) / 12.0))
    return [{"t": round((start_frame + index) * HOP_S, 4), "hz": hz} for index in range(frames)]


def test_segment_shifts_measure_median_and_clamp() -> None:
    targets = [
        {"ownerId": "a", "startS": 0.0, "endS": 0.4, "targetMidi": 60},
        {"ownerId": "b", "startS": 0.4, "endS": 0.8, "targetMidi": 60},
        {"ownerId": "c", "startS": 0.8, "endS": 1.2, "targetMidi": 60},
    ]
    # Segment a sung at 57 (needs +3), segment b unvoiced, segment c sung at 48 (needs +12 -> clamped +7).
    f0 = _f0_constant(57, 20) + [{"t": round((20 + i) * HOP_S, 4), "hz": 0.0} for i in range(20)] + _f0_constant(48, 20, start_frame=40)
    shifted = segment_shifts(targets, f0, clamp_st=7.0)
    assert shifted[0]["shiftSt"] == pytest.approx(3.0, abs=0.01)
    assert shifted[0]["measuredMidi"] == pytest.approx(57.0, abs=0.01)
    assert shifted[1]["shiftSt"] is None  # unvoiced -> untouched
    assert shifted[2]["shiftSt"] == pytest.approx(7.0)  # clamped
    assert shifted[2]["requestedShiftSt"] == pytest.approx(12.0, abs=0.01)


def test_paste_segment_replaces_span_with_fades() -> None:
    base = [1000] * 1000
    segment = [-2000] * 400
    out = paste_segment(base, segment, start_index=300, fade_frames=10)
    assert out[:295] == [1000] * 295  # before untouched
    assert out[720:] == [1000] * 280  # after untouched
    assert out[500] == -2000  # middle replaced
    assert -2000 < out[302] < 1000  # fade-in blends
    assert -2000 < out[698] < 1000  # fade-out blends
    assert len(out) == 1000


def test_paste_segment_length_mismatch_raises() -> None:
    with pytest.raises(RuntimeError, match="segment"):
        paste_segment([0] * 100, [0] * 50, start_index=80, fade_frames=4)
