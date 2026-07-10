"""Frame-level contour + alignment-attack diagnostics for ACE cover candidates.

Contours are compared plain time-aligned (frame i vs frame i) — NO DTW,
because timing fidelity is itself under test; a time-shifted candidate must
score badly. Gates shortlist candidates for the owner's ear; no combination
of them can produce a pass.
"""

from __future__ import annotations

import math
from statistics import median

from asserted_proof_cover_lexical import lexical_shortlist_ok
from asserted_proof_metrics import _percentile, correlation

THRESHOLDS: dict = {
    "medianAttackErrorMs": 80.0,
    "p95AttackErrorMs": 150.0,
    "silenceBleedMs": 100.0,
    "medianAbsPitchErrorSemitones": 1.5,
    "longestOctaveErrorMs": 100.0,
    "voicedOverlap": 0.6,
    "octaveBandSemitones": 11.5,
    "minAlignScore": 0.2,
    "minUsableWords": 8,
    "minCorrelationFrames": 25,
    "durationToleranceS": 0.25,
    "minVoicedRatio": 0.05,
    "lexicalMinHits": 10,
    "lexicalMaxSubstitutions": 2,
}

_INF = float("inf")


def hz_to_semitones(hz: float) -> float:
    return 69.0 + 12.0 * math.log2(hz / 440.0)


def compare_f0_contours(raw_f0: list[dict], cand_f0: list[dict], *, hop_s: float = 0.02, octave_band_st: float = 11.5) -> dict:
    size = min(len(raw_f0), len(cand_f0))
    raw_hz = [float(point["hz"]) for point in raw_f0[:size]]
    cand_hz = [float(point["hz"]) for point in cand_f0[:size]]
    raw_voiced = [hz > 0.0 for hz in raw_hz]
    cand_voiced = [hz > 0.0 for hz in cand_hz]
    raw_voiced_count = sum(raw_voiced)
    both = [raw_voiced[index] and cand_voiced[index] for index in range(size)]
    intersection = sum(both)
    result = {
        "frames": size,
        "hopS": hop_s,
        "voicedRatioRaw": round(raw_voiced_count / size, 4) if size else 0.0,
        "voicedRatioCand": round(sum(cand_voiced) / size, 4) if size else 0.0,
        "voicedOverlap": round(intersection / raw_voiced_count, 4) if raw_voiced_count else 0.0,
        "voicedIntersectionFrames": intersection,
        "contourCorrelation": None,
        "registerOffsetSemitones": None,
        "medianAbsPitchErrorSemitones": None,
        "p95AbsPitchErrorSemitones": None,
        "medianAbsPitchErrorAfterOffsetSemitones": None,
        "longestOctaveErrorMs": None,
    }
    if intersection == 0:
        return result
    raw_st = [hz_to_semitones(raw_hz[index]) if both[index] else None for index in range(size)]
    cand_st = [hz_to_semitones(cand_hz[index]) if both[index] else None for index in range(size)]
    deltas = [cand_st[index] - raw_st[index] for index in range(size) if both[index]]
    abs_errors = [abs(delta) for delta in deltas]
    offset = median(deltas)
    result["registerOffsetSemitones"] = round(offset, 4)
    result["medianAbsPitchErrorSemitones"] = round(median(abs_errors), 4)
    result["p95AbsPitchErrorSemitones"] = round(_percentile(abs_errors, 0.95), 4)
    result["medianAbsPitchErrorAfterOffsetSemitones"] = round(median(abs(delta - offset) for delta in deltas), 4)
    if intersection >= THRESHOLDS["minCorrelationFrames"]:
        result["contourCorrelation"] = round(
            correlation(
                [raw_st[index] for index in range(size) if both[index]],
                [cand_st[index] for index in range(size) if both[index]],
            ),
            4,
        )
    longest = run = 0
    for index in range(size):
        # Any frame outside the voiced intersection breaks the run (conservative).
        if both[index] and abs(cand_st[index] - raw_st[index]) >= octave_band_st:
            run += 1
            longest = max(longest, run)
        else:
            run = 0
    result["longestOctaveErrorMs"] = round(longest * hop_s * 1000.0, 2)
    return result


def attack_errors_from_alignment(plan: dict, aligned: list[dict] | None, *, min_align_score: float = 0.2) -> dict:
    clip_start = float(plan["clip"]["start"])
    words: list[dict] = []
    errors: list[float] = []
    if aligned is not None and len(aligned) == len(plan["words"]):
        for word, entry in zip(plan["words"], aligned):
            expected_start = float(word["start"]) - clip_start
            aligned_start = float(entry["start"])
            score = float(entry.get("score", 0.0))
            used = score >= min_align_score
            error_ms = abs(aligned_start - expected_start) * 1000.0
            words.append(
                {
                    "ownerId": word.get("ownerId"),
                    "text": word.get("text"),
                    "expectedStartS": round(expected_start, 4),
                    "alignedStartS": round(aligned_start, 4),
                    "errorMs": round(error_ms, 2),
                    "alignScore": round(score, 4),
                    "used": used,
                }
            )
            if used:
                errors.append(error_ms)
    usable = len(errors)
    enough = usable >= THRESHOLDS["minUsableWords"]
    return {
        "usableWords": usable,
        "totalWords": len(plan["words"]),
        "medianAttackErrorMs": round(median(errors), 2) if enough else None,
        "p95AttackErrorMs": round(_percentile(errors, 0.95), 2) if enough else None,
        "words": words,
    }


