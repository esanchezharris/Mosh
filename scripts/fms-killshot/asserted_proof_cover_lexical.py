"""Lexical diagnostics for ACE-Step cover candidates.

ASR ranks candidates; it never declares success — pronunciations like
"hella" are themselves ASR-sensitive, so nothing here can auto-pass a
candidate. Classification is per expected word against the heard token
sequence, tolerant of the known Whisper failure shapes (phonetic
substitution, boundary merges, aliases).
"""

from __future__ import annotations

import re
from difflib import SequenceMatcher

ALIASES: dict[str, frozenset[str]] = {
    "hella": frozenset({"hela", "helluva"}),
    "yeah": frozenset({"yea", "yah"}),
}

NEAR_MISS_RATIO = 0.6
BOUNDARY_MIN_EXPECTED_CHARS = 4
BOUNDARY_MAX_EXTRA_CHARS = 4
_PAIR_BONUS = 1e-3


def normalize_asr_word(value: str) -> str:
    return re.sub(r"[^a-z0-9']", "", value.lower())


def _ratio(left: str, right: str) -> float:
    return SequenceMatcher(a=left, b=right, autojunk=False).ratio()


def _mismatch_kind(expected: str, heard: str) -> str | None:
    if heard in ALIASES.get(expected, frozenset()):
        return "alias"
    if (
        len(expected) >= BOUNDARY_MIN_EXPECTED_CHARS
        and len(heard) > len(expected)
        and len(heard) - len(expected) <= BOUNDARY_MAX_EXTRA_CHARS
        and (heard.startswith(expected) or heard.endswith(expected))
    ):
        return "boundary_merge"
    if _ratio(expected, heard) >= NEAR_MISS_RATIO:
        return "phonetic_sub"
    return None


def _align_block(expected_block: list[str], heard_block: list[str]) -> list[tuple[int, int]]:
    """Monotone alignment maximizing summed char similarity; pairing preferred over gaps."""
    size_e, size_h = len(expected_block), len(heard_block)
    scores = [[0.0] * (size_h + 1) for _ in range(size_e + 1)]
    for i in range(1, size_e + 1):
        for j in range(1, size_h + 1):
            paired = scores[i - 1][j - 1] + _ratio(expected_block[i - 1], heard_block[j - 1]) + _PAIR_BONUS
            scores[i][j] = max(paired, scores[i - 1][j], scores[i][j - 1])
    pairs: list[tuple[int, int]] = []
    i, j = size_e, size_h
    while i > 0 and j > 0:
        paired = scores[i - 1][j - 1] + _ratio(expected_block[i - 1], heard_block[j - 1]) + _PAIR_BONUS
        if scores[i][j] == paired:
            pairs.append((i - 1, j - 1))
            i, j = i - 1, j - 1
        elif scores[i][j] == scores[i - 1][j]:
            i -= 1
        else:
            j -= 1
    pairs.reverse()
    return pairs


def _miss(index: int, text: str) -> dict:
    return {"index": index, "text": text, "cls": "miss", "heard": None, "similarity": 0.0, "mismatchKind": None}


def _classify(expected: list[str], heard: list[str]) -> tuple[list[dict], int]:
    expected_n = [normalize_asr_word(str(word)) for word in expected]
    heard_n = [token for token in (normalize_asr_word(str(word)) for word in heard) if token]
    per_word: list[dict | None] = [None] * len(expected_n)
    insertions = 0
    matcher = SequenceMatcher(a=expected_n, b=heard_n, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for offset in range(i2 - i1):
                index = i1 + offset
                per_word[index] = {"index": index, "text": expected_n[index], "cls": "hit", "heard": heard_n[j1 + offset], "similarity": 1.0, "mismatchKind": None}
        elif tag == "delete":
            for index in range(i1, i2):
                per_word[index] = _miss(index, expected_n[index])
        elif tag == "insert":
            insertions += j2 - j1
        else:
            block_pairs = _align_block(expected_n[i1:i2], heard_n[j1:j2])
            pair_map = {local_e: local_h for local_e, local_h in block_pairs}
            for index in range(i1, i2):
                local = index - i1
                if local not in pair_map:
                    per_word[index] = _miss(index, expected_n[index])
                    continue
                heard_token = heard_n[j1 + pair_map[local]]
                kind = _mismatch_kind(expected_n[index], heard_token)
                per_word[index] = {
                    "index": index,
                    "text": expected_n[index],
                    "cls": "near_miss" if kind is not None else "substitution",
                    "heard": heard_token,
                    "similarity": round(_ratio(expected_n[index], heard_token), 4),
                    "mismatchKind": kind,
                }
            insertions += (j2 - j1) - len(block_pairs)
    return [entry for entry in per_word if entry is not None], insertions


def classify_words(expected: list[str], heard: list[str]) -> list[dict]:
    per_word, _ = _classify(expected, heard)
    return per_word


def score_lexical(expected: list[str], heard: list[str]) -> dict:
    per_word, insertions = _classify(expected, heard)
    expected_n = [normalize_asr_word(str(word)) for word in expected]
    heard_n = [token for token in (normalize_asr_word(str(word)) for word in heard) if token]
    counts = {"hit": 0, "near_miss": 0, "substitution": 0, "miss": 0}
    for entry in per_word:
        counts[entry["cls"]] += 1
    return {
        "hits": counts["hit"],
        "nearMisses": counts["near_miss"],
        "substitutions": counts["substitution"],
        "misses": counts["miss"],
        "insertions": insertions,
        "lexicalScore": (counts["hit"] + 0.5 * counts["near_miss"]) / max(1, len(expected_n)),
        "sequenceRatio": SequenceMatcher(a=expected_n, b=heard_n, autojunk=False).ratio(),
        "perWord": per_word,
    }


def lexical_shortlist_ok(summary: dict, *, min_hits: int = 10, max_substitutions: int = 2) -> bool:
    return summary["misses"] == 0 and summary["substitutions"] <= max_substitutions and summary["hits"] >= min_hits
