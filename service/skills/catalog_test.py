#!/usr/bin/env python3
"""Unit tests for moshops_catalog.py's TS parser — the ground-truth reader.
Exercises both the real ui/src/agent/commands.ts and small inline fixtures
so the bracket/string-aware scanner itself is pinned independent of the
live file's current contents."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import moshops_catalog as mc  # noqa: E402

_FIXTURE_TS = """
// some header comment with { command: "not_real" } inside a comment
export const AGENT_COMMANDS: AgentCommand[] = [
  // ── tracks ── a section comment, same style as the real file
  { command: "create_track", desc: "Add a new track", args: [S("name", false, "track name"), S("type", false, '"audio" | "drum"')] },
  { command: "add_note", desc: "Add a note", args: [S("clipId"), N("pitch"), N("start", true, "beats"), B("accent", false)] },
  { command: "undo", desc: "Undo the last change", args: [] },
];

export const AGENT_COMMAND_MAP = new Map(AGENT_COMMANDS.map((c) => [c.command, c]));
"""


def test_parses_fixture_command_names_and_arg_types():
    catalog = mc.parse_agent_commands_ts(_FIXTURE_TS)
    assert set(catalog.keys()) == {"create_track", "add_note", "undo"}
    ct = catalog["create_track"]
    assert ct.desc == "Add a new track"
    assert [(a.name, a.type, a.required) for a in ct.args] == [
        ("name", "string", False),
        ("type", "string", False),
    ]


def test_parses_required_defaults_true_when_omitted():
    catalog = mc.parse_agent_commands_ts(_FIXTURE_TS)
    an = catalog["add_note"]
    by_name = {a.name: a for a in an.args}
    assert by_name["clipId"].required is True  # 2nd positional omitted -> default true
    assert by_name["pitch"].required is True
    assert by_name["start"].required is True
    assert by_name["accent"].required is False
    assert by_name["accent"].type == "boolean"


def test_parses_zero_arg_command():
    catalog = mc.parse_agent_commands_ts(_FIXTURE_TS)
    assert catalog["undo"].args == ()
    assert catalog["undo"].required_args() == ()


def test_comments_before_and_inside_the_array_do_not_produce_bogus_entries():
    catalog = mc.parse_agent_commands_ts(_FIXTURE_TS)
    assert "not_real" not in catalog
    assert set(catalog.keys()) == {"create_track", "add_note", "undo"}  # the // section comment didn't confuse it


def test_validate_command_matches_ts_validateCommand_semantics():
    catalog = mc.parse_agent_commands_ts(_FIXTURE_TS)
    assert mc.validate_command("create_track", {}, catalog) is None  # all args optional
    assert mc.validate_command("add_note", {"clipId": "1", "pitch": 60, "start": 0}, catalog) is None
    assert mc.validate_command("add_note", {"clipId": "1", "pitch": 60}, catalog) is not None  # missing start
    assert mc.validate_command("add_note", {"clipId": "1", "pitch": "sixty", "start": 0}, catalog) is not None
    assert mc.validate_command("nonexistent_command", {}, catalog) is not None
    assert mc.validate_command("add_note", {"clipId": "1", "pitch": 60, "start": 0, "accent": True}, catalog) is None
    assert mc.validate_command("add_note", {"clipId": "1", "pitch": 60, "start": 0, "accent": "yes"}, catalog) is not None


def test_validate_command_rejects_boolean_where_number_expected():
    catalog = mc.parse_agent_commands_ts(_FIXTURE_TS)
    # Python bools are ints — this guards the isinstance(v, bool) exclusion.
    assert mc.validate_command("add_note", {"clipId": "1", "pitch": True, "start": 0}, catalog) is not None


# ── against the real repo file ───────────────────────────────────────────


def test_loads_the_real_catalog_and_finds_well_known_commands():
    catalog = mc.load_catalog()
    assert len(catalog) >= 60
    for name in ("create_track", "add_note", "set_note", "assign_sample", "load_drum_kit", "set_tempo"):
        assert name in catalog, f"expected {name!r} in the real catalog"


def test_real_catalog_arg_names_are_unique_per_command():
    catalog = mc.load_catalog()
    for name, spec in catalog.items():
        names = [a.name for a in spec.args]
        assert len(names) == len(set(names)), f"{name} has duplicate arg names: {names}"


def test_load_catalog_raises_on_missing_file():
    import pytest

    with pytest.raises(FileNotFoundError):
        mc.load_catalog(Path("/nonexistent/commands.ts"))


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-v"]))