def _gates(lexical: dict, contour: dict, attack: dict, audio_metrics: dict, thresholds: dict) -> dict:
    def at_most(value, limit) -> bool:
        return value is not None and value <= limit

    return {
        "medianAttack": at_most(attack.get("medianAttackErrorMs"), thresholds["medianAttackErrorMs"]),
        "p95Attack": at_most(attack.get("p95AttackErrorMs"), thresholds["p95AttackErrorMs"]),
        "silenceBleed": at_most(audio_metrics.get("silenceBleedMs"), thresholds["silenceBleedMs"]),
        "medianPitch": at_most(contour.get("medianAbsPitchErrorSemitones"), thresholds["medianAbsPitchErrorSemitones"]),
        "octaveRun": at_most(contour.get("longestOctaveErrorMs"), thresholds["longestOctaveErrorMs"]),
        "voicedOverlap": contour.get("voicedOverlap") is not None and contour["voicedOverlap"] >= thresholds["voicedOverlap"],
        "lexicalFloor": lexical_shortlist_ok(lexical, min_hits=thresholds["lexicalMinHits"], max_substitutions=thresholds["lexicalMaxSubstitutions"]),
    }


def evaluate_candidate(*, candidate_id: str, plan: dict, lexical: dict | None, contour: dict | None, attack: dict | None, audio_metrics: dict | None, duration_s: float | None, thresholds: dict = THRESHOLDS) -> dict:
    expected_duration = float(plan["clip"]["end"]) - float(plan["clip"]["start"])
    invalid_reasons: list[str] = []
    if duration_s is None or abs(duration_s - expected_duration) > thresholds["durationToleranceS"]:
        invalid_reasons.append(f"duration {duration_s} outside {expected_duration}±{thresholds['durationToleranceS']}s")
    if lexical is None:
        invalid_reasons.append("asr failed")
    if attack is None or (attack.get("usableWords", 0) == 0 and not attack.get("words")):
        invalid_reasons.append("forced alignment failed")
    if contour is None:
        invalid_reasons.append("f0 extraction failed")
    elif contour.get("voicedRatioCand", 0.0) < thresholds["minVoicedRatio"]:
        invalid_reasons.append(f"voiced ratio {contour.get('voicedRatioCand')} below {thresholds['minVoicedRatio']}")
    evaluation = {
        "version": 1,
        "candidateId": candidate_id,
        "lane": "ace-step-cover",
        "durationS": duration_s,
        "lexical": lexical,
        "attack": attack,
        "contour": contour,
        "audioMetrics": audio_metrics,
        "invalidReasons": invalid_reasons,
    }
    if invalid_reasons:
        evaluation.update({"gates": {}, "shortlistFailures": [], "autoStatus": "invalid"})
        return evaluation
    gates = _gates(lexical, contour, attack, audio_metrics or {}, thresholds)
    evaluation["gates"] = gates
    evaluation["shortlistFailures"] = [name for name, passed in gates.items() if not passed]
    evaluation["autoStatus"] = "shortlisted" if not evaluation["shortlistFailures"] else "diagnostic"
    return evaluation


def ranking_key(evaluation: dict) -> tuple:
    if evaluation["autoStatus"] == "invalid":
        return (1, str(evaluation["candidateId"]))
    lexical = evaluation["lexical"]
    contour = evaluation["contour"]
    attack = evaluation["attack"]
    audio = evaluation["audioMetrics"] or {}
    register = contour.get("registerOffsetSemitones")
    contour_correlation = contour.get("contourCorrelation")
    return (
        0,
        lexical["misses"],
        lexical["substitutions"],
        -(lexical["hits"] + 0.5 * lexical["nearMisses"]),
        -lexical["sequenceRatio"],
        attack["medianAttackErrorMs"] if attack.get("medianAttackErrorMs") is not None else _INF,
        -contour_correlation if contour_correlation is not None else _INF,
        abs(register) if register is not None else _INF,
        -(audio.get("envelopeCorrelation") or 0.0),
        audio.get("silenceBleedMs") if audio.get("silenceBleedMs") is not None else _INF,
        str(evaluation["candidateId"]),
    )


def effective_status(evaluation: dict, verdict: dict | None, current_manifest_sha256: str) -> str:
    if not verdict or verdict.get("manifestSha256") != current_manifest_sha256:
        return evaluation["autoStatus"]
    if verdict.get("verdict") == "pass":
        return "owner_pass"
    if verdict.get("verdict") == "fail":
        return "owner_fail"
    return evaluation["autoStatus"]
