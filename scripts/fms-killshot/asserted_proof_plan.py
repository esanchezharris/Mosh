from __future__ import annotations

import hashlib
import math
import os
import re
import copy
from dataclasses import dataclass
from pathlib import Path
from statistics import median
from typing import Final

TOKEN_RE: Final[re.Pattern[str]] = re.compile(r"[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?")
PHRASE_GAP_S: Final[float] = 0.35


@dataclass(frozen=True, slots=True)
class PlanError(Exception):
    message: str

    def __str__(self) -> str:
        return self.message


def normalize_token(text: str) -> str:
    return "".join(TOKEN_RE.findall(text)).lower()


def flatten_corrected_words(corrected: dict, split_word_idx: int) -> list[dict]:
    tokens: list[dict] = []
    for row in corrected.get("words", []):
        source_index = int(row.get("sourceIndex", -1))
        if row.get("deleted") or source_index > split_word_idx:
            continue
        parts = TOKEN_RE.findall(str(row.get("word", "")))
        for sub_index, text in enumerate(parts):
            tokens.append(
                {
                    "text": text,
                    "normalized": normalize_token(text),
                    "ownerId": f"src-{source_index}-{sub_index}",
                    "sourceIndex": source_index,
                    "sourceSubIndex": sub_index,
                }
            )
    return tokens


def syllabify_phones(phones: list[str]) -> list[list[str]]:
    if not phones:
        return []
    vowels = [index for index, phone in enumerate(phones) if phone[-1:].isdigit()]
    if not vowels:
        return [phones]
    cuts = [right - 1 if right - left > 1 else right for left, right in zip(vowels, vowels[1:])]
    groups: list[list[str]] = []
    start = 0
    for cut in cuts:
        groups.append(phones[start:cut])
        start = cut
    groups.append(phones[start:])
    return groups


def _refined_boundaries(start: float, end: float, count: int, envelope: list[float], hop_s: float) -> list[float]:
    if count <= 1:
        return [start, end]
    boundaries = [start]
    width = (end - start) / count
    for index in range(1, count):
        expected = start + width * index
        radius = min(width * 0.25, 0.08)
        low = max(start + 0.04, expected - radius)
        high = min(end - 0.04, expected + radius)
        left = max(0, int(low / hop_s))
        right = min(len(envelope), int(high / hop_s) + 1)
        if right > left:
            frame = min(range(left, right), key=envelope.__getitem__)
            candidate = frame * hop_s
        else:
            candidate = expected
        boundaries.append(max(boundaries[-1] + 0.02, min(candidate, end - 0.02 * (count - index))))
    boundaries.append(end)
    return boundaries


def _raw_midi(f0: list[dict], start: float, end: float) -> float | None:
    voiced = [float(point["hz"]) for point in f0 if start <= float(point["t"]) < end and float(point["hz"]) > 0]
    if not voiced:
        return None
    return 69.0 + 12.0 * math.log2(median(voiced) / 440.0)


def _pitch_syllables(syllables: list[dict]) -> None:
    phrase_start = 0
    for index in range(len(syllables) + 1):
        phrase_break = index == len(syllables)
        if index and index < len(syllables):
            phrase_break = float(syllables[index]["start"]) - float(syllables[index - 1]["end"]) >= PHRASE_GAP_S
        if not phrase_break:
            continue
        phrase = syllables[phrase_start:index]
        measured = [position for position, syl in enumerate(phrase) if syl["rawMidi"] is not None]
        if phrase and not measured:
            raise PlanError(f"phrase has no measured F0 at {phrase[0]['start']:.3f}s")
        previous: float | None = None
        for position, syl in enumerate(phrase):
            raw = syl["rawMidi"]
            provenance = "measured"
            if raw is None:
                nearest = min(measured, key=lambda measured_pos: abs(measured_pos - position))
                raw = phrase[nearest]["rawMidi"]
                provenance = "interpolated"
            assert raw is not None
            adjusted = float(raw)
            if previous is not None and abs(adjusted - previous) > 7.0:
                candidates = [(adjusted + shift, shift) for shift in (0, -12, 12, -24, 24)]
                adjusted = min(candidates, key=lambda item: (abs(item[0] - previous), abs(item[1])))[0]
            syl["midiPitch"] = int(round(adjusted))
            syl["pitchProvenance"] = provenance
            previous = adjusted
        phrase_start = index


