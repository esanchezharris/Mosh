from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from asserted_proof_cover_lexical import (  # noqa: E402
    classify_words,
    lexical_shortlist_ok,
    normalize_asr_word,
    score_lexical,
)

EXPECTED_OPENING = ["yeah", "we", "used", "to", "fight", "like", "invincible", "but", "in", "the", "night", "we", "got", "hella", "close", "yeah"]

# The real seed-42 Whisper output from the ad-hoc spike (normalized), kept verbatim as a fixture.
SEED42_HEARD = ["yeah", "you", "used", "to", "fight", "like", "invisible", "but", "in", "the", "nightly", "i", "had", "a", "close", "yeah"]


def test_normalize_asr_word_matches_runtime_convention() -> None:
    assert normalize_asr_word("Yeah,") == "yeah"
    assert normalize_asr_word("close.") == "close"
    assert normalize_asr_word("don't") == "don't"
    assert normalize_asr_word("  Hella! ") == "hella"


def test_perfect_transcription_is_all_hits() -> None:
    summary = score_lexical(EXPECTED_OPENING, list(EXPECTED_OPENING))
    assert summary["hits"] == 16
    assert summary["nearMisses"] == 0
    assert summary["substitutions"] == 0
    assert summary["misses"] == 0
    assert summary["insertions"] == 0
    assert summary["lexicalScore"] == 1.0
    assert summary["sequenceRatio"] == 1.0
    assert lexical_shortlist_ok(summary) is True


def test_seed42_fixture_classifies_the_real_mismatches() -> None:
    per_word = classify_words(EXPECTED_OPENING, SEED42_HEARD)
    assert len(per_word) == 16
    by_index = {entry["index"]: entry for entry in per_word}
    invincible = by_index[6]
    assert invincible["text"] == "invincible"
    assert invincible["cls"] == "near_miss"
    assert invincible["mismatchKind"] == "phonetic_sub"
    assert invincible["heard"] == "invisible"
    night = by_index[10]
    assert night["cls"] == "near_miss"
    assert night["mismatchKind"] == "boundary_merge"
    assert night["heard"] == "nightly"
    assert by_index[1]["cls"] == "substitution"  # we -> you
    # Inside the "we got hella close" -> "I had a close" garble the monotone
    # max-similarity attribution lands hella->had (0.5, substitution), leaves
    # the second "we" unattributed (miss) and "a" as an insertion.
    assert by_index[13]["cls"] == "substitution"
    assert by_index[13]["heard"] == "had"
    assert by_index[11]["cls"] == "miss"  # we (second occurrence)
    assert by_index[12]["cls"] == "substitution"  # got -> i
    assert by_index[14]["cls"] == "hit"  # close recovers inside the garble
    assert by_index[15]["cls"] == "hit"  # final yeah

    summary = score_lexical(EXPECTED_OPENING, SEED42_HEARD)
    assert summary["hits"] == 10
    assert summary["nearMisses"] == 2
    assert summary["substitutions"] == 3
    assert summary["misses"] == 1
    assert summary["insertions"] == 1
    assert summary["lexicalScore"] == (10 + 0.5 * 2) / 16
    assert lexical_shortlist_ok(summary) is False  # a miss and 3 substitutions


def test_empty_heard_is_all_misses() -> None:
    summary = score_lexical(EXPECTED_OPENING, [])
    assert summary["hits"] == 0
    assert summary["misses"] == 16
    assert summary["lexicalScore"] == 0.0
    assert lexical_shortlist_ok(summary) is False


def test_alias_counts_as_near_miss() -> None:
    heard = list(EXPECTED_OPENING)
    heard[13] = "hela"
    per_word = classify_words(EXPECTED_OPENING, heard)
    hella = next(entry for entry in per_word if entry["index"] == 13)
    assert hella["cls"] == "near_miss"
    assert hella["mismatchKind"] == "alias"


def test_boundary_merge_requires_length_guards() -> None:
    per_word = classify_words(["night"], ["midnight"])
    assert per_word[0]["cls"] == "near_miss"
    assert per_word[0]["mismatchKind"] == "boundary_merge"
    # A 2-char expected word never boundary-merges ("in" would merge into almost anything).
    per_word = classify_words(["in"], ["inside"])
    assert per_word[0]["mismatchKind"] != "boundary_merge"


def test_inserted_words_are_counted_without_penalizing_hits() -> None:
    heard = EXPECTED_OPENING[:3] + ["uh"] + EXPECTED_OPENING[3:]
    summary = score_lexical(EXPECTED_OPENING, heard)
    assert summary["hits"] == 16
    assert summary["insertions"] == 1


def test_classification_is_deterministic() -> None:
    first = score_lexical(EXPECTED_OPENING, SEED42_HEARD)
    second = score_lexical(EXPECTED_OPENING, SEED42_HEARD)
    assert first == second
