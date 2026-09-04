#!/usr/bin/env python3
"""Tests for mdsl_to_moshops.py (W2.7). Hermetic and network-free: every assertion runs
against a small SYNTHETIC MDSL string built in this file, not the owner's real
~/AbletonMONSTER checkout — so this proves the CONVERSION LOGIC (bar.step math, note-
name math, drum-pad mapping, track collapsing, filtering) independent of that repo's
presence or contents. A best-effort integration check against the real reference file
runs too, but SKIPS (never fails) when that path is absent, matching the repo's existing
skip convention for machine-dependent tests (e.g. service/scripts/venv_locations_test.py).

Runnable directly: `python3 mdsl_to_moshops_test.py`.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mdsl_to_moshops as conv  # noqa: E402

FAILURES = []


def check(cond, label):
    if cond:
        print(f"  ok  {label}")
    else:
        print(f"  FAIL {label}")
        FAILURES.append(label)


# A small synthetic MDSL document exercising every construct the converter handles:
# comments, blank lines, section headers (ignored), an 'e' step suffix, two DIFFERENT
# 808 sound_ids across two sections merging into one output track, a syn block reused
# across two sections merging into one, and every drum type.
SYNTHETIC_MDSL = """
# a synthetic beat, not the real reference file
S 140 Cm

A 1-2
T:808 808_a
N 1.0 D4 95 6 | 1.6e D4 85 4
T:syn lead
N 1.0 C5 100 2 | 1.4 D5 90 2
T:kick jers_kick
N 1.0 118 | 1.8 100
T:snr light_snare
N 1.4 110 | 1.12 105
T:clp law_clap
N 1.4 100
T:hat hatime_hhat
N 1.0 88 | 1.2 60
T:prc bestsnap_perc
N 1.3 78

