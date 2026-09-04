#!/usr/bin/env python3
"""mdsl_to_moshops.py — W2.7 (produce lane, quality-pivot 2026-09): convert a Monster
DSL (MDSL) beat — the flywheel's corrected-reference format,
~/AbletonMONSTER/monster/dsl/{spec,parser}.py define the grammar — into the loop-reply
JSON shape the agent loop consumes (ui/src/agent/loop/parse.ts's LoopReply:
{status, plan: [{goal, commands}], ...}).

WHY this exists: the corrected reference beat
(~/AbletonMONSTER/flywheel-data/corrections/mac_r0_001_fix.mdsl, 148 bpm / D minor,
section A bars 1-4 + section B bars 5-8) is real, owner-corrected musical data — the
closest thing to ground truth this program has. Replaying it verbatim through Mosh
(golden fixture) proves the loop→preflight→add_midi_clip path end to end with NO
brain call at all, and gives producePrompt.ts a genuine few-shot example instead of a
hand-written one. See docs/POSTMORTEM-2026-09.md's quality-loop contract: real
corrected data over synthetic proxies.

Grammar this converter targets (this file's dialect specifically — NOT the full MDSL
spec, which also has harmony/FX-chain/section-relative-bar forms this reference does not
use):
  S <bpm> <key>                      — one line, tempo + key
  A <startBar>-<endBar> / B <range>   — section headers; IGNORED for beat math, because
                                         this reference file's N lines already carry
                                         GLOBAL bar numbers (section B's notes read
                                         "5.0", "6.2", ... — not "1.0" relative to its
                                         own start), so the (bar-1)*4 + step/4 formula
                                         below needs no per-section offset.
  T:<type> <sound_id>                — a track header; type ∈ {808, syn, kick, snr,
                                         clp, hat, prc}; the NEXT N line(s) belong to it.
  N <entries, "|"-separated>          — one event per entry:
                                         melodic (808/syn): "bar.step[e] pitch vel dur"
                                         drum   (kick/snr/clp/hat/prc): "bar.step vel"
  # ...                               — comment line, ignored.

Beat math (verified against spec.py's bar_step_to_beats/parse_step_token):
  beat  = (bar - 1) * 4 + step / 4        (step is 0-15, one 16th-note grid)
  'e' suffix on the step token adds +0.125 beat (a 32nd-note nudge — equivalent to
    treating the step as step+0.5 before the /4, spec.py's parse_step_token shape)
  melodic note length = dur * 0.25 beats  (dur is in 16th-note units)
  drum note length     = 0.25 beats, FIXED (a drum hit has no MDSL duration field)
  pitch names are scientific, C4 = MIDI 60 (spec.py note_name_to_midi, reimplemented
    here standalone so this script has no dependency on ~/AbletonMONSTER — that repo is
    outside this one and not a build dependency)

Track collapsing (matches ui/src/agent/loop/drumPalette.ts's W2.3 design: ONE drum
track, ten fixed pads, one add_midi_clip for the whole part — "the reference's single
Drum Rack"):
  • Every kick/snr/clp/hat/prc block, from EITHER section, folds into a single "drums"
    output track. Its sound_id selects a FIXED pad note via SOUND_ID_TO_PAD (the same
    map ui/src/agent/loop/drumPalette.ts's lane table uses) — the sound_id itself never
    reaches Mosh; only the pad note does.
  • Every T:808 block, from either section (even though section A/B use DIFFERENT
    808 sound_ids, "808_spice" vs "sexy_drill" — the sound doesn't matter here, only the
    pitch data does), folds into a single "808" output track. Pitches are NOT
    transposed — D4..Bb4 (MIDI 62-70) rides straight through, matching
    ui/src/agent/producePrompt.ts's "808 RULES: 62-70 only" octave convention.
  • Every T:syn block's sound_id (lead, chords_pad, drone, counter, arp, ambient, stab)
    IS ALREADY one of Mosh's 7 synth-track placeholder names — no remapping table
    needed, the block folds directly into the like-named output track.

Output (a) — the full 9-track, 8-bar program: `main()`'s default writes
ui/src/agent/__fixtures__/mac_r0_001_fix.program.json, a golden fixture a scripted-brain
loop test can replay verbatim (the "sound-matched" render without a brain).
Output (b) — PRODUCE_FEWSHOT: a small excerpt (808 + stab + the T:hat pads only, section
A / bars 1-4 only) at ui/src/agent/__fixtures__/produce_fewshot.txt, ≤ 2.5 kB, meant to
be embedded as a literal few-shot example inside producePrompt.ts (wiring is OUT of this
script's scope — it only emits the file).

stdlib only, network-free, runnable as `python3 mdsl_to_moshops.py` (repo convention:
service/**/*_test.py is auto-discovered by the gate's py_tests; this script's own test is
service/prompt/mdsl_to_moshops_test.py).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Constants (mirror ~/AbletonMONSTER/monster/dsl/spec.py; reimplemented standalone —
# see module docstring)
# ---------------------------------------------------------------------------

DEFAULT_MDSL = (
    Path.home() / "AbletonMONSTER" / "flywheel-data" / "corrections" / "mac_r0_001_fix.mdsl"
)
DEFAULT_PROGRAM_OUT = (
    Path(__file__).resolve().parents[2]
    / "ui" / "src" / "agent" / "__fixtures__" / "mac_r0_001_fix.program.json"
)
DEFAULT_FEWSHOT_OUT = (
    Path(__file__).resolve().parents[2]
    / "ui" / "src" / "agent" / "__fixtures__" / "produce_fewshot.txt"
)

DRUM_TYPES = frozenset({"kick", "snr", "clp", "hat", "prc"})
MELODIC_TYPES = frozenset({"808", "syn"})

# sound_id -> fixed drum-rack pad note. Identical to ui/src/agent/loop/drumPalette.ts's
# W2.3 lane map (36 kick / 38 snare / 37 snare2 / 39 clap / 40 clap2 / 42 hat /
# 46 openhat / 41 perc / 43 fx / 44 roll) — the sound_id itself is discarded, only the
# pad it lands on matters to Mosh.
SOUND_ID_TO_PAD: dict[str, int] = {
    "jers_kick": 36,
    "light_snare": 38,
    "mem_snare": 37,
    "law_clap": 39,
    "igdk_clap": 40,
    "hatime_hhat": 42,
    "tred_ohat": 46,
    "bestsnap_perc": 41,
    "scratch_fx": 43,
    "omg_snare": 44,
}

# Fixed display/emit order for the full program — matches the file's own per-section
# track order (drums first since it is the percussive backbone, then 808, then the 7
# synth parts in the order they first appear in the MDSL).
TRACK_ORDER = ["drums", "808", "lead", "chords_pad", "drone", "counter", "arp", "ambient", "stab"]

TRACK_GOALS: dict[str, str] = {
    "drums": "Lay the full drum pattern (kick, snare, clap, hat, perc, fx, roll) across all 8 bars in one clip.",
    "808": "Lay the sustained 808 bassline (62-70) across all 8 bars, following the progression.",
    "lead": "Lay the lead melody across all 8 bars.",
    "chords_pad": "Lay the chord-pad voicings across all 8 bars.",
    "drone": "Lay the sustained drone notes across all 8 bars.",
    "counter": "Lay the counter-melody across all 8 bars.",
    "arp": "Lay the arpeggio pattern across all 8 bars.",
    "ambient": "Lay the sparse ambient accents across all 8 bars.",
    "stab": "Lay the rhythmic stabs across all 8 bars.",
}

STEPS_PER_BAR = 16

_NOTE_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
_SHARP_TO_FLAT = {"C#": "Db", "D#": "Eb", "F#": "Gb", "G#": "Ab", "A#": "Bb"}
_NOTE_RE = re.compile(r"^([A-Ga-g][b#]?)(-?\d+)$")


def note_name_to_midi(name: str) -> int:
    """Scientific pitch name -> MIDI number, C4 = 60 (matches spec.py's
    note_name_to_midi, reimplemented standalone so this script has no dependency on
    ~/AbletonMONSTER, which is outside this repo)."""
    m = _NOTE_RE.match(name)
    if not m:
        raise ValueError(f"invalid note name: {name!r}")
    letter = m.group(1).capitalize()
    if letter.endswith("#"):
        letter = letter[0] + "#"
    letter = _SHARP_TO_FLAT.get(letter, letter)
    octave = int(m.group(2))
    try:
        semitone = _NOTE_NAMES.index(letter)
    except ValueError:
        raise ValueError(f"unknown pitch class: {letter!r}") from None
    return (octave + 1) * 12 + semitone


_BAR_STEP_RE = re.compile(r"^(\d+)\.(\d+)(e)?$")


def parse_bar_step(token: str) -> tuple[int, float, bool]:
    """"1.10" -> (1, 10, False); "2.7e" -> (2, 7, True)."""
    m = _BAR_STEP_RE.match(token)
    if not m:
        raise ValueError(f"invalid bar.step token: {token!r}")
    return int(m.group(1)), float(m.group(2)), m.group(3) == "e"


def bar_step_to_beat(bar: int, step: float, has_e: bool) -> float:
    """beat = (bar-1)*4 + step/4, plus 0.125 for the 'e' (32nd-note) suffix."""
    beat = (bar - 1) * 4 + step / 4
    if has_e:
        beat += 0.125
    return beat


def beats_to_seconds(beats: float, bpm: float) -> float:
    return beats * (60.0 / bpm)


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


@dataclass
class MdslNote:
    bar: int
    step: float
    has_e: bool
    vel: int
    pitch: Optional[str] = None   # None for drum hits
    dur: Optional[int] = None     # 16ths; None for drum hits


@dataclass
class MdslBlock:
    track_type: str      # "808" | "syn" | "kick" | "snr" | "clp" | "hat" | "prc"
    sound_id: str
    notes: list[MdslNote] = field(default_factory=list)


@dataclass
class MdslSession:
    bpm: int
    key: str
    blocks: list[MdslBlock]


_S_LINE_RE = re.compile(r"^S\s+(\d+)\s+(\S+)\s*$")
_T_LINE_RE = re.compile(r"^T:(\w+)\s+(\S+)\s*$")


def _parse_melodic_entry(entry: str) -> MdslNote:
    # "1.0 D4 95 6" (bar.step[e] pitch vel dur)
    parts = entry.split()
    if len(parts) != 4:
        raise ValueError(f"malformed melodic N entry: {entry!r}")
    bar, step, has_e = parse_bar_step(parts[0])
    return MdslNote(bar=bar, step=step, has_e=has_e, pitch=parts[1], vel=int(parts[2]), dur=int(parts[3]))


def _parse_drum_entry(entry: str) -> MdslNote:
    # "1.0 118" (bar.step vel)
    parts = entry.split()
    if len(parts) != 2:
        raise ValueError(f"malformed drum N entry: {entry!r}")
    bar, step, has_e = parse_bar_step(parts[0])
    return MdslNote(bar=bar, step=step, has_e=has_e, vel=int(parts[1]))


def parse_mdsl(text: str) -> MdslSession:
    bpm: Optional[int] = None
    key: Optional[str] = None
    blocks: list[MdslBlock] = []
    current: Optional[MdslBlock] = None

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line[0] in "AB" and line[1:2] in (" ",) :
            # Section header ("A 1-4" / "B 5-8") — see module docstring: this dialect's
            # N lines already carry global bar numbers, so no offset bookkeeping needed.
            continue
        m_s = _S_LINE_RE.match(line)
        if m_s:
            bpm, key = int(m_s.group(1)), m_s.group(2)
            continue
        m_t = _T_LINE_RE.match(line)
        if m_t:
            current = MdslBlock(track_type=m_t.group(1), sound_id=m_t.group(2))
            blocks.append(current)
            continue
        if line.startswith("N "):
            if current is None:
                raise ValueError(f"N line with no preceding T: block: {line!r}")
            entries = [e.strip() for e in line[2:].split("|") if e.strip()]
            is_drum = current.track_type in DRUM_TYPES
            for entry in entries:
                note = _parse_drum_entry(entry) if is_drum else _parse_melodic_entry(entry)
                current.notes.append(note)
            continue
        raise ValueError(f"unrecognized MDSL line: {line!r}")

    if bpm is None or key is None:
        raise ValueError("MDSL text has no S <bpm> <key> line")
    return MdslSession(bpm=bpm, key=key, blocks=blocks)


# ---------------------------------------------------------------------------
# Conversion: MdslSession -> Mosh notes, grouped by output track
# ---------------------------------------------------------------------------


def _target_track(block: MdslBlock) -> str:
    if block.track_type == "808":
        return "808"
    if block.track_type == "syn":
        return block.sound_id
    if block.track_type in DRUM_TYPES:
        return "drums"
    raise ValueError(f"unknown MDSL track type: {block.track_type!r}")


def collect_track_notes(
    session: MdslSession,
    *,
    max_bar: Optional[int] = None,
    tracks: Optional[set] = None,
    drum_pads: Optional[set] = None,
) -> dict[str, list[dict]]:
    """Fold every block into its output track's note list (Mosh shape:
    {pitch, start, length, velocity}, start/length in BEATS). `max_bar` restricts to
    bars <= max_bar (inclusive; for the few-shot's section-A-only excerpt); `tracks`
    restricts to a track-name subset; `drum_pads` restricts the "drums" track's pad
    numbers to a subset (for the few-shot's "hat lane only")."""
    out: dict[str, list[dict]] = {}
    for block in session.blocks:
        track = _target_track(block)
        if tracks is not None and track not in tracks:
            continue
        is_drum = block.track_type in DRUM_TYPES
        for note in block.notes:
            if max_bar is not None and note.bar > max_bar:
                continue
            start = bar_step_to_beat(note.bar, note.step, note.has_e)
            if is_drum:
                pad = SOUND_ID_TO_PAD.get(block.sound_id)
                if pad is None:
                    raise ValueError(f"no pad mapping for drum sound_id: {block.sound_id!r}")
                if drum_pads is not None and pad not in drum_pads:
                    continue
                out.setdefault(track, []).append(
                    {"pitch": pad, "start": round(start, 6), "length": 0.25, "velocity": note.vel}
                )
            else:
                assert note.pitch is not None and note.dur is not None
                out.setdefault(track, []).append(
                    {
                        "pitch": note_name_to_midi(note.pitch),
                        "start": round(start, 6),
                        "length": round(note.dur * 0.25, 6),
                        "velocity": note.vel,
                    }
                )
    for track_notes in out.values():
        track_notes.sort(key=lambda n: (n["start"], n["pitch"]))
    return out


def build_program(
    session: MdslSession,
    *,
    total_bars: int = 8,
    max_bar: Optional[int] = None,
    tracks: Optional[set] = None,
    drum_pads: Optional[set] = None,
    say: Optional[str] = None,
    goal_overrides: Optional[dict[str, str]] = None,
) -> dict:
    """Build the loop-reply JSON (ui/src/agent/loop/parse.ts's LoopReply shape):
    {status, intent, say, plan: [{goal, commands: [{command: "add_midi_clip", args}]}]}.
    One plan step per output track, one add_midi_clip command per step (W2.1 design:
    the drum part — and every other part here — is ONE add_midi_clip per track)."""
    by_track = collect_track_notes(session, max_bar=max_bar, tracks=tracks, drum_pads=drum_pads)
    clip_bars = max_bar if max_bar is not None else total_bars
    clip_beats = clip_bars * 4
    clip_seconds = round(beats_to_seconds(clip_beats, session.bpm), 6)
    goals = {**TRACK_GOALS, **(goal_overrides or {})}

    plan = []
    for track in TRACK_ORDER:
        if track not in by_track:
            continue
        notes = by_track[track]
        plan.append(
            {
                "goal": goals.get(track, f"Lay the {track} part."),
                "commands": [
                    {
                        "command": "add_midi_clip",
                        "args": {
                            "trackId": "${" + track + "}",
                            "start": 0,
                            "length": clip_seconds,
                            "notes": notes,
                        },
                    }
                ],
            }
        )

    return {
        "intent": "produce",
        "say": say or f"Laid {len(plan)} track(s) from the corrected reference beat ({session.bpm} bpm, {session.key}).",
        "status": "done",
        "plan": plan,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--input", default=str(DEFAULT_MDSL), help="source .mdsl file")
    p.add_argument("--out-program", default=str(DEFAULT_PROGRAM_OUT), help="full-program JSON output path")
    p.add_argument("--out-fewshot", default=str(DEFAULT_FEWSHOT_OUT), help="few-shot excerpt output path")
    p.add_argument("--skip-fewshot", action="store_true")
    p.add_argument("--skip-program", action="store_true")
    args = p.parse_args(argv)

    src = Path(args.input)
    if not src.is_file():
        print(f"mdsl_to_moshops: input not found: {src}", file=sys.stderr)
        return 1

    session = parse_mdsl(src.read_text(encoding="utf-8"))

    if not args.skip_program:
        program = build_program(session, total_bars=8)
        out_program = Path(args.out_program)
        out_program.parent.mkdir(parents=True, exist_ok=True)
        out_program.write_text(json.dumps(program, indent=2) + "\n", encoding="utf-8")
        note_counts = {step["goal"]: len(step["commands"][0]["args"]["notes"]) for step in program["plan"]}
        print(f"mdsl_to_moshops: wrote {out_program} ({len(program['plan'])} tracks)")
        for goal, n in note_counts.items():
            print(f"  {n:3d} notes — {goal}")

    if not args.skip_fewshot:
        # Bars 1-2 only (half of section A) + compact (no-indent) JSON: the full 4-bar
        # section A across all three lanes runs ~4.5 kB even without indentation, well
        # past the ≤2.5 kB budget for a system-prompt few-shot — this excerpt is
        # deliberately SHORT, illustrating the shape (plan/goal/commands/add_midi_clip/
        # notes) and the octave/velocity/timing conventions, not the whole part.
        fewshot = build_program(
            session,
            total_bars=8,
            max_bar=2,
            tracks={"808", "stab", "drums"},
            drum_pads={42, 46},  # T:hat pads only (hatime_hhat, tred_ohat)
            say="Example (bars 1-2 of a 148 bpm D minor trap beat): 808, stab and hat.",
            goal_overrides={
                "drums": "Lay the hat pattern for bars 1-2 (pads 42/46 only, in this excerpt).",
                "808": "Lay the 808 bassline for bars 1-2 (62-70 range).",
                "stab": "Lay the stab hits for bars 1-2.",
            },
        )
        text = json.dumps(fewshot, separators=(",", ":")) + "\n"
        out_fewshot = Path(args.out_fewshot)
        out_fewshot.parent.mkdir(parents=True, exist_ok=True)
        out_fewshot.write_text(text, encoding="utf-8")
        size = len(text.encode("utf-8"))
        print(f"mdsl_to_moshops: wrote {out_fewshot} ({size} bytes){' — OVER 2.5kB BUDGET' if size > 2560 else ''}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
