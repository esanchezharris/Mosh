#!/usr/bin/env python3
"""The catalog-boundary contract, Python half.

`service/skills/` and `ui/src/agent/skills.ts` are two DIFFERENT artifacts
(hand-written executable workflow DAGs vs a mined retrieval corpus — see
`docs/first-stranger-program/SKILL_CATALOG_BOUNDARY.md`). The one thing they
share is the MoshOps command surface, and that is single-sourced: this package
PARSES `ui/src/agent/commands.ts` rather than restating it.

This file guards the two ways that single-source claim can quietly become
false on the Python side:

1. **Projection fidelity.** `moshops_catalog.py` is a parser, so it can be
   lossy without failing. It was: an escape-unaware `desc` regex truncated
   any description containing `\\"`, silently shortening 2 of 124 commands.
   A parser that drops data is a second catalog wearing a projection's
   clothes.
2. **The shipped `library.jsonl` is a frozen artifact.** It is mined once and
   committed. Nothing re-validated it against the catalog it was mined
   against — `router_test.py` deliberately uses corpus fixtures, "not the
   shipped library.jsonl". So a renamed argument in `commands.ts` would rot
   the shipped library in place and the router would emit invalid commands.

The TS half of this contract lives in `ui/src/agent/skillCatalogBoundary.test.ts`,
which is the half that fires when only `commands.ts` changes (the cheap gate's
Python suite is path-scoped to `service/` and `relay/`, so a `ui/`-only PR
never runs this file).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import moshops_catalog as mc  # noqa: E402
import schema  # noqa: E402

_LIBRARY_PATH = Path(__file__).resolve().parent / "library.jsonl"


def _load_library() -> list[dict]:
    rows = []
    for line in _LIBRARY_PATH.read_text().splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


# ── 1. projection fidelity ───────────────────────────────────────────────
#
# Every case below is a real string shape that appears in commands.ts today.

_ESCAPE_TS = """
export const AGENT_COMMANDS: AgentCommand[] = [
  { command: "compile_render", desc: "Compile a loose instruction (\\"make it lo-fi\\", \\"as a violin\\") into a render", args: [S("clipId")] },
  { command: "add_drum_pattern", desc: "lane strings — 'x' hit, 'X' accent; short lanes tile (\\"x.\\" = 8th hats)", args: [S("pattern")] },
  { command: "single_quoted", desc: 'it\\'s a single-quoted desc with an escaped apostrophe', args: [N("n")] },
  { command: "trailing", desc: "the entry AFTER the escaped ones still parses", args: [B("flag", false)] },
];
"""


def test_desc_with_escaped_double_quotes_is_not_truncated():
    catalog = mc.parse_agent_commands_ts(_ESCAPE_TS)
    assert catalog["compile_render"].desc == (
        'Compile a loose instruction ("make it lo-fi", "as a violin") into a render'
    )


def test_desc_with_escaped_quote_at_the_tail_is_not_truncated():
    catalog = mc.parse_agent_commands_ts(_ESCAPE_TS)
    assert catalog["add_drum_pattern"].desc == (
        "lane strings — 'x' hit, 'X' accent; short lanes tile (\"x.\" = 8th hats)"
    )


def test_single_quoted_desc_with_escaped_apostrophe_is_not_truncated():
    catalog = mc.parse_agent_commands_ts(_ESCAPE_TS)
    assert catalog["single_quoted"].desc == "it's a single-quoted desc with an escaped apostrophe"


def test_entries_after_an_escaped_desc_still_parse():
    # A truncating regex doesn't just shorten one desc — it can swallow the
    # rest of the array. Pin that the whole file survives.
    catalog = mc.parse_agent_commands_ts(_ESCAPE_TS)
    assert set(catalog) == {"compile_render", "add_drum_pattern", "single_quoted", "trailing"}
    assert catalog["trailing"].desc == "the entry AFTER the escaped ones still parses"


def test_no_real_catalog_desc_looks_truncated():
    """A desc that ends mid-escape is the fingerprint of the old regex bug."""
    catalog = mc.load_catalog()
    for name, spec in catalog.items():
        assert not spec.desc.endswith("\\"), f"{name}: desc ends in a dangling backslash — parser truncation"
        # Every real desc is a sentence; the truncated ones were cut to the
        # first escaped quote, which in practice leaves an unbalanced opener.
        assert spec.desc.count('"') % 2 == 0, f"{name}: odd number of double quotes in desc — parser truncation: {spec.desc!r}"


def test_every_real_command_has_a_nonempty_desc():
    catalog = mc.load_catalog()
    for name, spec in catalog.items():
        assert spec.desc.strip(), f"{name}: parsed an empty desc"


# ── 2. the shipped library is valid against the catalog it names ─────────


def test_shipped_library_is_nonempty_and_schema_valid():
    rows = _load_library()
    assert len(rows) >= 30, f"expected the mined library, got {len(rows)} rows"
    for row in rows:
        skill = schema.Skill(
            name=row["name"],
            description=row["description"],
            slots=tuple(schema.Slot.from_dict(s) for s in row["slots"]),
            template=tuple(schema.TemplateCommand.from_dict(c) for c in row["template"]["commands"]),
            preconditions=tuple(row["preconditions"]),
            postconditions=tuple(row["postconditions"]),
            provenance=tuple(row["provenance"]),
            triggers=tuple(row.get("triggers", ())),
        )
        assert skill.name


def test_every_shipped_library_command_exists_in_the_catalog():
    catalog = mc.load_catalog()
    for row in _load_library():
        for cmd in row["template"]["commands"]:
            assert cmd["command"] in catalog, (
                f'library skill {row["name"]!r} names {cmd["command"]!r}, '
                "which is not in ui/src/agent/commands.ts"
            )


def test_every_shipped_library_arg_is_declared_by_its_command():
    catalog = mc.load_catalog()
    for row in _load_library():
        for cmd in row["template"]["commands"]:
            spec = catalog.get(cmd["command"])
            if spec is None:
                continue  # reported by the test above
            declared = set(spec.arg_names())
            for arg in cmd["args"]:
                assert arg in declared, (
                    f'library skill {row["name"]!r} binds {cmd["command"]}.{arg}, '
                    f"which that command does not declare (declared: {sorted(declared)})"
                )


def test_every_shipped_library_command_binds_its_required_args():
    catalog = mc.load_catalog()
    for row in _load_library():
        for cmd in row["template"]["commands"]:
            spec = catalog.get(cmd["command"])
            if spec is None:
                continue
            for required in spec.required_args():
                assert required in cmd["args"], (
                    f'library skill {row["name"]!r} calls {cmd["command"]} without '
                    f'required arg "{required}"'
                )


def test_shipped_library_literal_args_match_the_declared_type():
    """Placeholders like "{db}" are router-filled; literals must typecheck now."""
    catalog = mc.load_catalog()
    type_ok = {
        "string": lambda v: isinstance(v, str),
        "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
        "boolean": lambda v: isinstance(v, bool),
    }
    checked = 0
    for row in _load_library():
        for cmd in row["template"]["commands"]:
            spec = catalog.get(cmd["command"])
            if spec is None:
                continue
            by_name = {a.name: a for a in spec.args}
            for arg, value in cmd["args"].items():
                declared = by_name.get(arg)
                if declared is None:
                    continue
                if isinstance(value, str) and value.startswith("{") and value.endswith("}"):
                    continue  # a slot/item placeholder, not a literal
                checked += 1
                assert type_ok[declared.type](value), (
                    f'library skill {row["name"]!r}: {cmd["command"]}.{arg} literal '
                    f"{value!r} is not a {declared.type}"
                )
    assert checked > 0, "no literal args were checked — this test would be vacuous"


def test_every_shipped_library_slot_type_is_allowed():
    for row in _load_library():
        for slot in row["slots"]:
            assert slot["type"] in schema.ALLOWED_SLOT_TYPES, (
                f'library skill {row["name"]!r} slot {slot["name"]!r} has '
                f'unknown type {slot["type"]!r}'
            )


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-v"]))
