#!/usr/bin/env python3
"""Unit tests for the shared text utilities (tokenizer, note-name parser,
numeric extractors) — pure functions, no fixtures needed."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import textutil as tu  # noqa: E402


def test_tokenize_drops_stopwords_short_tokens_and_file_paths():
    toks = tu.tokenize("Map /Users/x/Music/kick.wav to the Drums track on note 36")
    assert "the" not in toks
    assert "to" not in toks
    assert "users" not in toks and "music" not in toks and "kick" not in toks
    assert "drums" in toks
    assert "track" in toks
    assert "note" in toks


def test_tokenize_is_case_insensitive():
    assert tu.tokenize("Solo The Drums") == tu.tokenize("solo the drums")


def test_note_name_to_midi_matches_scientific_pitch_notation():
    assert tu.note_name_to_midi("C", None, 4) == 60  # middle C
    assert tu.note_name_to_midi("A", None, 1) == 33
    assert tu.note_name_to_midi("C", "#", 2) == 37
    assert tu.note_name_to_midi("A", "b", 4) == 68


def test_parse_note_names_extracts_ordered_pitches():
    assert tu.parse_note_names("A1, C#2, E2, A2, A2, C#3") == [33, 37, 40, 45, 45, 49]
    assert tu.parse_note_names("play these notes on the Melody: G4, A4, B4") == [67, 69, 71]
    assert tu.parse_note_names("no notes mentioned here") == []


def test_parse_note_names_ignores_file_paths_and_track_numbers():
    assert tu.parse_note_names("Map /Users/x/Music/kick.wav to track 1011 on note 36") == []


def test_extract_db_percent_fraction_bpm():
    assert tu.extract_db("bring it down 3 dB") == 3.0
    assert tu.extract_db("no db here") is None
    assert tu.extract_percent("swing the hats around 55%") == 55.0
    assert tu.extract_fraction("switch to 3/4 time") == (3, 4)
    assert tu.extract_fraction("go back to plain 4/4") == (4, 4)
    assert tu.extract_bpm("set the tempo to 90") == 90.0  # trailing "to N" form
    assert tu.extract_bpm("slow it down to 80 bpm") == 80.0
    assert tu.extract_bpm("no tempo info here") is None


def test_extract_track_and_note_numbers():
    assert tu.extract_track_number("Turn track 1011 into a drum track.") == "1011"
    assert tu.extract_note_number("Drop the sample onto pad 45 of track 1011.") == 45
    assert tu.extract_note_number("map the kick to note 36") == 36


def test_derive_slot_nouns_catches_capitalized_and_the_x_patterns():
    texts = [
        "swing the hats around 55%",
        "humanize the hats",
        "solo the Drums",
        "pan the Melody a bit to the left",
    ]
    derived = tu.derive_slot_nouns(texts, min_count=2)
    assert "hats" in derived  # "the hats" appears twice
    assert "drums" in derived  # capitalized mid-sentence
    assert "melody" in derived


def test_idf_table_is_lower_for_common_tokens():
    docs = ["set the tempo", "set the pan", "set the volume", "harmonize the melody"]
    idf = tu.idf_table(docs)
    assert idf["set"] < idf["harmonize"]


def test_kebab_normalizes_various_inputs():
    assert tu.kebab("create_track") == "create-track"
    assert tu.kebab("  Some Words  ") == "some-words"
    assert tu.kebab("a--b__c") == "a-b-c"


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-v"]))
