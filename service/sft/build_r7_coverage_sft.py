#!/usr/bin/env python3
"""r6-sft-data-pass: targeted SFT coverage rows for the novice-jam bench misses
(drum-kit flows, lyric multi-step follow-through, ambiguity defer, dosage).

WHY (see the task's own framing, and service/sft/R6_COVERAGE_PREP_NOTE.md for the
full writeup): the r5 novice-jam bench (docs/agent-bench/scoreboard.p3-novice-jam-r5.md
on origin/claude/novice-jam-probe) found three coverage gaps, and
SFT_COVERAGE_MATRIX.md independently confirms the root cause for the drum-kit one —
`add_drum_pattern` is a Bucket-C command (added 2026-07-10, AFTER s2-mix-v5 was
frozen) with **zero training rows**. This file is new, additive training data for
those gaps.

IMPORTANT — this is explicitly NOT r6 data. R6_TRAINING_PLAN.md §2.1 freezes
s2-mix-v5 verbatim ("r6 changes base precision only, not the mix... No new rows
added this cycle") specifically so a passing/failing r6 gate isolates the
precision change, not a data change. Folding this file into s2-mix-v5 or training
a3b-r6 on it would violate that pre-registration. See R6_COVERAGE_PREP_NOTE.md.

Every row is built from a single ENGINE-VERIFIED fixture — the same one
service/sft/assist_fixtures/ already uses for assist_demonstrations.jsonl — and the
EXACT byte-identical `system` field already committed in that file's rows (same
`buildSystemPrompt(DEFAULT_RULES, fixture_snap.json)` render). No TypeScript is
executed here (ground rule 5: Python only, reading TS for validation) — the system
prompt is loaded from the already-TS-rendered committed file, not re-derived by hand.

Every row is passed through validate_sft_rows.validate_row (the real catalog +
drum-pattern-DSL + reply-contract + id + dosage checks) before being written; the
script HARD-FAILS (raises) on the first invalid row rather than silently dropping
it — these are hand-authored gold rows, not probabilistic synthesis, so an invalid
one is a bug in this script, not an expected noise rate.

Usage:
    python3 build_r7_coverage_sft.py
      -> writes service/sft/r7_coverage_demonstrations.jsonl
      -> writes service/sft/r7_coverage_demonstrations.manifest.json
"""
from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sft_catalog import load_catalog, load_intents  # noqa: E402
from validate_sft_rows import DEFAULT_KNOWN_IDS, validate_row  # noqa: E402

SCRIPT_DIR = Path(__file__).resolve().parent
ASSIST_DEMOS = SCRIPT_DIR / "assist_demonstrations.jsonl"
ROLES_PATH = SCRIPT_DIR / "assist_fixtures" / "fixture_roles.json"
OUT_PATH = SCRIPT_DIR / "r7_coverage_demonstrations.jsonl"
MANIFEST_PATH = SCRIPT_DIR / "r7_coverage_demonstrations.manifest.json"

ROLES: dict[str, str] = json.loads(ROLES_PATH.read_text(encoding="utf-8"))
DRUM_T, DRUM_C = ROLES["DRUM_T"], ROLES["DRUM_C"]
BASS_T, BASS_C = ROLES["BASS_T"], ROLES["BASS_C"]
MEL_T, MEL_C = ROLES["MEL_T"], ROLES["MEL_C"]
VOX_T, VOX_C = ROLES["VOX_T"], ROLES["VOX_C"]

# The EXACT production-rendered system prompt already committed in
# assist_demonstrations.jsonl (row 0; verified identical across all 35 rows by
# service/sft/validate_system_prompt_drift.py). Reused verbatim rather than
# hand-approximated. See R6_COVERAGE_PREP_NOTE.md "Prompt-shape drift found" for
# why this is flagged as KNOWN-STALE relative to the current commands.ts HEAD, and
# why that staleness does not block authoring (it must be refreshed before any real
# merge, but re-rendering here would require running TypeScript, out of scope for
# this Python-only pass).
_first_row = json.loads(ASSIST_DEMOS.read_text(encoding="utf-8").splitlines()[0])
SYSTEM = _first_row["messages"][0]["content"]


def row(user: str, intent: str, commands: list[dict] | None = None, say: str | None = None) -> dict:
    assistant: dict = {"intent": intent}
    if say is not None:
        assistant["say"] = say
    if commands is not None:
        assistant["commands"] = commands
    return {
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": user},
            {"role": "assistant", "content": json.dumps(assistant)},
        ]
    }


def cmd(command: str, **args) -> dict:
    return {"command": command, "args": args}