def build_render_plan(*, clip_id: str, clip_start: float, clip_end: float, tokens: list[dict], aligned: list[dict], pronunciations: dict[str, list[str]], f0: list[dict], envelope: list[float], envelope_hop_s: float) -> dict:
    if len(tokens) != len(aligned):
        raise PlanError(f"token/alignment mismatch: {len(tokens)} != {len(aligned)}")
    words: list[dict] = []
    all_syllables: list[dict] = []
    for token, span in zip(tokens, aligned):
        normalized = str(token["normalized"])
        phones = pronunciations.get(normalized) or []
        groups = syllabify_phones(phones)
        if not groups:
            raise PlanError(f"no pronunciation for {token['text']}")
        start = float(span["start"])
        end = float(span["end"])
        boundaries = _refined_boundaries(start, end, len(groups), envelope, envelope_hop_s)
        syllables: list[dict] = []
        for index, group in enumerate(groups):
            syl_start, syl_end = boundaries[index], boundaries[index + 1]
            syllable = {
                "id": f"{token['ownerId']}-syl-{index}",
                "index": index,
                "phones": group,
                "stress": next((int(phone[-1]) for phone in group if phone[-1:].isdigit()), 0),
                "start": round(syl_start, 6),
                "end": round(syl_end, 6),
                "rawMidi": _raw_midi(f0, syl_start, syl_end),
            }
            syllables.append(syllable)
            all_syllables.append(syllable)
        words.append(
            {
                **token,
                "start": start,
                "end": end,
                "alignmentScore": float(span.get("score", 0.0)),
                "phones": phones,
                "syllables": syllables,
            }
        )
    _pitch_syllables(all_syllables)
    for syllable in all_syllables:
        syllable.pop("rawMidi", None)
    return {
        "ok": True,
        "version": 1,
        "clip": {"id": clip_id, "start": clip_start, "end": clip_end},
        "summary": {"lexicalTokens": len(words), "syllables": len(all_syllables)},
        "words": words,
    }


def author_soulx_score(plan: dict, name: str) -> list[dict]:
    clip = plan["clip"]
    cursor = float(clip["start"])
    events: list[dict] = []
    for word in plan["words"]:
        for index, syllable in enumerate(word["syllables"]):
            start, end = float(syllable["start"]), float(syllable["end"])
            if start > cursor + 0.01:
                events.append({"text": "<SP>", "phoneme": "<SP>", "pitch": 0, "type": 1, "duration": start - cursor})
            phones = list(syllable.get("scorePhones") or syllable["phones"])
            if phones == ["AH1"]:
                raise PlanError(f"placeholder phoneme in {syllable['id']}")
            events.append(
                {
                    "text": word["text"],
                    "phoneme": "en_" + "-".join(phones),
                    "pitch": int(syllable["midiPitch"]),
                    "type": 2 if index == 0 else 3,
                    "duration": end - start,
                }
            )
            cursor = end
    if cursor < float(clip["end"]):
        events.append({"text": "<SP>", "phoneme": "<SP>", "pitch": 0, "type": 1, "duration": float(clip["end"]) - cursor})
    durations = [max(0.01, float(event["duration"])) for event in events]
    total_ms = round(sum(durations) * 1000)
    return [
        {
            "index": f"{name}_0_{total_ms}",
            "language": "English",
            "time": [0, total_ms],
            "duration": " ".join(f"{duration:.4f}" for duration in durations),
            "text": " ".join(str(event["text"]) for event in events),
            "phoneme": " ".join(str(event["phoneme"]) for event in events),
            "note_pitch": " ".join(str(event["pitch"]) for event in events),
            "note_type": " ".join(str(event["type"]) for event in events),
        }
    ]


