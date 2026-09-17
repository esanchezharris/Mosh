"""Portable mined artifacts; predicate execution belongs to the TS offline validator."""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, replace
from enum import StrEnum
from pathlib import Path
from typing import Final, TypeAlias, assert_never

from schema import Skill, validate_skill_shape

Json: TypeAlias = None | bool | int | float | str | list["Json"] | dict[str, "Json"]
JsonObject: TypeAlias = dict[str, Json]
RESULT_REFERENCE: Final = re.compile(r"\{step([1-9]\d*)\.result\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\}", re.ASCII)
SELECTORS: Final = frozenset(("tracks[].id", "tracks[].clips[].id", "tracks[].plugins[].index",
    "tracks[].clips[].notes[].i", "sections[].id", "list_drum_kits:data.kits[].id"))


class PredicateType(StrEnum):
    SNAPSHOT_CHOICE = "snapshot_choice"
    COMMAND_EFFECT = "command_effect"


class MinedSchemaError(ValueError):
    field: str
    reason: str

    def __init__(self, field: str, reason: str) -> None:
        self.field = field
        self.reason = reason
        super().__init__(str(self))

    def __str__(self) -> str:
        return f"{self.field}: {self.reason}"


def _require(condition: bool, field: str, reason: str) -> None:
    if not condition:
        raise MinedSchemaError(field, reason)


def _record(value: Json, field: str) -> JsonObject:
    if not isinstance(value, dict):
        raise MinedSchemaError(field, "expected an object")
    return value


def _array(value: Json, field: str) -> list[Json]:
    if not isinstance(value, list):
        raise MinedSchemaError(field, "expected an array")
    return value


def _string(value: Json, field: str, *, nonempty: bool = True) -> str:
    if not isinstance(value, str) or (nonempty and not value.strip()):
        raise MinedSchemaError(field, "expected a string" + (" with content" if nonempty else ""))
    return value