# ─────────────────────────────────────────────────────────────────────────────
# DRUM — beat from nothing: ONE command (add_drum_pattern with no trackId/clipId
# auto-creates its own "Drums" track + sampler + kit — bridge.mock.ts:4165-4177).
# This is the minimal, correct, non-duplicated flow the bench's misses lacked.
# ─────────────────────────────────────────────────────────────────────────────
def _pat(total: int, hits: tuple[int, ...] = (), accents: tuple[int, ...] = ()) -> str:
    """Build an exact-length step string: 'X' at accent indices, 'x' at plain hit
    indices, '.' elsewhere. Eliminates hand-counted dot/x typos (the r6-sft-data
    -pass validator caught several of those on the first run of this script)."""
    chars = ["."] * total
    for i in hits:
        chars[i] = "x"
    for i in accents:
        chars[i] = "X"
    return "".join(chars)


def _lane(name: str, total: int, hits: tuple[int, ...] = (), accents: tuple[int, ...] = ()) -> str:
    return f"{name}: {_pat(total, hits, accents)}"


# 16-step-bar (default stepsPerBar=16) patterns, hit indices in [0, 15]:
FOUR_ON_FLOOR = "; ".join([_lane("kick", 16, (0, 4, 8, 12)), _lane("hat", 16, (0, 2, 4, 6, 8, 10, 12, 14))])
SPARSE = _lane("kick", 16, (0, 7))
HALFTIME = "; ".join([_lane("kick", 16, (0, 8)), _lane("snare", 16, (8,))])
BREAKBEAT = "; ".join([_lane("kick", 16, (0, 3, 6, 10), accents=(13,)), _lane("snare", 16, (4, 12), accents=(15,))])
DEMBOW = "; ".join([_lane("kick", 16, (0, 6, 9)), _lane("snare", 16, (2, 8, 11))])
BOUNCE = "; ".join([_lane("kick", 20, (0, 3, 7, 9, 13)), _lane("snare", 20, (4, 12))])  # 20-step bar (stepsPerBar=20)
BOOM_BAP = "; ".join([_lane("kick", 24, (0, 4, 7, 12, 17)), _lane("snare", 24, (4, 13))])  # 24-step bar
TRAP_HATS = "; ".join([
    _lane("kick", 32, (0, 8, 16, 24)),
    _lane("snare", 32, (8, 24)),
    _lane("hat", 32, tuple(range(0, 32, 2))),
])  # 32-step bar

BEAT_FROM_NOTHING: list[tuple[str, str, dict]] = [
    ("gimme a beat with some bounce", BOUNCE, {"stepsPerBar": 20}),
    ("lay down a groove for this", FOUR_ON_FLOOR, {}),
    ("start me a basic beat", FOUR_ON_FLOOR, {}),
    ("give me a boom bap pattern", BOOM_BAP, {"stepsPerBar": 24}),
    ("put a four-on-the-floor kick going", FOUR_ON_FLOOR, {}),
    ("get some busy trap hi-hats going under this", TRAP_HATS, {"stepsPerBar": 32}),
    ("start a drum loop, keep it sparse", SPARSE, {}),
    ("sketch out a beat for me", FOUR_ON_FLOOR, {}),
    ("kick something off with drums", FOUR_ON_FLOOR, {}),
    ("throw a simple beat under this", BOUNCE, {"stepsPerBar": 20}),
    ("get some drums going, nothing fancy", SPARSE, {}),
    ("give the track a pulse", FOUR_ON_FLOOR, {}),
    ("lay a half-time beat down", HALFTIME, {}),
    ("give me a breakbeat-style pattern with some accents", BREAKBEAT, {}),
    ("start a groove with a dembow-ish feel", DEMBOW, {}),
    ("I want some drums, keep it bouncy", BOUNCE, {"stepsPerBar": 20}),
    ("put a beat under this, something with swing to it", BOOM_BAP, {"stepsPerBar": 24}),
    ("get a drum pattern going, minimal is fine", SPARSE, {}),
    ("start a beat, half-time feel", HALFTIME, {}),
    ("lay down some drums with a bounce to them", BOUNCE, {"stepsPerBar": 20}),
]

