from __future__ import annotations

import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from asserted_proof_cover_metrics import (  # noqa: E402
    THRESHOLDS,
    attack_errors_from_alignment,
    compare_f0_contours,
    effective_status,
    evaluate_candidate,
    hz_to_semitones,
    ranking_key,
)

HOP_S = 0.02


def _contour(hz_values: list[float]) -> list[dict]:
    return [{"t": round(index * HOP_S, 4), "hz": float(hz)} for index, hz in enumerate(hz_values)]


def _sweep(frames: int, base_hz: float = 220.0, semitone_offset: float = 0.0) -> list[float]:
    # A slowly rising contour so correlation is well-defined (non-constant).
    return [base_hz * (2.0 ** ((index / frames * 5.0 + semitone_offset) / 12.0)) for index in range(frames)]


def test_hz_to_semitones_is_midi_domain() -> None:
    assert hz_to_semitones(440.0) == pytest.approx(69.0)
    assert hz_to_semitones(220.0) == pytest.approx(57.0)


def test_constant_register_offset_is_measured_not_corrected() -> None:
    raw = _contour(_sweep(100))
    cand = _contour(_sweep(100, semitone_offset=3.0))
    result = compare_f0_contours(raw, cand)
    assert result["voicedOverlap"] == pytest.approx(1.0)
    assert result["voicedIntersectionFrames"] == 100
    assert result["registerOffsetSemitones"] == pytest.approx(3.0, abs=1e-6)
    assert result["medianAbsPitchErrorSemitones"] == pytest.approx(3.0, abs=1e-6)
    assert result["medianAbsPitchErrorAfterOffsetSemitones"] == pytest.approx(0.0, abs=1e-6)
    assert result["contourCorrelation"] > 0.999
    assert result["longestOctaveErrorMs"] == 0.0


def test_fully_unvoiced_candidate_yields_none_fields_not_zeros() -> None:
    raw = _contour(_sweep(100))
    cand = _contour([0.0] * 100)
    result = compare_f0_contours(raw, cand)
    assert result["voicedRatioCand"] == 0.0
    assert result["voicedOverlap"] == 0.0
    assert result["voicedIntersectionFrames"] == 0
    assert result["contourCorrelation"] is None
    assert result["registerOffsetSemitones"] is None
    assert result["medianAbsPitchErrorSemitones"] is None
    assert result["p95AbsPitchErrorSemitones"] is None
    assert result["longestOctaveErrorMs"] is None


def test_octave_error_run_measures_contiguous_frames_and_breaks_on_unvoiced() -> None:
    frames = 100
    raw_values = _sweep(frames)
    cand_values = list(raw_values)
    for index in range(10, 20):  # 10 frames = 200 ms, +12 st
        cand_values[index] = raw_values[index] * 2.0
    result = compare_f0_contours(_contour(raw_values), _contour(cand_values))
    assert result["longestOctaveErrorMs"] == pytest.approx(200.0)

    # An unvoiced frame in the middle of the run breaks contiguity.
    cand_values[15] = 0.0
    result = compare_f0_contours(_contour(raw_values), _contour(cand_values))
    assert result["longestOctaveErrorMs"] == pytest.approx(100.0)  # frames 10-14 = 5 frames... run of 5 = 100ms


def test_small_intersection_disables_correlation_only() -> None:
    raw = _contour(_sweep(10))
    cand = _contour(_sweep(10, semitone_offset=1.0))
    result = compare_f0_contours(raw, cand)
    assert result["voicedIntersectionFrames"] == 10
    assert result["contourCorrelation"] is None  # < 25 frames
    assert result["registerOffsetSemitones"] == pytest.approx(1.0, abs=1e-6)


def _plan(word_starts: list[float], clip_start: float = 0.35) -> dict:
    words = [
        {"text": f"word{index}", "ownerId": f"src-{index}-0", "start": clip_start + start, "end": clip_start + start + 0.1}
        for index, start in enumerate(word_starts)
    ]
    return {"clip": {"start": clip_start, "end": clip_start + 7.55}, "words": words}


def test_attack_errors_use_alignment_word_starts() -> None:
    starts = [0.1 * index for index in range(16)]
    plan = _plan(starts)
    aligned = [{"word": f"word{index}", "start": starts[index] + 0.05, "end": starts[index] + 0.1, "score": 0.9} for index in range(16)]
    result = attack_errors_from_alignment(plan, aligned)
    assert result["usableWords"] == 16
    assert result["medianAttackErrorMs"] == pytest.approx(50.0)
    assert result["p95AttackErrorMs"] == pytest.approx(50.0)
    assert all(entry["used"] for entry in result["words"])


def test_attack_errors_exclude_low_alignment_scores() -> None:
    starts = [0.1 * index for index in range(16)]
    plan = _plan(starts)
    aligned = [
        {"word": f"word{index}", "start": starts[index] + (0.02 if index < 12 else 0.5), "end": starts[index] + 0.6, "score": 0.9 if index < 12 else 0.05}
        for index in range(16)
    ]
    result = attack_errors_from_alignment(plan, aligned)
    assert result["usableWords"] == 12
    assert result["medianAttackErrorMs"] == pytest.approx(20.0)


def test_attack_errors_need_at_least_eight_usable_words() -> None:
    starts = [0.1 * index for index in range(16)]
    plan = _plan(starts)
    aligned = [{"word": f"word{index}", "start": starts[index], "end": starts[index] + 0.1, "score": 0.9 if index < 7 else 0.01} for index in range(16)]
    result = attack_errors_from_alignment(plan, aligned)
    assert result["usableWords"] == 7
    assert result["medianAttackErrorMs"] is None
    assert result["p95AttackErrorMs"] is None


