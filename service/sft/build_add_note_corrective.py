#!/usr/bin/env python3
"""AG-NOTE1 — deterministic corrective dataset: natural "write a pattern" /
"play these notes" asks -> VALID add_note command sequences (never
add_drum_pattern).

Countering the r5 4-bit-serve routing flip (`r5-local-serve-read` session memory;
`service/sft/LOCAL_SERVE_READ_a3b-r5-mlx.md`): under the quantized 4-bit experts,
"write a short pattern" requests route to a malformed add_drum_pattern call instead
of the trained add_note sequence (frozen300 0.767 vs 0.977 — 68/70 zeros are this
one behavior). This batch is the "populate" class curate_dataset.py's classify()
already recognizes (all-add_note commands), targeted at melodic-instrument tracks
(never drums) so the corrective signal can't be confused with a legitimate
add_drum_pattern ask.

Row shape matches the mlx-lm chat-format rows already committed at
service/sft/r5_train_additions.jsonl and consumed by curate_dataset.py: one JSON
object per line, {"messages":[{system},{user},{assistant}]}. The command CATALOG
segment of the system prompt is parsed LIVE out of ui/src/agent/commands.ts
(AGENT_COMMANDS) — never hand-copied — so this builder can't invent a command name
or silently drift from the real agent catalog; the PREAMBLE/rules/session-render
segments mirror ui/src/agent/brainCore.ts's PREAMBLE / DEFAULT_RULES /
sessionBlock (the persona/format contract, kept in sync by hand — see render_session).

Deterministic: no RNG, no wall-clock, no network, no I/O other than reading
commands.ts and (optionally) writing --out. Running it twice byte-diffs identical.

  python3 service/sft/build_add_note_corrective.py [--out PATH] [--n 40] [--check]

--check builds and validates the rows without writing (used by CI-style smokes);
the default run writes service/sft/add_note_corrective.jsonl.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import NamedTuple

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
COMMANDS_TS = REPO_ROOT / "ui" / "src" / "agent" / "commands.ts"
DEFAULT_OUT = HERE / "add_note_corrective.jsonl"

TARGET_ROWS = 40


# ── catalog: parsed live from ui/src/agent/commands.ts ───────────────────────
# Every AGENT_COMMANDS entry has the form
#   { command: "name", desc: "...", args: [S("x"), N("y", false), ...] },
# but an entry with many args WRAPS over several lines (e.g. set_clip_fade,
# set_clip_loop). So an entry is accumulated from its opening "{ command:" until
# its braces balance, then matched as one whitespace-normalised string — matching
# line-by-line silently depends on formatting and breaks the moment someone wraps
# a long entry (it did: 114/116 single-line, 2 wrapped, as of 2026-07-18).
# Parsing this file — instead of hand-copying the catalog text — is the
# anti-invention guarantee: a command name used below can only ever be one this
# parser actually found in the real file.

_ENTRY_RE = re.compile(
    r'^\{\s*command:\s*"(?P<name>[a-zA-Z0-9_]+)"\s*,\s*desc:\s*"(?P<desc>(?:[^"\\]|\\.)*)"\s*,'
    r'\s*args:\s*\[(?P<args>.*)\]\s*\},?$'
)
_ARG_RE = re.compile(r'[SNB]\(\s*"(?P<name>[a-zA-Z0-9_]+)"(?:\s*,\s*(?P<required>true|false))?')


class Arg(NamedTuple):
    name: str
    required: bool


class Command(NamedTuple):
    name: str
    desc: str
    args: tuple[Arg, ...]


def _split_entries(body: str) -> list[str]:
    """Yield each AGENT_COMMANDS entry as one whitespace-normalised string.

    Scans for a top-level "{ command:" and consumes until its braces balance, so a
    single entry may span any number of source lines. Brace counting is
    string-aware: a "{" or "}" inside a desc/arg string literal (and any
    backslash-escaped char) is not treated as structure.
    """
    entries: list[str] = []
    i, n = 0, len(body)
    while True:
        start = body.find("{ command:", i)
        if start < 0:
            break
        depth, j = 0, start
        in_str = False
        while j < n:
            c = body[j]
            if in_str:
                if c == "\\":
                    j += 2      # skip the escaped char, incl. \" and \\
                    continue
                if c == '"':
                    in_str = False
            elif c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    j += 1
                    break
            j += 1
        else:
            raise RuntimeError(
                f"unterminated AGENT_COMMANDS entry starting at offset {start} "
                "(parser drifted from commands.ts)"
            )
        # Collapse the wrap: newlines + run-on indentation become single spaces so
        # a wrapped entry is byte-comparable to a single-line one.
        entries.append(" ".join(body[start:j].split()))
        i = j
    return entries


def parse_agent_commands(ts_path: Path = COMMANDS_TS) -> list[Command]:
    text = ts_path.read_text(encoding="utf-8")
    m = re.search(r"export const AGENT_COMMANDS: AgentCommand\[\] = \[(.*?)\n\];", text, re.S)
    if not m:
        raise RuntimeError(f"could not locate AGENT_COMMANDS array in {ts_path}")
    commands: list[Command] = []
    for entry in _split_entries(m.group(1)):
        em = _ENTRY_RE.match(entry)
        if not em:
            raise RuntimeError(f"unparseable AGENT_COMMANDS entry (parser drifted from commands.ts): {entry!r}")
        args = tuple(
            Arg(am.group("name"), True if am.group("required") is None else am.group("required") == "true")
            for am in _ARG_RE.finditer(em.group("args"))
        )
        desc = em.group("desc").replace('\\"', '"')
        commands.append(Command(em.group("name"), desc, args))
    if not commands:
        raise RuntimeError(f"parsed zero AGENT_COMMANDS entries from {ts_path} — parser drifted")
    return commands


def find_command(commands: list[Command], name: str) -> Command:
    for c in commands:
        if c.name == name:
            return c
    raise RuntimeError(f"{name!r} is not in AGENT_COMMANDS ({COMMANDS_TS}) — refusing to emit an invented command")


def command_catalog_prompt(commands: list[Command]) -> str:
    """Mirrors ui/src/agent/commands.ts commandCatalogPrompt()."""
    lines = []
    for c in commands:
        arg_str = ", ".join(f'{a.name}{"" if a.required else "?"}' for a in c.args)
        lines.append(f"- {c.name}({arg_str}) — {c.desc}")
    return "\n".join(lines)


# ── system-prompt scaffold — mirrors ui/src/agent/brainCore.ts PREAMBLE /
#    DEFAULT_RULES / sessionBlock verbatim (the persona/format contract) ────

INTENTS = ["ACK_GOT_IT", "ACK_WORKING", "DONE", "HUH", "NUH", "UHOH", "GREET", "IDLE_MURMUR"]

PREAMBLE = "\n".join([
    "You ARE Moshi — a small, warm, playful creature, the agent living inside a music app called Mosh.",
    "You mostly communicate by emoting + a SOUND (an INTENT), not words. Only add a short `say` when a precise message is truly needed.",
    "You can EDIT the user's session by emitting commands. Reply with ONE compact JSON object and NOTHING else:",
    '{ "intent": one of [' + ", ".join(INTENTS) + '], "say"?: string (<=12 words), "commands"?: [ { "command": string, "args": object } ] }',
    "You may ONLY use these commands — exact names + args (a trailing ? marks optional):",
])

DEFAULT_RULES = "\n".join([
    "Rules:",
    "- Use the REAL ids from the session below for trackId/clipId. Never invent ids or commands.",
    '- trackId/clipId are STRING ids: match one from the session exactly and pass it as a JSON string, e.g. "trackId": "17" — never the bare number 17, and never with extra quote characters inside the value.',
    "- One request can produce several commands (they apply together as one undoable change).",
    "- To re-imagine PART of the song (e.g. \"rework the hook\"), scope a render to that SECTION: create_render_layer on the wave clip under the section with regionStart/regionEnd in SECONDS (beats × 60 ÷ tempo), then render_layer.",
    "- If the request is unclear or needs info you don't have, set intent HUH and ask in `say` — don't guess.",
    "- After making edits use intent ACK_GOT_IT (or DONE for a finishing flourish).",
    "- Stay in character. Never mention JSON, models, commands, or that you're an AI.",
])


def render_session(track_id: str, track_name: str, clip_id: str, tempo: int = 120) -> str:
    """Mirrors ui/src/agent/brainCore.ts sessionBlock() for a one-track,
    one-MIDI-clip session — the shape these add_note-population rows target.

    Updated 2026-07-27 with "the unblinding": sessionBlock replaced the old
    compactSnapshot. Versus the previous shape this adds `key:` and `master:` lines,
    the track's TYPE, and the clip's LENGTH (plus buses / tempo map / pan / sends /
    fx / clip gain when present — none of which this minimal fixture has).

    Training rows must carry the SAME prompt shape the app now sends: an adapter
    trained on the old shape meets a prompt it never saw at serve time. Any adapter
    built before this date (a3b-r5 and earlier) is trained against the OLD shape and
    should be re-measured before being trusted on the new one.
    """
    track_line = f'  "{track_id}" "{track_name}" audio 0dB clips:["{clip_id}":midi@0s+4s]'
    return (
        f"tempo {tempo} BPM, 4/4\n"
        "key: C major\n"
        "master: 0dB pan 0 chain:[empty]\n"
        "sections: (none)\n"
        f"tracks:\n{track_line}"
    )


def build_system_prompt(commands: list[Command], track_id: str, track_name: str, clip_id: str) -> str:
    return "\n".join([
        PREAMBLE,
        command_catalog_prompt(commands),
        DEFAULT_RULES,
        "Current session:",
        render_session(track_id, track_name, clip_id),
    ])


# ── deterministic note generation ─────────────────────────────────────────────

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def pitch_name(pitch: int) -> str:
    return f"{NOTE_NAMES[pitch % 12]}{pitch // 12 - 1}"


# (track name, root MIDI pitch) — registers chosen so root ± an octave never
# leaves the 0-127 range for either the major-scale or arpeggio step tables below.
TRACKS: tuple[tuple[str, int], ...] = (
    ("Melody", 67), ("Bass", 33), ("Keys", 60), ("Lead", 72), ("Piano", 60),
    ("Pad", 55), ("Strings", 57), ("Synth", 65), ("Guitar", 52), ("Horns", 58),
)

MAJOR_STEPS = (0, 2, 4, 5, 7, 9, 11, 12)
ARPEGGIO_STEPS = (0, 4, 7, 12)

# First 20 = abstract "write a pattern" asks (the model invents the notes).
# Last 20 = "play these notes" asks (the notes are named in the utterance).
# Each of the 40 template strings is worded distinctly, so — independent of which
# track/notes get substituted in — no two rows can ever collide on user text.
ABSTRACT_TEMPLATES = (
    lambda t: f"write a quick pattern on the {t}",
    lambda t: f"put a short pattern on {t}",
    lambda t: f"lay down a simple pattern on the {t} track",
    lambda t: f"sketch a little pattern for {t}",
    lambda t: f"tap in a basic pattern on {t}",
    lambda t: f"give {t} a quick pattern",
    lambda t: f"throw a simple pattern onto {t}",
    lambda t: f"write me a short note pattern for the {t}",
    lambda t: f"drop a quick pattern on the {t} track",
    lambda t: f"start a simple pattern on {t}",
    lambda t: f"can you write a pattern for the {t}",
    lambda t: f"come up with a quick pattern for {t}",
    lambda t: f"jot down a simple pattern on the {t} track",
    lambda t: f"lay a basic pattern into {t}",
    lambda t: f"whip up a quick pattern on {t}",
    lambda t: f"put together a short pattern for the {t} track",
    lambda t: f"write a little pattern into {t}",
    lambda t: f"sketch out a quick pattern on {t}",
    lambda t: f"draft a simple pattern for the {t} track",
    lambda t: f"knock out a quick pattern on {t}",
)
NAMED_TEMPLATES = (
    lambda t, notes: f"play these notes on the {t}: {notes}",
    lambda t, notes: f"put these notes on {t} — {notes}",
    lambda t, notes: f"play {notes} on the {t} track",
    lambda t, notes: f"write {notes} into {t}",
    lambda t, notes: f"lay {notes} down on the {t}",
    lambda t, notes: f"enter these notes on {t}: {notes}",
    lambda t, notes: f"add {notes} to the {t} track",
    lambda t, notes: f"key in {notes} on {t}",
    lambda t, notes: f"put {notes} onto {t}",
    lambda t, notes: f"play these on the {t}: {notes}",
    lambda t, notes: f"tap in {notes} on the {t} track",
    lambda t, notes: f"write these notes on {t}: {notes}",
    lambda t, notes: f"put in {notes} for the {t}",
    lambda t, notes: f"enter {notes} into the {t} track",
    lambda t, notes: f"play {notes} into {t} for me",
    lambda t, notes: f"lay these notes into {t}: {notes}",
    lambda t, notes: f"key {notes} into the {t} track",
    lambda t, notes: f"add these notes to {t}: {notes}",
    lambda t, notes: f"drop {notes} into the {t} track",
    lambda t, notes: f"play {notes} on {t}",
)
assert len(ABSTRACT_TEMPLATES) + len(NAMED_TEMPLATES) == TARGET_ROWS


def build_notes(root: int, steps: tuple[int, ...], count: int, i: int) -> list[dict]:
    """count notes walking `steps` from `root`, back-to-back in beats. Deterministic
    in (root, steps, count, i) only — no RNG, no clock."""
    notes = []
    t = 0.0
    for k in range(count):
        step = steps[k % len(steps)]
        octave_bump = 12 * (k // len(steps))
        pitch = max(0, min(127, root + step + octave_bump))
        length = 0.5 if (i + k) % 3 == 0 else 1.0
        velocity = 70 + ((i * 7 + k * 11) % 45)  # 70..114
        notes.append({"pitch": pitch, "start": t, "length": length, "velocity": velocity})
        t += length
    return notes


def build_row(commands: list[Command], add_note: Command, i: int) -> dict:
    track_name, root = TRACKS[i % len(TRACKS)]
    track_id = str(4000 + i * 10)
    clip_id = str(4000 + i * 10 + 1)
    count = 3 + (i % 4)  # 3..6 notes
    steps = MAJOR_STEPS if i % 2 == 0 else ARPEGGIO_STEPS
    notes = build_notes(root, steps, count, i)

    if i < len(ABSTRACT_TEMPLATES):
        user = ABSTRACT_TEMPLATES[i](track_name)
    else:
        note_names = ", ".join(pitch_name(n["pitch"]) for n in notes)
        user = NAMED_TEMPLATES[i - len(ABSTRACT_TEMPLATES)](track_name, note_names)

    commands_out = [
        {"command": add_note.name, "args": {
            "clipId": clip_id,
            "pitch": n["pitch"],
            "start": n["start"],
            "length": n["length"],
            "velocity": n["velocity"],
        }}
        for n in notes
    ]
    assistant = json.dumps({"intent": "ACK_GOT_IT", "commands": commands_out}, separators=(",", ":"))
    system = build_system_prompt(commands, track_id, track_name, clip_id)
    return {"messages": [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
        {"role": "assistant", "content": assistant},
    ]}


def build_rows(n: int = TARGET_ROWS) -> list[dict]:
    if n != TARGET_ROWS:
        raise ValueError(f"this builder's 40 templates are 1:1 with rows — got n={n}, expected {TARGET_ROWS}")
    commands = parse_agent_commands()
    add_note = find_command(commands, "add_note")
    find_command(commands, "add_drum_pattern")  # sanity: the command we're steering AWAY from still exists in-catalog
    return [build_row(commands, add_note, i) for i in range(n)]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="output JSONL path")
    ap.add_argument("--n", type=int, default=TARGET_ROWS)
    ap.add_argument("--check", action="store_true", help="build + validate only, don't write")
    args = ap.parse_args()

    rows = build_rows(args.n)
    if args.check:
        print(f"add_note_corrective: {len(rows)} row(s) validated OK (not written)")
        return 0

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"add_note_corrective: wrote {len(rows)} row(s) -> {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