# ─────────────────────────────────────────────────────────────────────────────
# DRUM — add on top of EXISTING drums (clipId=DRUM_C — the fixture's existing
# kick(36)/snare(38)/hat(42) clip). add_drum_pattern with clipId replaces ONLY the
# named lane(s), leaving the rest untouched (bridge.mock.ts:4154-4163) — the exact
# minimal, non-destructive move the bench's "add some hats on top" case needed.
# ─────────────────────────────────────────────────────────────────────────────
ADD_TO_EXISTING: list[tuple[str, str]] = [
    ("add a crash for the drop", "crash: x..............."),
    ("throw a clap on the backbeat", "clap: ....x.......x..."),
    ("add an open hat on the offbeats", "openhat: .x.x.x.x.x.x.x.x"),
    ("layer a low tom fill in there", "lowtom: ............x.x."),
    ("add a mid tom hit on the last beat", "midtom: ............x..."),
    ("give the hats some more movement, busier", "hat: x.x.xxx.x.x.xxx."),
    ("double up the snare with a clap layer", "clap: ....x.......x..."),
    ("put a rim shot in on the and-of-2", "37: ......x........."),
    ("add a crash to kick off the section", "crash: x..............."),
    ("bring in an open hat for texture", "openhat: ....x.......x..."),
    ("add some low tom hits under the fill", "lowtom: ..............x."),
    ("throw a clap on top of the snare hits", "clap: ....x.......x..."),
    ("give it a crash on beat one", "crash: x..............."),
    ("add a tom fill at the end of the bar", "midtom: ..............x."),
]

# ─────────────────────────────────────────────────────────────────────────────
# DRUM — track-only asks (no pattern content requested yet). create_track with
# type "drum" ALREADY auto-loads the sampler + kit (bridge.mock.ts:1486-1503,
# commands.ts desc) — load_drum_kit afterward would be a redundant second command,
# exactly the kind of dosage bug the task flags.
# ─────────────────────────────────────────────────────────────────────────────
TRACK_ONLY: list[tuple[str, str | None]] = [
    ("just get me a drum track going, I'll fill it in later", None),
    ("add an empty drums track", None),
    ("set up a drum track for me", None),
    ("start a drums track called Beat Ideas", "Beat Ideas"),
    ("add a new drum track named Percussion", "Percussion"),
]

# ─────────────────────────────────────────────────────────────────────────────
# DRUM — kit swap on an EXISTING drum track (DRUM_T already has a sampler from the
# fixture; load_drum_kit re-loads a different kit onto it).
# ─────────────────────────────────────────────────────────────────────────────
KIT_SWAP: list[tuple[str, str | None]] = [
    ("swap in a different drum kit", None),
    ("load the 808 kit onto the drums", "808"),
    ("change the drum kit to something acoustic", "acoustic"),
    ("give the drums a different kit", None),
    ("load a trap kit on the drum track", "trap"),
]

# ─────────────────────────────────────────────────────────────────────────────
# CONTRAST — melodic/bass asks that must NOT touch any drum command. Uses the
# fixture's EXISTING bass/melody MIDI clips (BASS_C/MEL_C, both already 4 beats
# long) — add_note only, in-key, no create_track/load_drum_kit/add_drum_pattern.
# This is the negative-space half of the drum-domain gap ("under-knows... when
# NOT to reach for drums").
# ─────────────────────────────────────────────────────────────────────────────
# A minimal be A-minor bass line (root-heavy, in key): A2(45) C3(48) E3(52) A2(45)
CONTRAST_MELODIC: list[tuple[str, str, list[tuple[int, float, float, int]]]] = [
    ("lay down a simple bassline in A minor", BASS_C, [(45, 0.0, 1.0, 95), (48, 1.0, 1.0, 90), (52, 2.0, 1.0, 90), (45, 3.0, 1.0, 95)]),
    ("write a basic bass groove under this", BASS_C, [(45, 0.0, 0.5, 95), (45, 1.0, 0.5, 85), (48, 2.0, 0.5, 90), (52, 3.0, 0.5, 90)]),
    ("give me a walking bassline through the section", BASS_C, [(45, 0.0, 1.0, 90), (48, 1.0, 1.0, 90), (50, 2.0, 1.0, 90), (52, 3.0, 1.0, 90)]),
    ("add a simple bass part for the bridge", BASS_C, [(45, 0.0, 2.0, 90), (48, 2.0, 2.0, 90)]),
    ("write a bass pattern that follows the root notes", BASS_C, [(45, 0.0, 1.0, 95), (45, 1.0, 1.0, 90), (48, 2.0, 1.0, 90), (45, 3.0, 1.0, 90)]),
    ("add a countermelody up top", MEL_C, [(69, 0.0, 1.0, 80), (72, 1.0, 1.0, 80), (71, 2.0, 1.0, 80), (69, 3.0, 1.0, 80)]),
    ("write a melodic hook idea", MEL_C, [(72, 0.0, 0.5, 90), (76, 0.5, 0.5, 85), (79, 1.0, 1.0, 90), (76, 2.0, 1.0, 85)]),
    ("give the melody a little answer phrase", MEL_C, [(72, 0.0, 1.0, 85), (69, 1.0, 1.0, 80)]),
    ("add a lead line over the chords", MEL_C, [(72, 0.0, 1.0, 85), (74, 1.0, 1.0, 85), (76, 2.0, 1.0, 85), (77, 3.0, 1.0, 85)]),
    ("sketch a short melodic idea for the intro", MEL_C, [(69, 0.0, 2.0, 80), (72, 2.0, 2.0, 80)]),
    ("give the bass some movement, not just root notes", BASS_C, [(45, 0.0, 0.5, 90), (48, 0.5, 0.5, 85), (50, 1.0, 0.5, 85), (52, 1.5, 0.5, 85)]),
    ("write a two-bar melodic phrase up top", MEL_C, [(72, 0.0, 1.0, 85), (71, 1.0, 1.0, 80), (69, 2.0, 2.0, 80)]),
]