B 3-4
T:808 808_b
N 3.0 A4 90 6
T:syn lead
N 3.0 E5 95 2
T:kick jers_kick
N 3.0 118
"""


def test_note_name_to_midi():
    check(conv.note_name_to_midi("C4") == 60, "C4 == MIDI 60")
    check(conv.note_name_to_midi("D4") == 62, "D4 == MIDI 62")
    check(conv.note_name_to_midi("Bb4") == 70, "Bb4 == MIDI 70")
    check(conv.note_name_to_midi("A#4") == conv.note_name_to_midi("Bb4"), "A#4 aliases to Bb4")
    check(conv.note_name_to_midi("C-1") == 0, "C-1 == MIDI 0 (lowest representable octave)")
    try:
        conv.note_name_to_midi("H4")
        check(False, "an invalid pitch class raises ValueError")
    except ValueError:
        check(True, "an invalid pitch class raises ValueError")


def test_parse_bar_step():
    check(conv.parse_bar_step("1.10") == (1, 10.0, False), "'1.10' -> bar 1, step 10, no e-suffix")
    check(conv.parse_bar_step("2.7e") == (2, 7.0, True), "'2.7e' -> bar 2, step 7, e-suffix")
    try:
        conv.parse_bar_step("nope")
        check(False, "a malformed bar.step token raises ValueError")
    except ValueError:
        check(True, "a malformed bar.step token raises ValueError")


def test_bar_step_to_beat():
    check(conv.bar_step_to_beat(1, 0, False) == 0.0, "bar 1 step 0 -> beat 0")
    check(conv.bar_step_to_beat(1, 10, False) == 2.5, "bar 1 step 10 -> beat 2.5 (10/4)")
    check(conv.bar_step_to_beat(2, 0, False) == 4.0, "bar 2 step 0 -> beat 4 ((2-1)*4)")
    check(
        abs(conv.bar_step_to_beat(2, 7, True) - 5.875) < 1e-9,
        "bar 2 step 7 with 'e' -> beat 5.875 ((2-1)*4 + 7/4 + 0.125)",
    )


def test_parse_mdsl_shape():
    session = conv.parse_mdsl(SYNTHETIC_MDSL)
    check(session.bpm == 140, "S line bpm parsed")
    check(session.key == "Cm", "S line key parsed")
    check(len(session.blocks) == 10, f"10 T: blocks parsed (7 in section A + 3 in section B) (got {len(session.blocks)})")
    types = [b.track_type for b in session.blocks]
    check(types.count("808") == 2, "two separate T:808 blocks parsed (different sound_ids)")
    check(types.count("syn") == 2, "two separate T:syn lead blocks parsed (same sound_id, different sections)")

    kick_block = next(b for b in session.blocks if b.track_type == "kick")
    check(len(kick_block.notes) == 2, "the first kick block carries its 2 piped notes")
    check(kick_block.notes[0].vel == 118, "a drum note's velocity parses correctly")
    check(kick_block.notes[0].pitch is None, "a drum note carries no pitch")

    lead_block = next(b for b in session.blocks if b.track_type == "syn")
    check(lead_block.notes[0].pitch == "C5", "a melodic note's pitch name parses correctly")
    check(lead_block.notes[0].dur == 2, "a melodic note's duration (16ths) parses correctly")

    e_block = next(b for b in session.blocks if b.track_type == "808" and b.sound_id == "808_a")
    check(e_block.notes[1].has_e is True, "the 'e' suffix is captured on a melodic entry")


def test_parse_mdsl_errors():
    try:
        conv.parse_mdsl("N 1.0 100\n")
        check(False, "an N line with no preceding T: block raises ValueError")
    except ValueError:
        check(True, "an N line with no preceding T: block raises ValueError")

    try:
        conv.parse_mdsl("S 140 Cm\nT:kick jers_kick\nN 1.0 100 200\n")
        check(False, "a drum N entry with the wrong field count raises ValueError")
    except ValueError:
        check(True, "a drum N entry with the wrong field count raises ValueError")

    try:
        conv.parse_mdsl("T:kick jers_kick\nN 1.0 100\n")
        check(False, "a document with no S line raises ValueError")
    except ValueError:
        check(True, "a document with no S line raises ValueError")


def test_collect_track_notes_merging_and_pads():
    session = conv.parse_mdsl(SYNTHETIC_MDSL)
    by_track = conv.collect_track_notes(session)

    check("808" in by_track, "the 808 track exists")
    check(
        len(by_track["808"]) == 3,
        f"808 notes from BOTH sound_ids (808_a section A, 808_b section B) merge into one track (got {len(by_track['808'])})",
    )
    check("lead" in by_track, "the 'lead' syn track exists (sound_id used directly as track name)")
    check(
        len(by_track["lead"]) == 3,
        f"lead notes from both sections merge into one track (got {len(by_track['lead'])})",
    )

    check("drums" in by_track, "every drum block folds into one 'drums' track")
    pitches = {n["pitch"] for n in by_track["drums"]}
    # kick x3 (2 section-A hits + 1 section-B hit) -> pad 36, snare -> 38, clap -> 39,
    # hat -> 42, perc -> 41 (SOUND_ID_TO_PAD).
    check(pitches == {36, 38, 39, 42, 41}, f"drum notes carry their MAPPED PAD numbers, not raw sound_ids (got {pitches})")
    kick_notes = [n for n in by_track["drums"] if n["pitch"] == 36]
    check(len(kick_notes) == 3, "all 3 kick hits (2 section A + 1 section B) landed on pad 36")
    check(all(n["length"] == 0.25 for n in by_track["drums"]), "every drum note has the fixed 0.25-beat length")

    # start/length math on the melodic 'e'-suffixed note: bar 1 step 6 with 'e' -> beat
    # 1.625; dur 4 sixteenths -> length 1.0 beat.
    e_note = next(n for n in by_track["808"] if abs(n["start"] - 1.625) < 1e-9)
    check(abs(e_note["length"] - 1.0) < 1e-9, "melodic note length = dur * 0.25 beats")
    check(e_note["pitch"] == 62, "melodic note pitch resolves via note_name_to_midi (D4 -> 62)")


def test_unknown_drum_sound_id_raises():
    session = conv.parse_mdsl("S 140 Cm\nT:kick unknown_kick_xyz\nN 1.0 100\n")
    try:
        conv.collect_track_notes(session)
        check(False, "an unmapped drum sound_id raises ValueError")
    except ValueError:
        check(True, "an unmapped drum sound_id raises ValueError")


def test_max_bar_and_track_and_pad_filters():
    session = conv.parse_mdsl(SYNTHETIC_MDSL)

    only_bar1 = conv.collect_track_notes(session, max_bar=1)
    # 808_a carries both its notes in bar 1 (1.0 and 1.6e); the section-B 808 note
    # (bar 3, A4=69) must be excluded.
    check(len(only_bar1.get("808", [])) == 2, "max_bar=1 keeps both bar-1 808 notes")
    check(all(n["pitch"] != 69 for n in only_bar1.get("808", [])), "the excluded 808 note (A4, bar 3) is really gone")

    only_808 = conv.collect_track_notes(session, tracks={"808"})
    check(set(only_808.keys()) == {"808"}, "the `tracks` filter restricts output to exactly the requested set")

    only_kick_pad = conv.collect_track_notes(session, drum_pads={36})
    check(
        all(n["pitch"] == 36 for n in only_kick_pad["drums"]),
        "the `drum_pads` filter restricts the merged drums track to the requested pad(s)",
    )
    check(len(only_kick_pad["drums"]) == 3, "the pad filter keeps every note on that pad, not just one")


def test_build_program_shape_and_seconds():
    session = conv.parse_mdsl(SYNTHETIC_MDSL)
    program = conv.build_program(session, total_bars=4)

    check(program["status"] == "done", "build_program's status is 'done'")
    check(isinstance(program.get("plan"), list) and len(program["plan"]) > 0, "build_program emits a non-empty plan")

    step = next(s for s in program["plan"] if s["commands"][0]["args"]["trackId"] == "${808}")
    check(step["commands"][0]["command"] == "add_midi_clip", "every plan step's command is add_midi_clip")
    check(step["commands"][0]["args"]["start"] == 0, "the clip starts at 0")
    # total_bars=4 -> 16 beats -> seconds = 16 * 60/140.
    expected_seconds = 16 * 60.0 / 140.0
    check(
        abs(step["commands"][0]["args"]["length"] - expected_seconds) < 1e-6,
        f"clip length converts beats->seconds at the session bpm (got {step['commands'][0]['args']['length']}, want {expected_seconds})",
    )
    check(len(step["commands"][0]["args"]["notes"]) > 0, "the 808 step actually carries notes")

    # Every plan step must be independently JSON-serializable (this becomes a fixture file).
    check(json.dumps(program) is not None, "the whole program round-trips through json.dumps")

    order = [s["commands"][0]["args"]["trackId"] for s in program["plan"]]
    check(order == sorted(order, key=lambda t: conv.TRACK_ORDER.index(t.strip("${}"))), "plan steps follow TRACK_ORDER")


def test_goal_overrides():
    session = conv.parse_mdsl(SYNTHETIC_MDSL)
    program = conv.build_program(session, goal_overrides={"808": "custom goal text"})
    step = next(s for s in program["plan"] if s["commands"][0]["args"]["trackId"] == "${808}")
    check(step["goal"] == "custom goal text", "goal_overrides replaces a track's default goal text")


def test_real_reference_file_if_present():
    """Best-effort integration check: parses the OWNER's real corrected-reference file
    when this machine has it checked out. Never fails when absent — the logic tests
    above are what this file's correctness actually rests on."""
    src = conv.DEFAULT_MDSL
    if not src.is_file():
        print(f"  skip integration check: {src} not present on this machine")
        return
    session = conv.parse_mdsl(src.read_text(encoding="utf-8"))
    check(session.bpm == 148, "real reference file: bpm is 148")
    check(session.key == "Dm", "real reference file: key is Dm")
    by_track = conv.collect_track_notes(session)
    check(set(conv.TRACK_ORDER) == set(by_track.keys()), "real reference file: all 9 tracks produced notes")
    # The task's octave-convention note documents 808 as MIDI 62-70 (D4..Bb4); the real
    # corrected file's section B ("sexy_drill") actually dips to C4 (60) and reaches C5
    # (72) on two hits — a genuine discrepancy against that convention, not a parser
    # bug (verified by hand against the source .mdsl). This asserts the OBSERVED
    # envelope rather than silently clamping or "fixing" the owner's corrected data.
    check(
        all(60 <= n["pitch"] <= 72 for n in by_track["808"]),
        "real reference file: 808 pitches stay within the observed 60-72 envelope (documented convention is 62-70; section B dips to C4/reaches C5)",
    )
    check(set(by_track["drums"][0].keys()) == {"pitch", "start", "length", "velocity"}, "real reference file: drum note shape")


def main() -> int:
    test_note_name_to_midi()
    test_parse_bar_step()
    test_bar_step_to_beat()
    test_parse_mdsl_shape()
    test_parse_mdsl_errors()
    test_collect_track_notes_merging_and_pads()
    test_unknown_drum_sound_id_raises()
    test_max_bar_and_track_and_pad_filters()
    test_build_program_shape_and_seconds()
    test_goal_overrides()
    test_real_reference_file_if_present()

    print()
    if FAILURES:
        print(f"✗ mdsl_to_moshops_test: {len(FAILURES)} failure(s)")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("✓ mdsl_to_moshops_test: all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
