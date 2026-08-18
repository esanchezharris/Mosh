#!/usr/bin/env python3
"""Machine-check every authored SFT chat-JSONL row against the REAL agent
catalog (ui/src/agent/commands.ts), the REAL add_drum_pattern DSL grammar
(ui/src/ui/drumPatternUtil.ts, ported in lib_drum_pattern.py), and the
production reply contract (ui/src/agent/brainCore.ts: INTENTS, the
{intent, say?, commands?} shape, and the HUH-defer-is-empty convention from
ui/src/sft/negatives.ts).

Built for the r6-sft-data-pass task's ground rule 3: "an SFT example teaching
a nonexistent arg is poison" — this is that poison detector. Every check here
is traceable to a real source file, not invented policy.

Usage:
    python3 validate_sft_rows.py <path-to-chat.jsonl> [<path2> ...]
    python3 validate_sft_rows.py --known-ids 1010,1012,1013,1015,1016,1018,1019,1021 <path>

Exit code 0 = every row in every file is clean. Exit code 1 = at least one
violation (printed to stderr, one line per violation, file:line-prefixed).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib_drum_pattern import parse_drum_pattern  # noqa: E402
from sft_catalog import CommandSpec, load_catalog, load_intents  # noqa: E402

ID_ARG_NAMES = {"trackId", "clipId", "sectionId", "annotationId", "busId", "sendId", "groupId"}
# Commands whose id-shaped arg is explicitly allowed to be OMITTED to mean
# "create a new one" — never a reason to accept an INVENTED id when present.
ID_ARG_OPTIONAL_CREATES = {"add_drum_pattern": {"trackId", "clipId"}}


class Violation(Exception):
    pass


def _check_reply_shape(reply: dict, intents: list[str]) -> list[str]:
    errs: list[str] = []
    if "intent" not in reply or not isinstance(reply.get("intent"), str):
        errs.append("assistant JSON missing string \"intent\"")
    elif reply["intent"] not in intents:
        errs.append(f'assistant "intent" {reply["intent"]!r} not in INTENTS {intents}')
    extra_keys = set(reply.keys()) - {"intent", "say", "commands"}
    if extra_keys:
        errs.append(f"assistant JSON has keys outside the reply contract: {sorted(extra_keys)}")
    if "say" in reply and reply["say"] is not None:
        if not isinstance(reply["say"], str):
            errs.append('"say" must be a string')
        else:
            words = reply["say"].split()
            if len(words) > 12:
                errs.append(f'"say" is {len(words)} words (rule: <=12 words) — {reply["say"]!r}')
    return errs


def _check_command(
    call: dict, catalog: dict[str, CommandSpec], known_ids: set[str], command_name_for_ids: str
) -> list[str]:
    errs: list[str] = []
    if not isinstance(call, dict) or "command" not in call:
        return ['commands[] entry missing "command"']
    name = call["command"]
    spec = catalog.get(name)
    if spec is None:
        return [f'not an allowed command: "{name}" (not in AGENT_COMMANDS)']
    args = call.get("args")
    if not isinstance(args, dict):
        return [f'{name}: "args" must be an object']

    for a in spec.args:
        v = args.get(a.name)
        if v is None:
            if a.required:
                errs.append(f'{name}: missing required "{a.name}"')
            continue
        if a.type == "number" and not isinstance(v, (int, float)) or isinstance(v, bool) and a.type == "number":
            errs.append(f'{name}: "{a.name}" must be a number, got {type(v).__name__}')
        elif a.type == "boolean" and not isinstance(v, bool):
            errs.append(f'{name}: "{a.name}" must be true/false, got {type(v).__name__}')
        elif a.type == "string" and not isinstance(v, str):
            errs.append(f'{name}: "{a.name}" must be a string, got {type(v).__name__}')

    # Real-id-only discipline: DEFAULT_RULES says "never invent ids". Any
    # id-shaped arg present must resolve to a known fixture id — UNLESS the
    # command's own contract says omitting it creates a new entity (in which
    # case it may be legitimately absent, but if PRESENT it must still be real).
    optional_creates = ID_ARG_OPTIONAL_CREATES.get(name, set())
    for a in spec.args:
        if a.name not in ID_ARG_NAMES:
            continue
        v = args.get(a.name)
        if v is None:
            continue
        if not isinstance(v, str) or not v.strip():
            continue
        if v not in known_ids:
            errs.append(f'{name}: "{a.name}"={v!r} is not a known real id (invented id — rejected)')
        del optional_creates  # (kept only for readability; no separate branch needed)

    if name == "add_drum_pattern":
        pattern = args.get("pattern")
        steps_per_bar = int(args["stepsPerBar"]) if isinstance(args.get("stepsPerBar"), (int, float)) else 16
        bars = int(args["bars"]) if isinstance(args.get("bars"), (int, float)) else 0
        velocity_raw = args.get("velocity", 100)
        velocity = int(velocity_raw) if isinstance(velocity_raw, (int, float)) else 100
        if isinstance(pattern, str):
            parsed = parse_drum_pattern(pattern, steps_per_bar, bars, velocity)
            if not parsed.ok:
                errs.append(f"add_drum_pattern: pattern DSL invalid: {parsed.error} (pattern={pattern!r})")
        if args.get("trackId") and args.get("clipId"):
            errs.append("add_drum_pattern: trackId is ignored when clipId is set — pass one, not both (avoid an ambiguous authored example)")
    return errs


def validate_reply_obj(reply: dict, catalog: dict[str, CommandSpec], intents: list[str], known_ids: set[str]) -> list[str]:
    errs = _check_reply_shape(reply, intents)
    intent = reply.get("intent")
    commands = reply.get("commands")

    if intent in ("HUH", "NUH"):
        # ui/src/sft/negatives.ts's registered defer convention: a deferral
        # NEVER carries commands. Empty list is tolerated; anything non-empty
        # is the exact "ambiguity violation" class the r6-sft-data-pass task
        # calls out (create_section instead of asking).
        if commands not in (None, []):
            errs.append(f'intent {intent} (a defer) must not carry commands; got {commands!r}')
        if intent == "HUH" and not (isinstance(reply.get("say"), str) and reply["say"].strip()):
            errs.append('intent HUH should ask something in "say" (DEFAULT_RULES: "ask in `say`")')
        return errs

    if commands is None:
        return errs  # a non-defer intent with no commands is unusual but not a contract violation
    if not isinstance(commands, list):
        errs.append('"commands" must be a list')
        return errs

    seen: set[str] = set()
    for call in commands:
        errs.extend(_check_command(call, catalog, known_ids, str(call.get("command"))))
        # Dosage rule: no identical (command, args) repeated in one reply —
        # the exact "add_drum_pattern three times" bug class named in the task.
        try:
            fp = json.dumps(call, sort_keys=True)
        except TypeError:
            fp = repr(call)
        if fp in seen:
            errs.append(f"duplicate command+args repeated in one reply: {fp}")
        seen.add(fp)
    return errs


def validate_row(row: dict, catalog: dict[str, CommandSpec], intents: list[str], known_ids: set[str]) -> list[str]:
    errs: list[str] = []
    messages = row.get("messages")
    if not isinstance(messages, list) or len(messages) != 3:
        return ["row must have exactly 3 messages [system, user, assistant]"]
    roles = [m.get("role") if isinstance(m, dict) else None for m in messages]
    if roles != ["system", "user", "assistant"]:
        errs.append(f"message roles must be [system, user, assistant], got {roles}")
        return errs
    sys_msg, user_msg, asst_msg = messages
    for label, m in (("system", sys_msg), ("user", user_msg)):
        if not isinstance(m.get("content"), str) or not m["content"].strip():
            errs.append(f"{label} message content must be a non-empty string")

    asst_content = asst_msg.get("content")
    if not isinstance(asst_content, str):
        errs.append("assistant message content must be a string")
        return errs
    try:
        reply = json.loads(asst_content)
    except json.JSONDecodeError as e:
        errs.append(f"assistant content is not valid JSON: {e}")
        return errs
    if not isinstance(reply, dict):
        errs.append("assistant JSON must be an object")
        return errs

    errs.extend(validate_reply_obj(reply, catalog, intents, known_ids))

    user_text = user_msg.get("content", "") if isinstance(user_msg, dict) else ""
    if isinstance(reply.get("commands"), list):
        asked_save = "save" in user_text.lower()
        for call in reply["commands"]:
            if isinstance(call, dict) and call.get("command") == "save" and not asked_save:
                errs.append('emits "save" but the user never asked to save (dosage rule: never save unasked)')
    return errs


def validate_file(path: Path, catalog: dict[str, CommandSpec], intents: list[str], known_ids: set[str]) -> list[str]:
    errs: list[str] = []
    with path.open(encoding="utf-8") as f:
        for lineno, raw in enumerate(f, start=1):
            line = raw.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as e:
                errs.append(f"{path}:{lineno}: not valid JSON: {e}")
                continue
            for e in validate_row(row, catalog, intents, known_ids):
                errs.append(f"{path}:{lineno}: {e}")
    return errs


DEFAULT_KNOWN_IDS = {"1010", "1012", "1013", "1015", "1016", "1018", "1019", "1021"}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--known-ids", default=",".join(sorted(DEFAULT_KNOWN_IDS)),
                     help="comma-separated real ids new rows are allowed to reference")
    args = ap.parse_args(argv)
    known_ids = {tok.strip() for tok in args.known_ids.split(",") if tok.strip()}

    catalog = load_catalog()
    intents = load_intents()

    all_errs: list[str] = []
    total_rows = 0
    for path in args.files:
        n = sum(1 for line in path.open(encoding="utf-8") if line.strip())
        total_rows += n
        all_errs.extend(validate_file(path, catalog, intents, known_ids))

    if all_errs:
        for e in all_errs:
            print(e, file=sys.stderr)
        print(f"FAIL: {len(all_errs)} violation(s) across {total_rows} row(s) in {len(args.files)} file(s)", file=sys.stderr)
        return 1
    print(f"OK: {total_rows} row(s) across {len(args.files)} file(s), 0 violations "
          f"({len(catalog)} commands / {len(intents)} intents cross-checked)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
