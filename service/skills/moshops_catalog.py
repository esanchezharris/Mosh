#!/usr/bin/env python3
"""Ground truth for valid MoshOps commands + arg types.

Skills mined/routed by this package must only ever name commands that the
LLM agent is actually allowed to call, with the exact required args. Rather
than hand-copy that list into Python (guaranteed to drift), this module
parses it straight out of the real source of truth:

    ui/src/agent/commands.ts  ->  AGENT_COMMANDS: AgentCommand[]

That file is the curated ~64-command subset of the ~148 native MoshOps
commands that the LLM agent (and therefore the SFT demonstration corpus
this package mines) is allowed to use — see its own header comment. This
module is READ-ONLY with respect to that file: it never writes to
`ui/src/agent/`, it only parses it, mirroring the small `S`/`N`/`B` builder
DSL used there closely enough to survive edits that don't change that DSL's
shape.

If `ui/src/agent/commands.ts` is not found (e.g. this package copied out of
the repo), `load_catalog()` raises — mining/routing without ground truth
would silently rubber-stamp typos, which is worse than failing loudly.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

_DEFAULT_TS_PATH = Path(__file__).resolve().parents[2] / "ui" / "src" / "agent" / "commands.ts"

_ARRAY_START_RE = re.compile(r"export const AGENT_COMMANDS\s*:\s*AgentCommand\[\]\s*=\s*")
_COMMAND_RE = re.compile(r'command\s*:\s*"([a-z][a-z0-9_]*)"')
_DESC_RE = re.compile(r'desc\s*:\s*(".*?"|\'.*?\')', re.DOTALL)
_ARGS_KEY_RE = re.compile(r"args\s*:\s*")
_CALL_RE = re.compile(r"^([SNB])\(")

_TYPE_BY_BUILDER = {"S": "string", "N": "number", "B": "boolean"}


@dataclass(frozen=True)
class ArgSpec:
    name: str
    type: str  # "string" | "number" | "boolean"
    required: bool
    desc: Optional[str] = None


@dataclass(frozen=True)
class CommandSpec:
    command: str
    desc: str
    args: tuple[ArgSpec, ...]

    def required_args(self) -> tuple[str, ...]:
        return tuple(a.name for a in self.args if a.required)

    def arg_names(self) -> tuple[str, ...]:
        return tuple(a.name for a in self.args)


Catalog = dict[str, CommandSpec]


# ── tiny bracket/string-aware scanner (enough JS to parse this one DSL) ──

_QUOTE_CHARS = ("'", '"', "`")


def _find_matching(s: str, open_pos: int) -> int:
    """Index of the bracket matching s[open_pos], honoring string literals."""
    open_ch = s[open_pos]
    close_ch = {"(": ")", "[": "]", "{": "}"}[open_ch]
    depth = 0
    in_str: Optional[str] = None
    i = open_pos
    while i < len(s):
        c = s[i]
        if in_str:
            if c == "\\":
                i += 2
                continue
            if c == in_str:
                in_str = None
        else:
            if c in _QUOTE_CHARS:
                in_str = c
            elif c == open_ch:
                depth += 1
            elif c == close_ch:
                depth -= 1
                if depth == 0:
                    return i
        i += 1
    raise ValueError(f"unbalanced {open_ch!r} starting at {open_pos}")


def _top_level_split(s: str, sep: str = ",") -> list[str]:
    """Split on `sep` at bracket-depth 0, outside string literals."""
    parts: list[str] = []
    depth = 0
    in_str: Optional[str] = None
    start = 0
    i = 0
    while i < len(s):
        c = s[i]
        if in_str:
            if c == "\\":
                i += 2
                continue
            if c == in_str:
                in_str = None
        else:
            if c in _QUOTE_CHARS:
                in_str = c
            elif c in "([{":
                depth += 1
            elif c in ")]}":
                depth -= 1
            elif c == sep and depth == 0:
                parts.append(s[start:i])
                start = i + 1
        i += 1
    parts.append(s[start:])
    return parts


def _unquote(raw: str) -> str:
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] in _QUOTE_CHARS and raw[-1] == raw[0]:
        inner = raw[1:-1]
        return inner.replace(f"\\{raw[0]}", raw[0]).replace("\\\\", "\\")
    return raw


def _parse_arg_call(call: str) -> ArgSpec:
    """Parse one `S("name", false, "desc")`-shaped call (N/B share the shape)."""
    m = _CALL_RE.match(call.strip())
    if not m:
        raise ValueError(f"not an S()/N()/B() call: {call!r}")
    kind = m.group(1)
    open_paren = call.index("(")
    close_paren = _find_matching(call, open_paren)
    inner = call[open_paren + 1 : close_paren]
    pieces = [p.strip() for p in _top_level_split(inner)]
    name = _unquote(pieces[0])
    required = True
    if len(pieces) >= 2 and pieces[1] != "":
        required = pieces[1].strip() != "false"
    desc = _unquote(pieces[2]) if len(pieces) >= 3 and pieces[2].strip() else None
    return ArgSpec(name=name, type=_TYPE_BY_BUILDER[kind], required=required, desc=desc)


def _parse_args_list(args_src: str) -> tuple[ArgSpec, ...]:
    args_src = args_src.strip()
    if not args_src.startswith("["):
        raise ValueError(f"expected an args array literal, got: {args_src[:40]!r}")
    end = _find_matching(args_src, 0)
    inner = args_src[1:end]
    calls = [c.strip() for c in _top_level_split(inner) if c.strip()]
    return tuple(_parse_arg_call(c) for c in calls)


def _parse_entry(entry_src: str) -> CommandSpec:
    cmd_m = _COMMAND_RE.search(entry_src)
    if not cmd_m:
        raise ValueError(f"no command: field in entry: {entry_src[:80]!r}")
    desc_m = _DESC_RE.search(entry_src)
    desc = _unquote(desc_m.group(1)) if desc_m else ""

    args_key_m = _ARGS_KEY_RE.search(entry_src)
    if not args_key_m:
        raise ValueError(f"no args: field in entry for {cmd_m.group(1)!r}")
    args = _parse_args_list(entry_src[args_key_m.end() :])
    return CommandSpec(command=cmd_m.group(1), desc=desc, args=args)


def parse_agent_commands_ts(source: str) -> Catalog:
    """Parse the body of `ui/src/agent/commands.ts` into a {command: CommandSpec} map."""
    start_m = _ARRAY_START_RE.search(source)
    if not start_m:
        raise ValueError("could not find 'export const AGENT_COMMANDS: AgentCommand[] =' in source")
    array_open = source.index("[", start_m.end() - 1)
    array_close = _find_matching(source, array_open)
    body = source[array_open + 1 : array_close]

    catalog: Catalog = {}
    i = 0
    n = len(body)
    while i < n:
        c = body[i]
        if c == "{":
            close = _find_matching(body, i)
            entry_src = body[i : close + 1]
            spec = _parse_entry(entry_src)
            catalog[spec.command] = spec
            i = close + 1
        else:
            i += 1
    return catalog


def load_catalog(path: Path | None = None) -> Catalog:
    """Load + parse the real ui/src/agent/commands.ts. Raises if it's missing."""
    ts_path = path or _DEFAULT_TS_PATH
    if not ts_path.exists():
        raise FileNotFoundError(
            f"MoshOps agent command catalog not found at {ts_path} — this module "
            "reads it read-only as ground truth; it must exist in the repo checkout."
        )
    return parse_agent_commands_ts(ts_path.read_text())


def validate_command(name: str, args: dict, catalog: Catalog) -> Optional[str]:
    """Mirror ui/src/agent/commands.ts's validateCommand(): None on success, else an error string."""
    spec = catalog.get(name)
    if spec is None:
        return f'not an allowed command: "{name}"'
    for a in spec.args:
        v = args.get(a.name)
        if v is None:
            if a.required:
                return f'{name}: missing required "{a.name}"'
            continue
        if a.type == "number" and (isinstance(v, bool) or not isinstance(v, (int, float))):
            return f'{name}: "{a.name}" must be a number'
        if a.type == "boolean" and not isinstance(v, bool):
            return f'{name}: "{a.name}" must be true/false'
        if a.type == "string" and not isinstance(v, str):
            return f'{name}: "{a.name}" must be a string'
    return None