def test_attack_errors_with_failed_alignment_is_none() -> None:
    plan = _plan([0.1 * index for index in range(16)])
    result = attack_errors_from_alignment(plan, None)
    assert result["usableWords"] == 0
    assert result["medianAttackErrorMs"] is None


def _passing_inputs() -> dict:
    frames = 378  # 7.55s @ 20ms
    raw = _contour(_sweep(frames))
    cand = _contour(_sweep(frames, semitone_offset=0.5))
    starts = [0.45 * index for index in range(16)]
    plan = _plan(starts)
    aligned = [{"word": f"word{index}", "start": starts[index] + 0.03, "end": starts[index] + 0.1, "score": 0.9} for index in range(16)]
    lexical = {"hits": 16, "nearMisses": 0, "substitutions": 0, "misses": 0, "insertions": 0, "lexicalScore": 1.0, "sequenceRatio": 1.0, "perWord": []}
    return {
        "candidate_id": "seed7",
        "plan": plan,
        "lexical": lexical,
        "contour": compare_f0_contours(raw, cand),
        "attack": attack_errors_from_alignment(plan, aligned),
        "audio_metrics": {"envelopeCorrelation": 0.8, "rmsRatio": 1.0, "silenceBleedMs": 40.0, "medianAttackErrorMs": 33.0, "p95AttackErrorMs": 60.0, "medianVoicedPitchErrorSemitones": 0.6, "longestOctaveErrorMs": 0.0},
        "duration_s": 7.55,
    }


def test_evaluate_candidate_shortlists_when_all_gates_pass() -> None:
    evaluation = evaluate_candidate(**_passing_inputs())
    assert evaluation["autoStatus"] == "shortlisted"
    assert evaluation["invalidReasons"] == []
    assert evaluation["shortlistFailures"] == []
    assert all(evaluation["gates"].values())


def test_evaluate_candidate_single_gate_failure_is_diagnostic() -> None:
    inputs = _passing_inputs()
    inputs["audio_metrics"]["silenceBleedMs"] = 140.0
    evaluation = evaluate_candidate(**inputs)
    assert evaluation["autoStatus"] == "diagnostic"
    assert evaluation["shortlistFailures"] == ["silenceBleed"]


def test_evaluate_candidate_duration_mismatch_is_invalid() -> None:
    inputs = _passing_inputs()
    inputs["duration_s"] = 10.0
    evaluation = evaluate_candidate(**inputs)
    assert evaluation["autoStatus"] == "invalid"
    assert any("duration" in reason for reason in evaluation["invalidReasons"])


def test_evaluate_candidate_unvoiced_is_invalid() -> None:
    inputs = _passing_inputs()
    frames = 378
    inputs["contour"] = compare_f0_contours(_contour(_sweep(frames)), _contour([0.0] * frames))
    evaluation = evaluate_candidate(**inputs)
    assert evaluation["autoStatus"] == "invalid"


def test_ranking_is_lexical_first_and_deterministic() -> None:
    best = evaluate_candidate(**_passing_inputs())
    seed42_inputs = _passing_inputs()
    seed42_inputs["candidate_id"] = "seed42"
    seed42_inputs["lexical"] = {"hits": 10, "nearMisses": 2, "substitutions": 3, "misses": 1, "insertions": 1, "lexicalScore": 0.6875, "sequenceRatio": 0.625, "perWord": []}
    middle = evaluate_candidate(**seed42_inputs)
    worst_inputs = _passing_inputs()
    worst_inputs["candidate_id"] = "seed911"
    worst_inputs["lexical"] = {"hits": 0, "nearMisses": 0, "substitutions": 0, "misses": 16, "insertions": 0, "lexicalScore": 0.0, "sequenceRatio": 0.0, "perWord": []}
    worst = evaluate_candidate(**worst_inputs)
    invalid_inputs = _passing_inputs()
    invalid_inputs["candidate_id"] = "seed271"
    invalid_inputs["duration_s"] = 10.0
    invalid = evaluate_candidate(**invalid_inputs)

    ordered = sorted([worst, invalid, middle, best], key=ranking_key)
    assert [entry["candidateId"] for entry in ordered] == ["seed7", "seed42", "seed911", "seed271"]

    tie_a = evaluate_candidate(**{**_passing_inputs(), "candidate_id": "seed-a"})
    tie_b = evaluate_candidate(**{**_passing_inputs(), "candidate_id": "seed-b"})
    assert sorted([tie_b, tie_a], key=ranking_key)[0]["candidateId"] == "seed-a"


def test_effective_status_owner_overlay() -> None:
    evaluation = evaluate_candidate(**_passing_inputs())
    current = "a" * 64
    assert effective_status(evaluation, None, current) == "shortlisted"
    assert effective_status(evaluation, {"verdict": "pass", "manifestSha256": current}, current) == "owner_pass"
    assert effective_status(evaluation, {"verdict": "fail", "manifestSha256": current}, current) == "owner_fail"
    assert effective_status(evaluation, {"verdict": "close but revise", "manifestSha256": current}, current) == "shortlisted"
    assert effective_status(evaluation, {"verdict": "pass", "manifestSha256": "b" * 64}, current) == "shortlisted"


def test_thresholds_are_the_documented_gross_limits() -> None:
    assert THRESHOLDS["medianAttackErrorMs"] == 80.0
    assert THRESHOLDS["p95AttackErrorMs"] == 150.0
    assert THRESHOLDS["silenceBleedMs"] == 100.0
    assert THRESHOLDS["medianAbsPitchErrorSemitones"] == 1.5
    assert THRESHOLDS["longestOctaveErrorMs"] == 100.0
    assert THRESHOLDS["voicedOverlap"] == 0.6
    assert THRESHOLDS["octaveBandSemitones"] == 11.5
