#!/usr/bin/env python3
"""Unit tests for schema.py: (de)serialization round-trips, shape
validation catching genuine errors, and every predicate type evaluating
correctly."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from schema import (  # noqa: E402
    Skill,
    Slot,
    TemplateCommand,
    eval_predicate,
    validate_skill_shape,
)


def _minimal_skill(**overrides) -> Skill:
    base = dict(
        name="rename-track",
        description="Rename a track",
        slots=(
            Slot("trackId", "string", True, "target track", "user"),
            Slot("name", "string", True, "new name", "user"),
        ),
        template=(TemplateCommand("rename_track", {"trackId": "{trackId}", "name": "{name}"}),),
        preconditions=({"type": "track_exists", "track_slot": "trackId"},),
        postconditions=(),
        provenance=("assist_demonstrations.jsonl#0",),
        triggers=("rename",),
    )
    base.update(overrides)
    return Skill(**base)


# ── (de)serialization round-trip ─────────────────────────────────────────


def test_skill_to_dict_from_dict_round_trips():
    skill = _minimal_skill()
    assert Skill.from_dict(skill.to_dict()) == skill


def test_slot_default_survives_round_trip():
    skill = _minimal_skill(slots=(Slot("mode", "string", False, "sample mode", "user", default="drum"),))
    reloaded = Skill.from_dict(skill.to_dict())
    assert reloaded.slot("mode").default == "drum"


def test_repeat_over_and_emit_if_survive_round_trip():
    template = (
        TemplateCommand(
            "create_bus", {"name": "{busName}"}, emit_if={"type": "bus_missing", "name_slot": "busName"}
        ),
        TemplateCommand("add_send", {"trackId": "{item.trackId}", "bus": "{busIndex}"}, repeat_over="trackIds"),
    )
    skill = _minimal_skill(template=template)
    reloaded = Skill.from_dict(skill.to_dict())
    assert reloaded.template[0].emit_if == {"type": "bus_missing", "name_slot": "busName"}
    assert reloaded.template[1].repeat_over == "trackIds"


# ── shape validation catches genuine errors ─────────────────────────────


def test_valid_skill_has_no_errors():
    assert validate_skill_shape(_minimal_skill()) == []


def test_catches_non_kebab_case_name():
    errors = validate_skill_shape(_minimal_skill(name="Rename_Track"))
    assert any("kebab" in e for e in errors)


def test_catches_empty_description():
    errors = validate_skill_shape(_minimal_skill(description="  "))
    assert any("description" in e for e in errors)


def test_catches_empty_provenance():
    errors = validate_skill_shape(_minimal_skill(provenance=()))
    assert any("provenance" in e for e in errors)


def test_catches_unknown_slot_type():
    errors = validate_skill_shape(
        _minimal_skill(slots=(Slot("trackId", "not_a_real_type", True, "x", "user"),))
    )
    assert any("unknown type" in e for e in errors)


def test_catches_repeat_over_referencing_unknown_slot():
    template = (TemplateCommand("add_send", {"bus": "{item.bus}"}, repeat_over="nonexistentSlot"),)
    errors = validate_skill_shape(_minimal_skill(template=template))
    assert any("unknown slot" in e for e in errors)


def test_catches_item_placeholder_without_repeat_over():
    template = (TemplateCommand("add_note", {"pitch": "{item.pitch}"}),)  # no repeat_over set
    errors = validate_skill_shape(_minimal_skill(template=template))
    assert any("without repeat_over" in e for e in errors)


def test_catches_scalar_placeholder_referencing_unknown_slot():
    template = (TemplateCommand("rename_track", {"name": "{ghostSlot}"}),)
    errors = validate_skill_shape(_minimal_skill(template=template))
    assert any("unknown slot" in e for e in errors)


def test_catches_unknown_predicate_type():
    errors = validate_skill_shape(_minimal_skill(preconditions=({"type": "not_a_real_predicate"},)))
    assert any("unknown predicate type" in e for e in errors)


# ── predicate evaluation ─────────────────────────────────────────────────

SNAPSHOT = {
    "tracks": [{"id": "t0", "name": "Drums", "type": "drum"}, {"id": "t1", "name": "Bass", "type": "audio"}],
    "clips": [{"id": "c0", "trackId": "t0", "kind": "midi", "notes": []}, {"id": "c1", "trackId": "t1", "kind": "wave", "notes": []}],
    "buses": [{"index": 0, "name": "Reverb"}],
}


def test_always_predicate():
    assert eval_predicate({"type": "always"}, SNAPSHOT, {})


def test_track_exists_predicate():
    assert eval_predicate({"type": "track_exists", "track_slot": "trackId"}, SNAPSHOT, {"trackId": "t0"})
    assert not eval_predicate({"type": "track_exists", "track_slot": "trackId"}, SNAPSHOT, {"trackId": "gone"})


def test_clip_exists_and_kind_predicates():
    assert eval_predicate({"type": "clip_exists", "clip_slot": "clipId"}, SNAPSHOT, {"clipId": "c0"})
    assert eval_predicate({"type": "clip_is_midi", "clip_slot": "clipId"}, SNAPSHOT, {"clipId": "c0"})
    assert not eval_predicate({"type": "clip_is_midi", "clip_slot": "clipId"}, SNAPSHOT, {"clipId": "c1"})
    assert eval_predicate({"type": "clip_is_wave", "clip_slot": "clipId"}, SNAPSHOT, {"clipId": "c1"})
    assert not eval_predicate({"type": "clip_is_wave", "clip_slot": "clipId"}, SNAPSHOT, {"clipId": "c0"})


def test_track_type_is_predicate():
    pred = {"type": "track_type_is", "track_slot": "trackId", "value": "drum"}
    assert eval_predicate(pred, SNAPSHOT, {"trackId": "t0"})
    assert not eval_predicate(pred, SNAPSHOT, {"trackId": "t1"})


def test_bus_missing_and_exists_predicates():
    missing = {"type": "bus_missing", "name_slot": "busName"}
    exists = {"type": "bus_exists", "name_slot": "busName"}
    assert not eval_predicate(missing, SNAPSHOT, {"busName": "Reverb"})
    assert eval_predicate(exists, SNAPSHOT, {"busName": "Reverb"})
    assert eval_predicate(missing, SNAPSHOT, {"busName": "Delay"})
    assert not eval_predicate(exists, SNAPSHOT, {"busName": "Delay"})


def test_unknown_predicate_type_raises():
    import pytest

    with pytest.raises(ValueError):
        eval_predicate({"type": "made_up"}, SNAPSHOT, {})


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-v"]))