# ─────────────────────────────────────────────────────────────────────────────
# LYRICS — sheet + immediate line follow-through. The bench's exact miss: model
# stopped after create_lyric_sheet with no set_lyric_constraint/set_lyric_line.
# VOX_T has no sheet in the fixture, so create_lyric_sheet is always legal first.
# ─────────────────────────────────────────────────────────────────────────────
LYRIC_SHEET_PLUS_LINE: list[tuple[str, str, str, str, str]] = [
    # (ask, topic, mood, role, seedText for line 0)
    ("help me start some lyrics for the hook about missing someone", "missing someone", "wistful", "hook", "___ ___ ___ ___"),
    ("start the vocal lyrics — the topic is heartbreak", "heartbreak", "", "verse", "___ ___ ___"),
    ("give the hook a topic of longing and open with something", "longing", "yearning", "hook", "___ ___ ___ ___"),
    ("set up lyrics for the verse, moody tone", "", "moody", "verse", "___ ___ ___"),
    ("start a lyric sheet, we're writing about summer nights", "summer nights", "warm", "verse", "___ ___ ___ ___"),
    ("kick off the lyrics — hook about letting go", "letting go", "bittersweet", "hook", "___ ___ ___"),
    ("start the hook lyrics, topic is coming home", "coming home", "hopeful", "hook", "___ ___ ___ ___"),
    ("begin the lyrics for the bridge, keep it vulnerable", "", "vulnerable", "bridge", "___ ___ ___"),
    ("write me an opening line for a verse about the city at night", "the city at night", "moody", "verse", "___ ___ ___ ___"),
    ("start the hook, we're going for a defiant feel", "", "defiant", "hook", "___ ___ ___"),
    ("give me lyrics for the vocal, topic's new beginnings", "new beginnings", "hopeful", "verse", "___ ___ ___ ___"),
    ("start writing the hook — theme is being unstoppable", "being unstoppable", "confident", "hook", "___ ___ ___"),
    ("get the lyrics going for the bridge, topic is regret", "regret", "regretful", "bridge", "___ ___ ___ ___"),
    ("start the vocal, topic's chasing a dream", "chasing a dream", "hopeful", "verse", "___ ___ ___"),
]

# ─────────────────────────────────────────────────────────────────────────────
# LYRICS — exact-text opening-line placement. gold must preserve the QUOTED text
# byte-for-byte in set_lyric_line's `text` arg (gold-args-faithful convention).
# ─────────────────────────────────────────────────────────────────────────────
LYRIC_EXACT_OPENING: list[tuple[str, str, str]] = [
    ("put 'nobody said forever' as the opening line", "nobody said forever", "hook"),
    ("make \"i've been holding on too long\" the first line of the hook", "i've been holding on too long", "hook"),
    ("start it off with 'we were never meant to last'", "we were never meant to last", "verse"),
    ("open the verse with 'streetlights fading into blue'", "streetlights fading into blue", "verse"),
    ("make 'this is where the story ends' the opening line", "this is where the story ends", "hook"),
    ("start the hook with 'nothing left to say'", "nothing left to say", "hook"),
    ("open with 'i kept your name out of every song'", "i kept your name out of every song", "verse"),
    ("put 'we used to run these streets' as the first line", "we used to run these streets", "verse"),
    ("start the hook off with 'burning brighter than before'", "burning brighter than before", "hook"),
    ("make \"I'm not who I was last year\" the opening line", "I'm not who I was last year", "verse"),
]