def _integer(value: Json, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise MinedSchemaError(field, "expected a positive integer")
    return value


def _number(value: Json, field: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise MinedSchemaError(field, "expected a finite number")
    return float(value)


def _strings(value: Json, field: str) -> tuple[str, ...]:
    return tuple(_string(item, field) for item in _array(value, field))


def _primitive(value: Json, field: str) -> None:
    _require(isinstance(value, (str, bool, int, float)), field, "expected a primitive value")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        _number(value, field)


def _same_primitive(left: Json, right: Json) -> bool:
    return left == right and isinstance(left, bool) == isinstance(right, bool)


def _input(value: Json, field: str) -> JsonObject:
    entry = _record(value, field)
    _require(entry.get("kind") in ("choice_static", "choice_snapshot", "set", "flag", "number", "text"), field, "unknown input kind")
    _require(entry.get("defaultPolicy") in ("owner", "omit", "native", "required"), field, "unknown default policy")
    _string(entry.get("question"), field + ".question")
    native = _record(entry.get("nativeSource"), field + ".nativeSource")
    _string(native.get("file"), field + ".nativeSource.file")
    _integer(native.get("line"), field + ".nativeSource.line")
    for key in ("presenceQuestion", "selector", "unit", "notes"):
        if key in entry:
            _string(entry[key], field + "." + key, nonempty=False)
    for key in ("min", "max"):
        if key in entry:
            _number(entry[key], field + "." + key)
    if "integer" in entry:
        _require(isinstance(entry["integer"], bool), field, "integer must be boolean")
    if "statistics" in entry:
        stats = _record(entry["statistics"], field + ".statistics")
        values = [_number(stats.get(key), field + ".statistics." + key) for key in ("min", "median", "max")]
        _require(values == sorted(values), field, "statistics must be ordered")
    choices: list[Json] = []
    if "options" in entry:
        for option in _array(entry["options"], field + ".options"):
            choice = _record(option, field + ".options[]")
            _primitive(choice.get("value"), field + ".options[].value")
            _string(choice.get("description"), field + ".options[].description")
            value = choice["value"]
            _require(not any(_same_primitive(value, other) for other in choices), field, "duplicate option value")
            choices.append(value)
    _require(entry["kind"] != "choice_static" or bool(choices), field, "static choices require options")
    if entry["kind"] == "choice_snapshot":
        _require(_string(entry.get("selector"), field + ".selector") in SELECTORS, field, "unsupported selector")
    return entry


def _structural_args(value: Json, names: set[str], step: int) -> Json:
    match value:
        case dict():
            return {key: _structural_args(child, names, step) for key, child in value.items()}
        case list():
            return [_structural_args(child, names, step) for child in value]
        case str():
            result = RESULT_REFERENCE.fullmatch(value)
            if result:
                _require(int(result[1]) < step, "template", "result reference must name a prior step")
                return None
            if "{" in value or "}" in value:
                slot = re.fullmatch(r"\{([A-Za-z_]\w*)\}", value, re.ASCII)
                _require(slot is not None and slot[1] in names, "template", f"unknown slot or invalid reference {value}")
            return value
        case bool() | int() | float() | None:
            return value
        case unreachable:
            assert_never(unreachable)


def _predicates(value: Json, field: str, inputs: dict[str, JsonObject], commands: list[JsonObject]) -> None:
    predicates = _array(value, field)
    seen: set[str | int] = set()
    expected: set[str | int] = set(range(1, len(commands) + 1)) if field == "postconditions" else {
        slot for slot, entry in inputs.items() if entry["kind"] == "choice_snapshot"}
    for item in predicates:
        predicate = _record(item, field)
        try:
            kind = PredicateType(_string(predicate.get("type"), field + ".type"))
        except ValueError as exc:
            raise MinedSchemaError(field, "unknown predicate type") from exc
        match kind:
            case PredicateType.SNAPSHOT_CHOICE:
                _require(field == "preconditions", field, "snapshot_choice is a precondition only")
                slot = _string(predicate.get("slot"), field + ".slot")
                selector = _string(predicate.get("selector"), field + ".selector")
                _require(slot in inputs, field, "unknown predicate slot")
                _require(inputs[slot].get("kind") == "choice_snapshot" and inputs[slot].get("selector") == selector, field, "selector does not match slot input")
                _require(slot not in seen, field, "duplicate snapshot choice")
                seen.add(slot)
            case PredicateType.COMMAND_EFFECT:
                _require(field == "postconditions", field, "command_effect is a postcondition only")
                step = _integer(predicate.get("step"), field + ".step")
                command = _string(predicate.get("command"), field + ".command")
                _require(step <= len(commands), field, "step exceeds command count")
                _require(commands[step - 1]["command"] == command, field, "command does not match step")
                _require(step not in seen, field, "duplicate command effect")
                seen.add(step)
            case unreachable:
                assert_never(unreachable)
    _require(seen == expected, field, "missing predicate coverage")


def _validate(data: JsonObject) -> None:
    _require(_integer(data.get("schemaVersion"), "schemaVersion") == 1, "schemaVersion", "unsupported version")
    for field in ("id", "name", "description"):
        _string(data.get(field), field)
    _require(5 <= len(_strings(data.get("examples"), "examples")) <= 10, "examples", "expected 5 to 10 examples")
    _require(bool(_strings(data.get("provenance"), "provenance")), "provenance", "at least one row is required")
    _strings(data.get("triggers"), "triggers")
    inputs: dict[str, JsonObject] = {}
    for item in _array(data.get("slots"), "slots"):
        slot = _record(item, "slots[]")
        name = _string(slot.get("name"), "slots[].name")
        _require(name not in inputs, "slots", "duplicate slot name")
        for key in ("type", "description"):
            _string(slot.get(key), "slots[]." + key)
        _require(isinstance(slot.get("required"), bool), "slots[].required", "expected a boolean")
        _require(slot.get("source") == "user", "slots[].source", "expected user")
        _require("default" in slot, "slots[].default", "required field")
        if slot["default"] is not None:
            _primitive(slot["default"], "slots[].default")
        inputs[name] = _input(slot.get("input"), "slots[].input")
        _require((slot["default"] == "NEEDS_OWNER_VALUE") == (inputs[name]["defaultPolicy"] == "owner"), "slots[].default", "owner sentinel and policy must agree")
        if inputs[name]["defaultPolicy"] == "owner":
            _require(slot["default"] == "NEEDS_OWNER_VALUE" and slot["type"] == "number" and "statistics" in inputs[name], "slots[].default", "owner values require numeric sentinel and statistics")
        if inputs[name]["kind"] == "choice_static" and slot["default"] not in (None, "NEEDS_OWNER_VALUE"):
            _require(any(_same_primitive(slot["default"], _record(option, "options")["value"]) for option in _array(inputs[name]["options"], "options")), "slots[].default", "default is not a static option")
    template = _record(data.get("template"), "template")
    commands = [_record(item, "template.commands[]") for item in _array(template.get("commands"), "template.commands")]
    _require(bool(commands), "template.commands", "at least one command is required")
    structural_args: list[JsonObject] = []
    for step, command in enumerate(commands, 1):
        _string(command.get("command"), "template.commands[].command")
        structural_args.append(_record(_structural_args(_record(command.get("args"), "template.commands[].args"), set(inputs), step), "template.commands[].args"))
    for field in ("preconditions", "postconditions"):
        _predicates(data.get(field), field, inputs, commands)
    base = Skill.from_dict(data)
    structure = tuple(replace(command, args=structural_args[i]) for i, command in enumerate(base.template))
    errors = validate_skill_shape(replace(base, template=structure, preconditions=(), postconditions=()))
    _require(not errors, "base", "; ".join(errors))
    mining = _record(data.get("mining"), "mining")
    for key in ("rank", "rows"):
        _integer(mining.get(key), "mining." + key)
    shape = _strings(mining.get("shape"), "mining.shape")
    _require(list(shape) == [command["command"] for command in commands], "mining.shape", "must match template commands")
    _require(mining.get("undo") in ("per_mutation", "none", "history"), "mining.undo", "unknown undo mode")
    for item in _array(mining.get("bindings"), "mining.bindings"):
        binding = _record(item, "mining.bindings[]")
        slot = _string(binding.get("slot"), "mining.bindings[].slot")
        step = _integer(binding.get("step"), "mining.bindings[].step")
        arg = _string(binding.get("arg"), "mining.bindings[].arg")
        _require(slot in inputs and step <= len(commands), "mining.bindings", "unknown slot or step")
        args = _record(commands[step - 1]["args"], "template.commands[].args")
        _require(args.get(arg) == "{" + slot + "}", "mining.bindings", "binding does not match placeholder")


def _read_json(text: str) -> JsonObject:
    try:
        value: Json = json.loads(text)
        json.dumps(value, allow_nan=False)
    except (ValueError, TypeError) as exc:
        raise MinedSchemaError("json", str(exc)) from exc
    return _record(value, "artifact")


@dataclass(frozen=True, slots=True)
class MinedSkill:
    """Retain portable metadata; base preserves predicates that legacy execution cannot evaluate."""

    _json: str

    def __post_init__(self) -> None:
        _validate(_read_json(self._json))

    @classmethod
    def from_dict(cls, data: JsonObject) -> MinedSkill:
        try:
            serialized = json.dumps(data, allow_nan=False, ensure_ascii=False)
        except (ValueError, TypeError) as exc:
            raise MinedSchemaError("json", str(exc)) from exc
        return cls(serialized)

    @classmethod
    def from_json(cls, text: str) -> MinedSkill:
        return cls.from_dict(_read_json(text))

    @classmethod
    def load(cls, path: str | Path) -> MinedSkill:
        return cls.from_json(Path(path).read_text(encoding="utf-8"))

    def to_dict(self) -> JsonObject:
        return _read_json(self._json)

    @property
    def base(self) -> Skill:
        return Skill.from_dict(self.to_dict())

    @property
    def id(self) -> str:
        return _string(self.to_dict()["id"], "id")

    @property
    def examples(self) -> tuple[str, ...]:
        return _strings(self.to_dict()["examples"], "examples")
