import json
from dataclasses import FrozenInstanceError
from importlib.util import find_spec
from pathlib import Path

import pytest

from mined_schema import Json, JsonObject, MinedSchemaError, MinedSkill
from schema import Skill, validate_skill_shape

ARTIFACTS = tuple(sorted((Path(__file__).resolve().parents[2] / "skills").glob("*.json")))


def artifact() -> JsonObject:
    value: Json = json.loads(next(path for path in ARTIFACTS if path.name == "sft-02-add-midi-clip.json").read_text())
    return record(value)


def record(value: Json) -> JsonObject:
    assert isinstance(value, dict)
    return value


def array(value: Json) -> list[Json]:
    assert isinstance(value, list)
    return value


def test_portable_loader_is_available() -> None:
    # Given the legacy skills package, when resolving the additive loader,
    # then consumers can import it without changing the legacy schema.
    assert find_spec("mined_schema") is not None


def test_generated_artifacts_are_available() -> None:
    assert ARTIFACTS


@pytest.mark.parametrize("path", ARTIFACTS, ids=lambda path: path.stem)
def test_generated_artifact_roundtrips_without_metadata_loss(path: Path) -> None:
    expected: Json = json.loads(path.read_text())

    loaded = MinedSkill.load(path)

    assert loaded.to_dict() == expected
    assert loaded.base == Skill.from_dict(record(expected))


def test_identity_and_examples_are_accessible() -> None:
    original = artifact()

    loaded = MinedSkill.from_dict(original)

    assert loaded.id == original["id"]
    assert list(loaded.examples) == original["examples"]


def test_legacy_projection_retains_unsupported_offline_predicates() -> None:
    original = artifact()

    base = MinedSkill.from_dict(original).base

    assert list(base.postconditions) == original["postconditions"]
    assert any("unknown predicate type" in error for error in validate_skill_shape(base))


def test_returned_metadata_cannot_mutate_the_frozen_artifact() -> None:
    original = artifact()
    loaded = MinedSkill.from_dict(original)

    record(array(loaded.to_dict()["slots"])[0])["input"] = {}

    assert loaded.to_dict() == original


def test_returned_legacy_projection_cannot_mutate_the_artifact() -> None:
    original = artifact()
    loaded = MinedSkill.from_dict(original)

    loaded.base.postconditions[0]["type"] = "always"

    assert loaded.to_dict() == original


def test_wrapper_is_frozen() -> None:
    loaded = MinedSkill.from_dict(artifact())

    with pytest.raises(FrozenInstanceError):
        setattr(loaded, "_json", "{}")


@pytest.mark.parametrize("predicates", [
    [], [{"type": "always"}], [{"type": "unknown"}],
    [{"type": "command_effect", "step": 0, "command": "add_midi_clip"}],
    [{"type": "command_effect", "step": True, "command": "add_midi_clip"}],
    [{"type": "command_effect", "step": 2, "command": "add_midi_clip"}],
    [{"type": "command_effect", "step": 1, "command": "remove_clip"}],
    [{"type": "command_effect", "step": 1}],
])
def test_invalid_postcondition_is_rejected(predicates: Json) -> None:
    data = artifact()
    data["postconditions"] = predicates

    with pytest.raises(MinedSchemaError):
        MinedSkill.from_dict(data)


@pytest.mark.parametrize("predicate", [
    {"type": "snapshot_choice", "slot": "missing", "selector": "tracks[].id"},
    {"type": "snapshot_choice", "slot": "step1_trackId"},
    {"type": "snapshot_choice", "slot": "step1_trackId", "selector": "clips[].id"},
])
def test_invalid_snapshot_predicate_is_rejected(predicate: Json) -> None:
    data = artifact()
    data["preconditions"] = [predicate]

    with pytest.raises(MinedSchemaError):
        MinedSkill.from_dict(data)


@pytest.mark.parametrize("binding", [
    {"slot": "missing", "step": 1, "arg": "trackId"},
    {"slot": "step1_trackId", "step": 2, "arg": "trackId"},
    {"slot": "step1_trackId", "step": 1, "arg": "length"},
])
def test_invalid_binding_is_rejected(binding: Json) -> None:
    data = artifact()
    record(data["mining"])["bindings"] = [binding]

    with pytest.raises(MinedSchemaError):
        MinedSkill.from_dict(data)


@pytest.mark.parametrize("field,value", [
    ("schemaVersion", True), ("schemaVersion", 2), ("examples", ["short"]),
    ("preconditions", None), ("provenance", []), ("mining", {}),
])
def test_invalid_metadata_is_rejected(field: str, value: Json) -> None:
    data = artifact()
    data[field] = value

    with pytest.raises(MinedSchemaError):
        MinedSkill.from_dict(data)


def test_legacy_slot_validation_is_still_applied() -> None:
    data = artifact()
    record(array(data["slots"])[2])["type"] = "unsupported"

    with pytest.raises(MinedSchemaError, match="unknown type"):
        MinedSkill.from_dict(data)


def test_nested_unknown_placeholder_is_rejected() -> None:
    data = artifact()
    command = record(array(record(data["template"])["commands"])[0])
    record(command["args"])["nested"] = [{"value": "{unknown}"}]

    with pytest.raises(MinedSchemaError, match="unknown slot"):
        MinedSkill.from_dict(data)


def test_invalid_native_source_is_rejected() -> None:
    data = artifact()
    source = record(record(record(array(data["slots"])[0])["input"])["nativeSource"])
    source["line"] = False

    with pytest.raises(MinedSchemaError):
        MinedSkill.from_dict(data)