# ─────────────────────────────────────────────────────────────────────────────
# LYRICS — full follow-through: sheet + constraint + TWO lines in one reply
# (create_lyric_sheet then two set_lyric_line calls, index 0 then 1 — legal
# because lines extend by one at a time and both target the same, already-real
# trackId; bridge.mock.ts:2032-2038 requires idx <= lines.length, so 0 then 1 in
# order is the only valid ordering — exactly what's authored below).
# ─────────────────────────────────────────────────────────────────────────────
LYRIC_FULL_FOLLOWTHROUGH: list[tuple[str, str, str, str, str, str]] = [
    # (ask, topic, explicit, line0 seed/role, line1 seed/role, mood)
    ("start the hook about missing someone, keep it clean, give me an opening line and a matching second line",
     "missing someone", "clean", "hook", "hook", "wistful"),
    ("write the verse — topic's heartbreak, keep it PG, I want the first two lines sketched out",
     "heartbreak", "clean", "verse", "verse", "sad"),
    ("start the bridge, topic is regret, nothing explicit, sketch the first two lines",
     "regret", "clean", "bridge", "bridge", "regretful"),
    ("kick off the hook about new beginnings, keep it clean, give me two opening lines",
     "new beginnings", "clean", "hook", "hook", "hopeful"),
    ("start the verse, topic's the city at night, mild language is fine, sketch two lines",
     "the city at night", "mild", "verse", "verse", "moody"),
    ("write the hook, theme is letting go, keep it clean, give me the first two lines",
     "letting go", "clean", "hook", "hook", "bittersweet"),
    ("start the lyrics, topic's chasing a dream, PG, sketch the opening two lines",
     "chasing a dream", "clean", "verse", "verse", "hopeful"),
    ("begin the hook about being unstoppable, mild language ok, two opening lines please",
     "being unstoppable", "mild", "hook", "hook", "confident"),
]

# ─────────────────────────────────────────────────────────────────────────────
# LYRICS — sheet-only, using create_lyric_sheet's OWN topic/mood/explicit args
# directly (no separate set_lyric_constraint needed — the single-command minimal
# path when only setup, not a line yet, is asked for).
# ─────────────────────────────────────────────────────────────────────────────
LYRIC_SHEET_ONLY: list[tuple[str, str, str, str]] = [
    ("set up lyrics for the vocal, mood should be hopeful and keep it clean", "", "hopeful", "clean"),
    ("start a lyric sheet, topic's summer nights, nothing explicit", "summer nights", "", "clean"),
    ("get the lyric sheet going, moody tone is fine to keep it real", "", "moody", "allow"),
    ("set up lyrics, topic's heartbreak, mild language is ok", "heartbreak", "", "mild"),
    ("start the lyric sheet for the vocal, defiant mood", "", "defiant", "allow"),
]

# ─────────────────────────────────────────────────────────────────────────────
# AMBIGUITY — defer-EMPTY. Taste-only asks with no concrete target: the exact
# named violation ("it feels empty in the middle" -> create_section instead of
# asking). Gold: intent HUH, `say` a short clarifying question, NO commands key.
# ─────────────────────────────────────────────────────────────────────────────
AMBIGUOUS_DEFER: list[tuple[str, str]] = [
    # NOTE (r7.1): this ask was previously the VERBATIM bench string for
    # nj-amb-empty-middle (test contamination — r7's 4/4 ambiguity read included
    # a memorized test item). Paraphrased; never mirror bench asks verbatim.
    ("the middle of the track feels kind of bare", "bare how — a new part, or more energy overall?"),
    ("something's missing in the middle section", "missing how — an instrument, or a whole new part?"),
    ("the chorus needs something", "needs what — more energy, a new sound, or something else?"),
    ("this part feels a little flat", "flat how — the mix, the arrangement, or the performance?"),
    ("I don't know, it just doesn't hit right", "what doesn't land — the drop, the vibe, something else?"),
    ("the drop could be better", "better how — bigger, punchier, or a different sound?"),
    ("it's missing something in the breakdown", "missing what kind of thing — rhythmic, melodic, textural?"),
    ("needs more energy somewhere in there", "where exactly — the chorus, the bridge, the drop?"),
    ("this section just isn't working", "not working how — the arrangement, the sound, the energy?"),
    ("it feels a bit boring right now", "boring how — the melody, the beat, the arrangement?"),
    ("I feel like something's off", "off in what way — the mix, the timing, the vibe?"),
    ("the vibe isn't quite there yet", "what would help — a different sound, more energy, something else?"),
]

