#!/usr/bin/env python3
"""The v1 skill schema — mined by mine.py, consumed by router.py.

    Skill := {
      name, description,
      slots:          [{name, type, required, description, source}],
      template:        {commands: [{command, args, repeat_over?, emit_if?}]},
      preconditions:  [predicate],
      postconditions: [predicate],
      provenance:     [corpus row refs],
      triggers:       [retrieval keywords],   # extension, see README
    }

This is the schema named in the brief, plus two small, explicitly-documented
extensions that a router needs to be more than a toy:

  - `slots[].source`: "user" (parsed from the task text or looked up in the
    snapshot by name) or "computed" (derived by a router-side transform
    function from OTHER slots + existing snapshot state — e.g. "the notes
    already in this clip, transposed"). Mining always sets this; it costs
    nothing and makes the router's job legible.
  - `template.commands[].repeat_over` / `.emit_if`: a command can repeat once
    per item of a list-typed slot (`repeat_over`), and/or be conditionally
    skipped based on a predicate over the snapshot (`emit_if`) — e.g. "only
    create_bus if no bus with this name already exists". Both are optional;
    omitting them means "emit this command once, unconditionally", which is
    the common case.
  - `triggers`: a small, deterministically-derived (IDF-weighted) bag of
    words drawn from the skill's own provenance text, used for lexical
    retrieval. `description` alone is too short/uniform for good recall
    across paraphrases (e.g. "map"/"put"/"assign"/"drop" all meaning the
    same assign_sample action) — see mine.py's `derive_triggers`.

`predicate` is a small tagged dict, e.g. {"type": "track_exists", "track_slot":
"trackId"} — see PREDICATE_TYPES below and `eval_predicate`.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Optional

ALLOWED_SLOT_TYPES = frozenset(
    {"string", "number", "boolean", "list<note>", "list<string>", "list<number>", "list<param>"}
)
ALLOWED_SLOT_SOURCES = frozenset({"user", "computed"})

PREDICATE_TYPES = frozenset(
    {
        "track_exists",
        "clip_exists",
        "clip_is_midi",
        "clip_is_wave",
        "track_type_is",
        "bus_missing",
        "bus_exists",
        "always",
    }
)


@dataclass(frozen=True)
class Slot:
    name: str
    type: str
    required: bool
    description: str
    source: str = "user"
    # A representative value mined straight from provenance (e.g. the one
    # example's own `type="drum"`, or the majority value across all of a
    # cluster's rows). Not in the brief's minimal schema, but cheap and
    # honest: it's provenance-derived, never invented, and lets the router
    # fall back to "what the corpus actually did" instead of guessing when
    # text extraction comes up empty on an optional slot.
    default: Any = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "Slot":
        return Slot(
            name=d["name"],
            type=d["type"],
            required=bool(d["required"]),
            description=d.get("description", ""),
            source=d.get("source", "user"),
            default=d.get("default"),
        )


@dataclass(frozen=True)
class TemplateCommand:
    command: str
    args: dict[str, Any]
    repeat_over: Optional[str] = None
    emit_if: Optional[dict[str, Any]] = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"command": self.command, "args": dict(self.args)}
        if self.repeat_over is not None:
            d["repeat_over"] = self.repeat_over
        if self.emit_if is not None:
            d["emit_if"] = dict(self.emit_if)
        return d

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "TemplateCommand":
        return TemplateCommand(
            command=d["command"],
            args=dict(d.get("args", {})),
            repeat_over=d.get("repeat_over"),
            emit_if=d.get("emit_if"),
        )


@dataclass(frozen=True)
class Skill:
    name: str
    description: str
    slots: tuple[Slot, ...]
    template: tuple[TemplateCommand, ...]
    preconditions: tuple[dict[str, Any], ...]
    postconditions: tuple[dict[str, Any], ...]
    provenance: tuple[str, ...]
    triggers: tuple[str, ...] = ()

    def slot(self, name: str) -> Optional[Slot]:
        return next((s for s in self.slots if s.name == name), None)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "slots": [s.to_dict() for s in self.slots],
            "template": {"commands": [c.to_dict() for c in self.template]},
            "preconditions": [dict(p) for p in self.preconditions],
            "postconditions": [dict(p) for p in self.postconditions],
            "provenance": list(self.provenance),
            "triggers": list(self.triggers),
        }

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "Skill":
        return Skill(
            name=d["name"],
            description=d["description"],
            slots=tuple(Slot.from_dict(s) for s in d["slots"]),
            template=tuple(TemplateCommand.from_dict(c) for c in d["template"]["commands"]),
            preconditions=tuple(d.get("preconditions", [])),
            postconditions=tuple(d.get("postconditions", [])),
            provenance=tuple(d["provenance"]),
            triggers=tuple(d.get("triggers", [])),
        )


# ── schema-level validation (structure only; command/arg validity against the
#    MoshOps catalog is checked separately by moshops_catalog.validate_command,
#    since that requires the catalog, not just the skill) ───────────────────


def validate_skill_shape(skill: Skill) -> list[str]:
    errors: list[str] = []
    if not skill.name or skill.name != skill.name.strip():
        errors.append(f"skill name is empty/untrimmed: {skill.name!r}")
    if not all(c.islower() or c.isdigit() or c == "-" for c in skill.name):
        errors.append(f"skill name {skill.name!r} is not kebab-case")
    if not skill.description.strip():
        errors.append(f"{skill.name}: empty description")
    if not skill.template:
        errors.append(f"{skill.name}: template has no commands")
    if not skill.provenance:
        errors.append(f"{skill.name}: no provenance rows cited")

    slot_names = {s.name for s in skill.slots}
    for s in skill.slots:
        if s.type not in ALLOWED_SLOT_TYPES:
            errors.append(f"{skill.name}: slot {s.name!r} has unknown type {s.type!r}")
        if s.source not in ALLOWED_SLOT_SOURCES:
            errors.append(f"{skill.name}: slot {s.name!r} has unknown source {s.source!r}")

    for tc in skill.template:
        if tc.repeat_over is not None and tc.repeat_over not in slot_names:
            errors.append(
                f"{skill.name}: template command {tc.command!r} repeats over "
                f"unknown slot {tc.repeat_over!r}"
            )
        for placeholder in _placeholders_in(tc.args):
            root = placeholder.split(".", 1)[0]
            if root == "item":
                if tc.repeat_over is None:
                    errors.append(
                        f"{skill.name}: template command {tc.command!r} uses "
                        f"'{{item...}}' without repeat_over"
                    )
            elif root not in slot_names:
                errors.append(
                    f"{skill.name}: template command {tc.command!r} references "
                    f"unknown slot '{{{placeholder}}}'"
                )

    for p in (*skill.preconditions, *skill.postconditions):
        if p.get("type") not in PREDICATE_TYPES:
            errors.append(f"{skill.name}: unknown predicate type {p.get('type')!r}")
    for tc in skill.template:
        if tc.emit_if is not None and tc.emit_if.get("type") not in PREDICATE_TYPES:
            errors.append(f"{skill.name}: unknown emit_if predicate type {tc.emit_if.get('type')!r}")

    return errors


def _placeholders_in(args: dict[str, Any]) -> list[str]:
    found = []
    for v in args.values():
        if isinstance(v, str) and v.startswith("{") and v.endswith("}"):
            found.append(v[1:-1])
    return found


# ── predicate evaluation (shared by mine.py's rule-based attachment,
#    router.py's precondition gate, and the test suite) ────────────────────


def eval_predicate(predicate: dict[str, Any], snapshot: dict[str, Any], filled: dict[str, Any]) -> bool:
    """Evaluate one predicate dict against a snapshot + the slot values filled so far.

    `snapshot` is the minimal shape documented in router.py's module docstring:
    {"tracks": [{"id","name","type"}], "clips": [{"id","trackId","kind","notes"}],
     "buses": [{"index","name"}]}.
    """
    ptype = predicate.get("type")
    if ptype == "always":
        return True
    if ptype == "track_exists":
        track_id = filled.get(predicate["track_slot"])
        return any(t.get("id") == track_id for t in snapshot.get("tracks", []))
    if ptype == "clip_exists":
        clip_id = filled.get(predicate["clip_slot"])
        return any(c.get("id") == clip_id for c in snapshot.get("clips", []))
    if ptype == "clip_is_midi":
        clip_id = filled.get(predicate["clip_slot"])
        return any(
            c.get("id") == clip_id and c.get("kind") == "midi" for c in snapshot.get("clips", [])
        )
    if ptype == "clip_is_wave":
        clip_id = filled.get(predicate["clip_slot"])
        return any(
            c.get("id") == clip_id and c.get("kind") == "wave" for c in snapshot.get("clips", [])
        )
    if ptype == "track_type_is":
        track_id = filled.get(predicate["track_slot"])
        value = predicate["value"]
        return any(
            t.get("id") == track_id and t.get("type") == value for t in snapshot.get("tracks", [])
        )
    if ptype == "bus_missing":
        name = filled.get(predicate["name_slot"], predicate.get("value"))
        return not any(b.get("name") == name for b in snapshot.get("buses", []))
    if ptype == "bus_exists":
        name = filled.get(predicate["name_slot"], predicate.get("value"))
        return any(b.get("name") == name for b in snapshot.get("buses", []))
    raise ValueError(f"unknown predicate type: {ptype!r}")