@pytest.mark.parametrize("text", ["[]", "{", "null"])
def test_invalid_json_boundary_is_rejected(text: str) -> None:
    with pytest.raises(MinedSchemaError):
        MinedSkill.from_json(text)


def test_constructor_rejects_nonfinite_json_in_unknown_metadata() -> None:
    data = artifact()
    data["additionalMetadata"] = float("inf")
    text = json.dumps(data)

    with pytest.raises(MinedSchemaError):
        MinedSkill(text)


def result_artifact(reference: str) -> JsonObject:
    data = artifact()
    array(record(data["template"])["commands"]).append({"command": "remove_clip", "args": {"clipId": reference}})
    array(record(data["mining"])["shape"]).append("remove_clip")
    array(data["postconditions"]).append({"type": "command_effect", "step": 2, "command": "remove_clip"})
    return data


@pytest.mark.parametrize("reference", ["{step1.result.clipId}", "{step1.result.clip.id}"])
def test_prior_result_reference_roundtrips_unchanged(reference: str) -> None:
    data = result_artifact(reference)

    loaded = MinedSkill.from_dict(data)

    assert loaded.to_dict() == data
    assert loaded.base.template[1].args["clipId"] == reference


@pytest.mark.parametrize("reference", [
    "{step2.result.clipId}", "{step3.result.clipId}", "{step0.result.clipId}",
    "{step01.result.clipId}", "{step1.result.}", "{step1.result.clip-id}",
    "{step1.result.clip..id}", "{step1.result.clip.0}", "prefix {step1.result.clipId}",
])
def test_invalid_result_reference_is_rejected(reference: str) -> None:
    with pytest.raises(MinedSchemaError):
        MinedSkill.from_dict(result_artifact(reference))


@pytest.mark.parametrize("field,predicates", [
    ("preconditions", []),
    ("preconditions", [{"type": "snapshot_choice", "slot": "step1_trackId", "selector": "tracks[].id"}] * 2),
    ("preconditions", [{"type": "command_effect", "step": 1, "command": "add_midi_clip"}]),
    ("postconditions", [{"type": "snapshot_choice", "slot": "step1_trackId", "selector": "tracks[].id"}]),
    ("postconditions", [{"type": "command_effect", "step": 1, "command": "add_midi_clip"}] * 2),
])
def test_predicate_roles_and_exact_coverage_are_enforced(field: str, predicates: Json) -> None:
    data = artifact()
    data[field] = predicates

    with pytest.raises(MinedSchemaError):
        MinedSkill.from_dict(data)


def test_missing_command_effect_is_rejected() -> None:
    data = result_artifact("{step1.result.clipId}")
    array(data["postconditions"]).pop()

    with pytest.raises(MinedSchemaError):
        MinedSkill.from_dict(data)


def test_matching_but_unsupported_selector_is_rejected() -> None:
    data = artifact()
    track = next(record(slot) for slot in array(data["slots"]) if record(slot)["name"] == "step1_trackId")
    record(track["input"])["selector"] = "tracks[].invented"
    record(array(data["preconditions"])[0])["selector"] = "tracks[].invented"

    with pytest.raises(MinedSchemaError):
        MinedSkill.from_dict(data)


@pytest.mark.parametrize("default", [None, 0, "placeholder"])
def test_owner_policy_requires_the_explicit_sentinel(default: Json) -> None:
    data = artifact()
    record(array(data["slots"])[0])["default"] = default

    with pytest.raises(MinedSchemaError):
        MinedSkill.from_dict(data)


@pytest.mark.parametrize("options", [[], [{"value": "audio", "description": "audio"}] * 2])
def test_static_choices_require_nonempty_unique_options(options: Json) -> None:
    data = MinedSkill.load(ARTIFACTS[0].parent / "sft-37-create-track.json").to_dict()
    choice = next(record(slot) for slot in array(data["slots"]) if record(record(slot)["input"])["kind"] == "choice_static")
    record(choice["input"])["options"] = options

    with pytest.raises(MinedSchemaError):
        MinedSkill.from_dict(data)


def test_owner_sentinel_is_allowed_for_numeric_static_choices() -> None:
    data = artifact()
    entry = record(record(array(data["slots"])[0])["input"])
    entry["kind"] = "choice_static"
    entry["options"] = [{"value": 1, "description": "one"}, {"value": 2, "description": "two"}]

    loaded = MinedSkill.from_dict(data)

    assert loaded.to_dict() == data


def test_static_default_must_be_among_options() -> None:
    data = MinedSkill.load(ARTIFACTS[0].parent / "sft-37-create-track.json").to_dict()
    choice = next(record(slot) for slot in array(data["slots"]) if record(record(slot)["input"])["kind"] == "choice_static")
    choice["default"] = "absent"

    with pytest.raises(MinedSchemaError):
        MinedSkill.from_dict(data)


def test_owner_sentinel_cannot_use_a_nonowner_policy() -> None:
    data = artifact()
    record(record(array(data["slots"])[0])["input"])["defaultPolicy"] = "required"

    with pytest.raises(MinedSchemaError):
        MinedSkill.from_dict(data)


def test_static_default_does_not_conflate_boolean_and_number() -> None:
    data = artifact()
    slot = record(array(data["slots"])[0])
    slot["default"] = False
    record(slot["input"]).update({"kind": "choice_static", "defaultPolicy": "required", "options": [{"value": 0, "description": "zero"}]})

    with pytest.raises(MinedSchemaError):
        MinedSkill.from_dict(data)
