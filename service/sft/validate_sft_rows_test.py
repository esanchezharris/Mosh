#!/usr/bin/env python3
"""RED-proof for validate_sft_rows.py — per CLAUDE.md's "Vacuous verification"
gotcha: a guard that cannot fail looks exactly like one that passes. Every
bad fixture below is a real defect class the r6-sft-data-pass task named
(invented command, invented id, bad required arg, bad drum-pattern DSL,
non-empty defer, duplicate command, unasked save) and each is asserted to
FAIL the validator — not just that a good fixture passes.

Run: python3 -m pytest service/sft/validate_sft_rows_test.py -q
(or, matching this repo's service/skills/ precedent: cd service/sft && pytest -q)
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from sft_catalog import load_catalog, load_intents
from validate_sft_rows import DEFAULT_KNOWN_IDS, validate_file, validate_row

CATALOG = load_catalog()
INTENTS = load_intents()
KNOWN_IDS = DEFAULT_KNOWN_IDS

SYSTEM = "You ARE Moshi ... (system prompt stand-in for unit tests)"


def row(user: str, assistant: dict) -> dict:
    return {
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": user},
            {"role": "assistant", "content": json.dumps(assistant)},
        ]
    }


def errs(assistant_row: dict) -> list[str]:
    return validate_row(assistant_row, CATALOG, INTENTS, KNOWN_IDS)


# ── GREEN: real, valid examples must pass with zero violations ──────────────

def test_valid_add_drum_pattern_from_nothing_passes():
    r = row("gimme a beat with some bounce", {
        "intent": "ACK_GOT_IT",
        "commands": [{"command": "add_drum_pattern", "args": {
            "pattern": "kick: x...x...x...x...; snare: ....x.......x...; hat: x.x.x.x.x.x.x.x.",
        }}],
    })
    assert errs(r) == []


def test_valid_add_drum_pattern_replace_lane_on_existing_clip_passes():
    r = row("add a crash for the drop", {
        "intent": "ACK_GOT_IT",
        "commands": [{"command": "add_drum_pattern", "args": {
            "clipId": "1012", "pattern": "crash: x...............",
        }}],
    })
    assert errs(r) == []


def test_valid_defer_huh_with_no_commands_passes():
    r = row("it feels empty in the middle", {"intent": "HUH", "say": "empty how — a new part, or more energy?"})
    assert errs(r) == []


def test_valid_lyric_sheet_plus_line_followthrough_passes():
    r = row("help me start the hook, topic is missing someone", {
        "intent": "ACK_GOT_IT",
        "commands": [
            {"command": "create_lyric_sheet", "args": {"trackId": "1019", "topic": "missing someone", "grid": "1/8"}},
            {"command": "set_lyric_line", "args": {"trackId": "1019", "lineIndex": 0, "role": "hook", "seedText": "___ ___ ___ ___"}},
        ],
    })
    assert errs(r) == []


# ── RED: each of these MUST fail, and fail for the reason it names ─────────

def test_invented_command_name_is_rejected():
    r = row("add a beat", {"intent": "ACK_GOT_IT", "commands": [{"command": "add_beat_pattern", "args": {}}]})
    e = errs(r)
    assert e, "invented command name must be rejected"
    assert any("not an allowed command" in x for x in e)


def test_invented_track_id_is_rejected():
    r = row("load the drum kit", {"intent": "ACK_GOT_IT", "commands": [
        {"command": "load_drum_kit", "args": {"trackId": "9999"}},
    ]})
    e = errs(r)
    assert e, "an id not present in the fixture must be rejected"
    assert any("not a known real id" in x for x in e)


def test_missing_required_arg_is_rejected():
    r = row("add a note", {"intent": "ACK_GOT_IT", "commands": [
        {"command": "add_note", "args": {"clipId": "1018", "pitch": 60}},  # missing start, length
    ]})
    e = errs(r)
    assert e, "a required arg omission must be rejected"
    assert any('missing required "start"' in x for x in e)
    assert any('missing required "length"' in x for x in e)


def test_wrong_arg_type_is_rejected():
    r = row("add a note", {"intent": "ACK_GOT_IT", "commands": [
        {"command": "add_note", "args": {"clipId": "1018", "pitch": "60", "start": 0, "length": 1}},
    ]})
    e = errs(r)
    assert e, "a string where a number is required must be rejected"
    assert any('"pitch" must be a number' in x for x in e)


def test_bad_drum_pattern_dsl_is_rejected():
    r = row("add hats", {"intent": "ACK_GOT_IT", "commands": [
        {"command": "add_drum_pattern", "args": {"pattern": "hat: xyz."}},  # 'y' is not a valid step char
    ]})
    e = errs(r)
    assert e, "an invalid drum-pattern DSL string must be rejected"
    assert any("pattern DSL invalid" in x for x in e)


def test_nontiling_drum_pattern_lane_is_rejected():
    r = row("add hats", {"intent": "ACK_GOT_IT", "commands": [
        {"command": "add_drum_pattern", "args": {"pattern": "hat: xxx"}},  # 3 doesn't divide 16
    ]})
    e = errs(r)
    assert e, "a lane length that can't tile the bar must be rejected"


def test_huh_with_commands_is_rejected():
    """The exact bug the task names: 'create_section instead of deferring — defer must be EMPTY'."""
    r = row("it feels empty in the middle", {
        "intent": "HUH", "say": "?",
        "commands": [{"command": "create_section", "args": {"name": "New Part", "startBeat": 16, "endBeat": 32}}],
    })
    e = errs(r)
    assert e, "a HUH (defer) reply carrying commands must be rejected"
    assert any("must not carry commands" in x for x in e)


def test_duplicate_command_in_one_reply_is_rejected():
    """The exact bug the task names: 'add_drum_pattern three times'."""
    call = {"command": "add_drum_pattern", "args": {"pattern": "kick: x..."}}
    r = row("gimme a beat", {"intent": "ACK_GOT_IT", "commands": [call, dict(call), dict(call)]})
    e = errs(r)
    assert e, "an exact duplicate command+args repeated in one reply must be rejected"
    assert any("duplicate command+args" in x for x in e)


def test_unasked_save_is_rejected():
    r = row("add a crash for the drop", {
        "intent": "ACK_GOT_IT",
        "commands": [
            {"command": "add_drum_pattern", "args": {"clipId": "1012", "pattern": "crash: x..............."}},
            {"command": "save", "args": {}},
        ],
    })
    e = errs(r)
    assert e, "a 'save' the user never asked for must be rejected"
    assert any("never asked to save" in x for x in e)


def test_invalid_intent_is_rejected():
    r = row("do something", {"intent": "MAYBE", "commands": []})
    e = errs(r)
    assert e, "an intent outside INTENTS must be rejected"
    assert any("not in INTENTS" in x for x in e)


def test_bad_json_assistant_content_is_rejected():
    bad = {
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "do something"},
            {"role": "assistant", "content": "{not json"},
        ]
    }
    e = validate_row(bad, CATALOG, INTENTS, KNOWN_IDS)
    assert e, "malformed assistant JSON must be rejected"
    assert any("not valid JSON" in x for x in e)


def test_validate_file_end_to_end_catches_a_planted_bad_row(tmp_path: Path):
    """Sabotage-with-restore style RED proof over the real file-reading path
    (validate_file), not just validate_row — catches a class of bug where
    the per-row check is correct but the file-walking wrapper silently skips
    or swallows a bad line."""
    good = row("gimme a beat with some bounce", {
        "intent": "ACK_GOT_IT",
        "commands": [{"command": "add_drum_pattern", "args": {"pattern": "kick: x..."}}],
    })
    bad = row("do something", {"intent": "ACK_GOT_IT", "commands": [{"command": "not_a_real_command", "args": {}}]})
    p = tmp_path / "planted_bad.jsonl"
    p.write_text(json.dumps(good) + "\n" + json.dumps(bad) + "\n", encoding="utf-8")
    file_errs = validate_file(p, CATALOG, INTENTS, KNOWN_IDS)
    assert file_errs, "validate_file must surface the planted bad row, not just validate_row in isolation"
    assert any("not_a_real_command" in x for x in file_errs)


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