# ─────────────────────────────────────────────────────────────────────────────
# NEAR-MISS — concrete enough to ACT (contrast against the defer bucket above:
# same "vague-sounding" surface shape, but the ask names a real, actionable
# target the model already has an id or exact numbers for).
# ─────────────────────────────────────────────────────────────────────────────
NEAR_MISS_ACTS: list[dict] = [
    row("add a pad-style layer over the melody", "ACK_GOT_IT", [
        cmd("add_note", clipId=MEL_C, pitch=64, start=0.0, length=4.0, velocity=60),
    ]),
    row("double the bass an octave up to fill it out", "ACK_GOT_IT", [
        cmd("add_note", clipId=BASS_C, pitch=57, start=0.0, length=1.0, velocity=80),
        cmd("add_note", clipId=BASS_C, pitch=60, start=1.0, length=1.0, velocity=80),
    ]),
    row("mark out a new part from bar 5 to bar 9", "ACK_GOT_IT", [
        cmd("create_section", name="New Part", startBeat=16, endBeat=32),
    ]),
    row("add a section for the bridge, bars 9 through 11", "ACK_GOT_IT", [
        cmd("create_section", name="Bridge", startBeat=32, endBeat=40),
    ]),
    row("give the melody clip a bit more length underneath — sustain it out", "ACK_GOT_IT", [
        cmd("add_note", clipId=MEL_C, pitch=67, start=0.0, length=4.0, velocity=55),
    ]),
    row("mute the bass for the first section, bars 1 to 3", "ACK_GOT_IT", [
        cmd("set_clip_mute", clipId=BASS_C, mute=True),
    ]),
    row("add a section marker called Hook from bar 5 to bar 9", "ACK_GOT_IT", [
        cmd("create_section", name="Hook", startBeat=16, endBeat=32),
    ]),
    row("lower the melody track a couple dB, it's poking out", "ACK_GOT_IT", [
        cmd("set_track_volume", trackId=MEL_T, db=-2),
    ]),
]

# ─────────────────────────────────────────────────────────────────────────────
# VIBE-TARGET ACTS (r7.1) — the calibration band the r7 defer bucket missed:
# a NAMED, mixable target + a qualitative direction but NO numbers. Doctrine
# (loopPrompt LOOP_RULES act-with-defaults): act once with a sensible default
# dose, don't ask. r7's gate wrong-defers ("drums slap harder" -> HUH) came
# from 12 vague->defer demos with ZERO act counterexamples in this phrasing
# space. Asks are paraphrases — NEVER verbatim bench strings.
# ─────────────────────────────────────────────────────────────────────────────
VIBE_TARGET_ACTS: list[dict] = [
    row("these drums are hitting too soft, beef them up", "ACK_GOT_IT", [
        cmd("set_track_volume", trackId=DRUM_T, db=3),
    ]),
    row("the beat feels weak under the chorus, push it", "ACK_GOT_IT", [
        cmd("set_track_volume", trackId=DRUM_T, db=2),
    ]),
    row("the vocals feel buried, lift them", "ACK_GOT_IT", [
        cmd("set_track_volume", trackId=VOX_T, db=2),
    ]),
    row("give the hook vocal a little more presence", "ACK_GOT_IT", [
        cmd("set_track_volume", trackId=VOX_T, db=2),
    ]),
    row("the bass is swallowing everything, rein it in", "ACK_GOT_IT", [
        cmd("set_track_volume", trackId=BASS_T, db=-3),
    ]),
    row("the lead line is drowning out the singer, tuck it back", "ACK_GOT_IT", [
        cmd("set_track_volume", trackId=MEL_T, db=-2),
    ]),
    row("melody could stand out a touch more", "ACK_GOT_IT", [
        cmd("set_track_volume", trackId=MEL_T, db=2),
    ]),
    # regret family: named action (revert), no numbers -> undo, never a defer
    row("ugh no, that was a mistake — take it back", "ACK_GOT_IT", [cmd("undo")]),
    row("scrap that last change", "ACK_GOT_IT", [cmd("undo")]),
    row("nope, put it back how it was", "ACK_GOT_IT", [cmd("undo")]),
    # repair family: decisive single-target correction, no mute-as-fix
    row("the bass clip is blowing out the speakers, tame it", "ACK_GOT_IT", [
        cmd("set_clip_gain", clipId=BASS_C, gainDb=-6),
        cmd("set_track_volume", trackId=BASS_T, db=-3),
    ]),
    row("drums are distorting, pull them down before it clips", "ACK_GOT_IT", [
        cmd("set_track_volume", trackId=DRUM_T, db=-4),
    ]),
]