def articulation_relaxed_plan(plan: dict, consonant_min_s: float = 0.12) -> dict:
    relaxed = copy.deepcopy(plan)
    for word in relaxed.get("words", []):
        syllables = word.get("syllables", [])
        if len(syllables) < 2:
            continue
        durations = [float(syl["end"]) - float(syl["start"]) for syl in syllables]
        minimums = [consonant_min_s if any(not phone[-1:].isdigit() for phone in syl["phones"]) else 0.06 for syl in syllables]
        total = sum(durations)
        if sum(minimums) > total:
            raise PlanError(f"word span cannot fit articulation minimums: {word.get('text', '?')}")
        deficits = [max(0.0, minimum - duration) for minimum, duration in zip(minimums, durations)]
        surplus = [max(0.0, duration - minimum) for minimum, duration in zip(minimums, durations)]
        total_deficit, total_surplus = sum(deficits), sum(surplus)
        adjusted = [
            minimum if duration < minimum else duration - (extra / total_surplus * total_deficit if total_surplus else 0.0)
            for duration, minimum, extra in zip(durations, minimums, surplus)
        ]
        cursor = float(word["start"])
        for index, syllable in enumerate(syllables):
            syllable["start"] = round(cursor, 6)
            cursor = float(word["end"]) if index == len(syllables) - 1 else cursor + adjusted[index]
            syllable["end"] = round(cursor, 6)
    relaxed["articulationRelaxed"] = True
    relaxed["consonantMinimumS"] = consonant_min_s
    return relaxed


def repair_word_articulation_plan(
    plan: dict,
    *,
    owner_id: str,
    minimum_duration_s: float,
    trailing_guard_s: float,
) -> dict:
    repaired = copy.deepcopy(plan)
    words = repaired.get("words", [])
    try:
        index = next(index for index, word in enumerate(words) if word.get("ownerId") == owner_id)
    except StopIteration as error:
        raise PlanError(f"articulation repair owner not found: {owner_id}") from error
    word = words[index]
    syllables = word.get("syllables") or []
    if not syllables:
        raise PlanError(f"articulation repair word has no syllables: {owner_id}")
    start, original_end = float(word["start"]), float(word["end"])
    repaired_end = max(original_end, start + minimum_duration_s)
    following_start = float(words[index + 1]["start"]) if index + 1 < len(words) else float(repaired["clip"]["end"])
    if repaired_end > following_start - trailing_guard_s:
        raise PlanError(f"articulation repair would move or crowd the following attack: {owner_id}")
    word["end"] = round(repaired_end, 6)
    syllables[-1]["end"] = round(repaired_end, 6)
    repaired["articulationRepair"] = {
        "ownerId": owner_id,
        "originalStart": start,
        "originalEnd": original_end,
        "repairedEnd": repaired_end,
        "minimumDurationS": minimum_duration_s,
        "trailingGuardS": trailing_guard_s,
        "borrowedTrailingSilenceS": repaired_end - original_end,
    }
    return repaired


def apply_articulation_heuristics(
    plan: dict,
    *,
    preferred_duration_s: float = 0.14,
    minimum_duration_s: float = 0.12,
    trailing_guard_s: float = 0.04,
) -> dict:
    repaired = copy.deepcopy(plan)
    words = repaired.get("words", [])
    applications = []
    for index, word in enumerate(words):
        if word.get("phones") != ["DH", "AH0"]:
            continue
        syllables = word.get("syllables") or []
        if len(syllables) != 1:
            continue
        syllable = syllables[0]
        syllable["scorePhones"] = ["DH", "AH0", "AH0"]
        start, original_end = float(word["start"]), float(word["end"])
        following_start = float(words[index + 1]["start"]) if index + 1 < len(words) else float(repaired["clip"]["end"])
        available_end = following_start - trailing_guard_s
        desired_end = start + preferred_duration_s
        repaired_end = min(desired_end, available_end)
        extended = repaired_end >= start + minimum_duration_s and repaired_end > original_end
        if extended:
            word["end"] = round(repaired_end, 6)
            syllable["end"] = round(repaired_end, 6)
        applications.append(
            {
                "rule": "dh-schwa-vowel-weight",
                "ownerId": word.get("ownerId"),
                "originalStart": start,
                "originalEnd": original_end,
                "repairedEnd": repaired_end if extended else original_end,
                "durationExtended": extended,
                "scorePhones": syllable["scorePhones"],
                "followingAttackPreservedS": following_start,
            }
        )
    repaired["articulationHeuristics"] = applications
    repaired["articulationHeuristicPolicy"] = {
        "preferredDurationS": preferred_duration_s,
        "minimumDurationS": minimum_duration_s,
        "trailingGuardS": trailing_guard_s,
        "scope": "DH-AH0 only",
    }
    return repaired


def build_manifest(files: dict[str, Path], *, path_root: Path | None = None) -> dict:
    return {
        "version": 1,
        "files": {
            label: {
                "path": os.path.relpath(path, path_root) if path_root is not None else str(path),
                "bytes": path.stat().st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
            for label, path in sorted(files.items())
        },
    }
