#!/usr/bin/env python3
"""Read-only parser for ui/src/agent/commands.ts and ui/src/agent/brainCore.ts.

Extracts the exact AGENT_COMMANDS catalog (command name -> arg specs) and the
INTENTS enum, in Python, WITHOUT executing any TypeScript. This is the single
source of truth validate_sft_rows.py checks new SFT rows against, so an
authored example can never teach a command name or arg shape that doesn't
exist in the real agent catalog.

Only a regex/state-machine reader — never a TS/JS execution. Per r6-sft-data
-pass ground rule 5 ("Python only + reading TS for validation"), this file
reads TS source text but never runs node/tsx/npm.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
COMMANDS_TS = REPO_ROOT / "ui" / "src" / "agent" / "commands.ts"
BRAIN_CORE_TS = REPO_ROOT / "ui" / "src" / "agent" / "brainCore.ts"


@dataclass(frozen=True)
class ArgSpec:
    name: str
    type: str  # "string" | "number" | "boolean"
    required: bool


@dataclass(frozen=True)
class CommandSpec:
    command: str
    args: tuple[ArgSpec, ...] = field(default_factory=tuple)


_ARG_CALL_RE = re.compile(r'\b([SNB])\(\s*"((?:[^"\\]|\\.)*)"\s*(?:,\s*(true|false))?')
_TYPE_BY_LETTER = {"S": "string", "N": "number", "B": "boolean"}


def _extract_args(segment: str) -> tuple[ArgSpec, ...]:
    """Scan an `args: [ ... ]` segment for S(...)/N(...)/B(...) calls, in order.

    Deliberately does NOT try to find each call's closing paren (arg
    descriptions can contain '(' ')' '[' ']' freely) — it only needs the
    (type-letter, name, required) triple at the START of each call, which is
    unambiguous: no ArgSpec description in commands.ts contains the literal
    sequence 'S("'/'N("'/'B("' followed by our own capture groups' shape.
    """
    out: list[ArgSpec] = []
    for m in _ARG_CALL_RE.finditer(segment):
        letter, name, required_tok = m.group(1), m.group(2), m.group(3)
        required = True if required_tok is None else (required_tok == "true")
        out.append(ArgSpec(name=name, type=_TYPE_BY_LETTER[letter], required=required))
    return tuple(out)


_COMMAND_LINE_RE = re.compile(
    r'\{\s*command:\s*"([a-z_][a-z0-9_]*)"\s*,\s*desc:\s*"(?:[^"\\]|\\.)*"\s*,\s*args:\s*\[(.*?)\]\s*\}\s*,?\s*$',
    re.M | re.S,
)
# Commands with an empty args list render as `args: []` — no S/N/B calls to scan,
# handled naturally (empty tuple).
#
# re.S (DOTALL) added 2026-08-17 (r7 prep): a handful of entries (e.g.
# set_clip_fade, set_clip_loop) wrap their `args: [...]` list onto a second
# source line for readability. Without DOTALL, `.` never matched the embedded
# newline, so `(.*?)` failed to reach the closing `]` and the whole `{...}`
# entry silently dropped out of the parsed catalog — load_catalog() returned
# 155 of the real 157 AGENT_COMMANDS entries with no error. This surfaced as a
# FALSE positive in validate_system_prompt_drift.py ("2 command(s) in the
# embedded system prompt no longer exist in the current catalog") even though
# both commands are very much still in commands.ts and in the real render.
# `$` (line-end anchor) still works fine under re.M together with re.S: `.`
# now also matches newlines, but `$` is unaffected by re.S and still anchors
# to end-of-line, which every entry's closing `}` (optionally with a trailing
# comma) is.


def load_catalog(commands_ts: Path = COMMANDS_TS) -> dict[str, CommandSpec]:
    src = commands_ts.read_text(encoding="utf-8")
    start = src.index("export const AGENT_COMMANDS")
    end = src.index("export const AGENT_COMMAND_MAP")
    body = src[start:end]
    catalog: dict[str, CommandSpec] = {}
    for m in _COMMAND_LINE_RE.finditer(body):
        name, args_segment = m.group(1), m.group(2)
        catalog[name] = CommandSpec(command=name, args=_extract_args(args_segment))
    return catalog


_INTENTS_RE = re.compile(r'export const INTENTS = \[(.*?)\];')


def load_intents(brain_core_ts: Path = BRAIN_CORE_TS) -> list[str]:
    src = brain_core_ts.read_text(encoding="utf-8")
    m = _INTENTS_RE.search(src)
    if not m:
        raise RuntimeError("could not find INTENTS in brainCore.ts")
    return [tok.strip().strip('"') for tok in m.group(1).split(",") if tok.strip()]


if __name__ == "__main__":
    cat = load_catalog()
    intents = load_intents()
    print(f"{len(cat)} commands, {len(intents)} intents")
    for name in ("add_drum_pattern", "create_track", "load_drum_kit", "create_lyric_sheet",
                 "set_lyric_constraint", "set_lyric_line", "add_note", "create_section", "save"):
        spec = cat.get(name)
        print(name, "->", spec)