# ─────────────────────────────────────────────────────────────────────────────
# DOSAGE — never emit `save` unless asked; contrastive pairs (asked -> save
# present; not asked -> save absent even though the request is otherwise similar).
# ─────────────────────────────────────────────────────────────────────────────
DOSAGE_SAVE = [
    row("add a crash for the drop and save it", "ACK_GOT_IT", [
        cmd("add_drum_pattern", clipId=DRUM_C, pattern="crash: x..............."),
        cmd("save"),
    ]),
    row("save my session", "ACK_GOT_IT", [cmd("save")]),
    row("add a beat and then save the project", "ACK_GOT_IT", [
        cmd("add_drum_pattern", pattern=FOUR_ON_FLOOR),
        cmd("save"),
    ]),
    row("add a crash right on the drop", "ACK_GOT_IT", [
        cmd("add_drum_pattern", clipId=DRUM_C, pattern="crash: x..............."),
    ]),
    row("give this a beat with some bounce to it", "ACK_GOT_IT", [
        cmd("add_drum_pattern", pattern=BOUNCE, stepsPerBar=20),
    ]),
    row("write a bassline in A minor", "ACK_GOT_IT", [
        cmd("add_note", clipId=BASS_C, pitch=45, start=0.0, length=1.0, velocity=95),
        cmd("add_note", clipId=BASS_C, pitch=48, start=1.0, length=1.0, velocity=90),
    ]),
]


def build_rows() -> list[dict]:
    rows: list[dict] = []

    for ask, pattern, extra in BEAT_FROM_NOTHING:
        rows.append(row(ask, "ACK_GOT_IT", [cmd("add_drum_pattern", pattern=pattern, **extra)]))

    for ask, pattern in ADD_TO_EXISTING:
        rows.append(row(ask, "ACK_GOT_IT", [cmd("add_drum_pattern", clipId=DRUM_C, pattern=pattern)]))

    for ask, name in TRACK_ONLY:
        kwargs = {"type": "drum"}
        if name:
            kwargs["name"] = name
        rows.append(row(ask, "ACK_GOT_IT", [cmd("create_track", **kwargs)]))

    for ask, kit in KIT_SWAP:
        kwargs = {"trackId": DRUM_T}
        if kit:
            kwargs["kit"] = kit
        rows.append(row(ask, "ACK_GOT_IT", [cmd("load_drum_kit", **kwargs)]))

    for ask, clip_id, notes in CONTRAST_MELODIC:
        rows.append(row(ask, "ACK_GOT_IT", [
            cmd("add_note", clipId=clip_id, pitch=p, start=s, length=l, velocity=v) for p, s, l, v in notes
        ]))

    for ask, topic, mood, role, seed in LYRIC_SHEET_PLUS_LINE:
        sheet_kwargs = {"trackId": VOX_T}
        if topic:
            sheet_kwargs["topic"] = topic
        if mood:
            sheet_kwargs["mood"] = mood
        rows.append(row(ask, "ACK_GOT_IT", [
            cmd("create_lyric_sheet", **sheet_kwargs),
            cmd("set_lyric_line", trackId=VOX_T, lineIndex=0, role=role, seedText=seed),
        ]))

    for ask, text, role in LYRIC_EXACT_OPENING:
        rows.append(row(ask, "ACK_GOT_IT", [
            cmd("create_lyric_sheet", trackId=VOX_T),
            cmd("set_lyric_line", trackId=VOX_T, lineIndex=0, text=text, role=role),
        ]))

    for ask, topic, explicit, role0, role1, mood in LYRIC_FULL_FOLLOWTHROUGH:
        rows.append(row(ask, "ACK_GOT_IT", [
            cmd("create_lyric_sheet", trackId=VOX_T, topic=topic, mood=mood),
            cmd("set_lyric_constraint", trackId=VOX_T, explicit=explicit, rhymeStrictness="slant"),
            cmd("set_lyric_line", trackId=VOX_T, lineIndex=0, role=role0, seedText="___ ___ ___"),
            cmd("set_lyric_line", trackId=VOX_T, lineIndex=1, role=role1, seedText="___ ___ ___"),
        ]))

    for ask, topic, mood, explicit in LYRIC_SHEET_ONLY:
        kwargs = {"trackId": VOX_T}
        if topic:
            kwargs["topic"] = topic
        if mood:
            kwargs["mood"] = mood
        if explicit:
            kwargs["explicit"] = explicit
        rows.append(row(ask, "ACK_GOT_IT", [cmd("create_lyric_sheet", **kwargs)]))

    for ask, say in AMBIGUOUS_DEFER:
        rows.append(row(ask, "HUH", commands=None, say=say))

    rows.extend(NEAR_MISS_ACTS)
    rows.extend(VIBE_TARGET_ACTS)
    rows.extend(DOSAGE_SAVE)

    return rows


