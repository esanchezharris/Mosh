#!/usr/bin/env python3
"""REAL §9 SYNTH execute proof — the describe_plugin payoff: §9 loads a synth BY NAME and
sets its patch params BY NAME (names→indices resolved via describe_plugin), then the inlined
MIDI plays through it → an audible melodic element. Covers the synth half the §13 census
flagged (a recipe whose §5b read named a plugin + params).

Needs the binary built WITH describe_plugin (point MOSH_BIN at the fresh build) + Serum 2.
Absent → SKIP (exit 0).

    MOSH_BIN=build-macos-arm64-release/.../Mosh python3 service/teardown/render/verify_synth_execute.py
"""
from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from teardown import recipe as R  # noqa: E402
from teardown.midi_from_screen.export import write_midi  # noqa: E402
from teardown.render.execute import _list_instruments, execute_recipe  # noqa: E402

BIN = os.environ.get("MOSH_BIN", "").strip() or "/Applications/Mosh.app/Contents/MacOS/Mosh"


def main() -> int:
    if not os.path.isfile(BIN):
        print(f"  SKIP  Mosh binary not found at {BIN}")
        return 0
    insts = _list_instruments(BIN, None, 120)
    serum = next((n for n in insts if n.startswith("serum 2")), None)
    if not serum:
        print(f"  SKIP  Serum 2 not installed — have {sorted(insts)[:6]}")
        return 0
    print(f"  synth available: Serum 2")

    work = tempfile.mkdtemp(prefix="td-synth-exec-")
    # a short melodic line
    notes = [{"pitch": p, "start": i * 0.5, "end": i * 0.5 + 0.5, "velocity": 100}
             for i, p in enumerate([60, 63, 67, 70])]
    mid = os.path.join(work, "lead.mid")
    write_midi(notes, mid, bpm=140)

    # a recipe element a §5b read might produce: named plugin + a couple named params
    rec = R.Recipe(
        meta=R.Meta(tempo_bpm=R.MetaField(value=140, confidence=0.9)),
        elements=[
            R.Element(element_id="lead", role="lead", label="Lead",
                      synth_patch=R.SynthPatch(status="params_visible",
                                               plugin=R.Plugin(name="Serum", available_locally=True),
                                               params={"Main Vol": 0.6, "Main Tuning": 0.55}),
                      midi=R.Midi(status="extracted", midi_ref=mid, note_count=len(notes))),
        ],
    )
    print("  recipe: 1 synth element (Serum, params {Main Vol, Main Tuning}) + MIDI")

    out = os.path.join(work, "render.wav")
    res = execute_recipe(rec, bin_path=BIN, out_wav=out, session_dir=work, timeout_s=180)

    print(f"  ran: {res.ran}  synths_loaded: {res.synths_loaded}  params_set: {res.synth_params_set}  "
          f"notes_resolved: {res.notes_resolved}")
    print(f"  rms: {res.audio_rms:.4f}  nonsilent: {res.nonsilent}")
    print(f"  yield.actual: {res.yield_actual}")
    if res.error:
        print(f"  engine note: {res.error}")
    cmds_ok = sum(1 for r in res.results if r.get("ok"))
    print(f"  commands: {cmds_ok}/{len(res.results)} ok")

    fails = []
    if not res.ran:
        fails.append(f"did not run: {res.error}")
    if res.synths_loaded < 1:
        fails.append("synth not loaded by name")
    if res.synth_params_set < 1:
        fails.append("no patch params resolved by name (describe_plugin map failed)")
    if not res.nonsilent:
        fails.append(f"synth render was silent (rms {res.audio_rms:.5f})")
    if res.notes_resolved < 1:
        fails.append("MIDI not resolved")

    if fails:
        print("\n  FAIL: " + "; ".join(fails))
        return 1
    print("\n  PASS — §9 loaded Serum BY NAME, set patch params BY NAME (via describe_plugin), "
          "and rendered an audible synth line from the MIDI")
    return 0


if __name__ == "__main__":
    sys.exit(main())