def main() -> int:
    catalog = load_catalog()
    intents = load_intents()
    known_ids = set(DEFAULT_KNOWN_IDS) | set(ROLES.values())

    rows = build_rows()

    all_errs: list[str] = []
    for i, r in enumerate(rows):
        for e in validate_row(r, catalog, intents, known_ids):
            all_errs.append(f"row {i}: {e}")
    if all_errs:
        for e in all_errs:
            print(e, file=sys.stderr)
        raise SystemExit(f"build_r7_coverage_sft: {len(all_errs)} authored row(s) FAILED validation — fix the recipe, do not write a poisoned file")

    # De-dup guard at the whole-file level: two DIFFERENT rows (different user
    # asks) legitimately CAN share the same gold commands (e.g. two phrasings of
    # "add a crash"), but the exact same (user, assistant) pair twice is authoring
    # noise, not signal.
    seen_pairs = set()
    dupes = []
    for i, r in enumerate(rows):
        key = (r["messages"][1]["content"], r["messages"][2]["content"])
        if key in seen_pairs:
            dupes.append(i)
        seen_pairs.add(key)
    if dupes:
        raise SystemExit(f"build_r7_coverage_sft: exact-duplicate (user, assistant) rows at indices {dupes}")

    lines = [json.dumps(r) for r in rows]
    OUT_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")

    domain_counts = {
        "drum_beat_from_nothing": len(BEAT_FROM_NOTHING),
        "drum_add_to_existing": len(ADD_TO_EXISTING),
        "drum_track_only": len(TRACK_ONLY),
        "drum_kit_swap": len(KIT_SWAP),
        "contrast_melodic_no_drums": len(CONTRAST_MELODIC),
        "lyric_sheet_plus_line": len(LYRIC_SHEET_PLUS_LINE),
        "lyric_exact_opening_line": len(LYRIC_EXACT_OPENING),
        "lyric_full_followthrough": len(LYRIC_FULL_FOLLOWTHROUGH),
        "lyric_sheet_only": len(LYRIC_SHEET_ONLY),
        "ambiguous_defer": len(AMBIGUOUS_DEFER),
        "vibe_target_acts": len(VIBE_TARGET_ACTS),
        "near_miss_should_act": len(NEAR_MISS_ACTS),
        "dosage_save_contrast": len(DOSAGE_SAVE),
    }
    assert sum(domain_counts.values()) == len(rows)

    sha256 = hashlib.sha256(OUT_PATH.read_bytes()).hexdigest()
    manifest = {
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "name": "r7-coverage-demonstrations",
        "purpose": (
            "Targeted SFT coverage rows for the r5 novice-jam bench misses "
            "(drum-kit flows, lyric multi-step follow-through, ambiguity defer, "
            "dosage). NOT r6 data — r6 (R6_TRAINING_PLAN.md) freezes s2-mix-v5 "
            "verbatim by design. This is candidate data for a FUTURE, separately "
            "pre-registered cycle (see R6_COVERAGE_PREP_NOTE.md)."
        ),
        "file": str(OUT_PATH.name),
        "sha256": sha256,
        "row_count": len(rows),
        "domain_counts": domain_counts,
        "system_prompt_source": {
            "path": str(ASSIST_DEMOS.relative_to(SCRIPT_DIR.parent.parent)),
            "note": (
                "byte-identical to assist_demonstrations.jsonl row 0's system field "
                "(same buildSystemPrompt(DEFAULT_RULES, fixture_snap.json) render). "
                "Regenerated 2026-08-17 (r7 prep, RUN_NEXT.md §2.1: `cd ui && npx "
                "tsx scripts/build_assist_sft.mts`) against current commands.ts/"
                "musicalTime.ts HEAD; validate_system_prompt_drift.py reports OK "
                "against this row. See R6_COVERAGE_PREP_NOTE.md 'Prompt-shape drift "
                "found' for the earlier STALE finding this regeneration fixes, and "
                "re-run the drift check before reusing this file if commands.ts "
                "moves again."
            ),
        },
        "fixture_source": {
            "roles": str(ROLES_PATH.relative_to(SCRIPT_DIR.parent.parent)),
            "snapshot": "assist_fixtures/fixture_snap.json",
        },
        "validated_by": "validate_sft_rows.py (catalog + drum-pattern-DSL + reply-contract + real-id + dosage checks)",
        "catalog_commands_checked_against": len(catalog),
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(f"wrote {len(rows)} validated rows -> {OUT_PATH}")
    print(f"sha256 {sha256}")
    print(json.dumps(domain_counts, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
