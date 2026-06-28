#!/usr/bin/env python3
"""REAL §9 execute proof — compile a Recipe, run it through MoshOps, render a non-silent
WAV, and write back a measured yield. The "easy regime carries the system" centerpiece:
matched owned samples + screen-read MIDI need neither §7 extraction nor §8 refinement.

Needs the built Mosh binary (MOSH_BIN or /Applications/Mosh.app) and a sample library
(MUSICA_ROOT or ~/Downloads/musica). Absent either → SKIPS cleanly (exit 0).

    python3 service/teardown/render/verify_execute.py
"""
from __future__ import annotations

import glob
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from teardown import recipe as R  # noqa: E402
from teardown.midi_from_screen.export import write_midi  # noqa: E402
from teardown.render.execute import execute_recipe  # noqa: E402

BIN = os.environ.get("MOSH_BIN", "").strip() or "/Applications/Mosh.app/Contents/MacOS/Mosh"
MUSICA = os.environ.get("MUSICA_ROOT", os.path.expanduser("~/Downloads/musica"))


def pick_samples(n: int) -> list[str]:
    found = []
    for ext in ("wav", "aif", "aiff", "flac"):
        found += glob.glob(os.path.join(MUSICA, "**", f"*.{ext}"), recursive=True)
        if len(found) >= n * 5:
            break
    found.sort()
    return found[:n]


def main() -> int:
    if not os.path.isfile(BIN):
        print(f"  SKIP  Mosh binary not found at {BIN} — §9 execute proof skipped")
        return 0
    if not os.path.isdir(MUSICA):
        print(f"  SKIP  sample library not found at {MUSICA} — §9 execute proof skipped")
        return 0
    samples = pick_samples(2)
    if len(samples) < 2:
        print("  SKIP  not enough samples in the library")
        return 0

    work = tempfile.mkdtemp(prefix="td-execute-proof-")
    # a screen-read drum pattern (GM kick/snare/hat) → an audible drum track via the
    # default kit (no synth needed: the regime §9 runs on alone).
    notes = []
    for beat in range(4):
        notes.append({"pitch": 36, "start": beat, "end": beat + 0.5, "velocity": 120})
        if beat % 2 == 1:
            notes.append({"pitch": 38, "start": beat, "end": beat + 0.5, "velocity": 110})
        notes.append({"pitch": 42, "start": beat + 0.5, "end": beat + 0.75, "velocity": 90})
    mid = os.path.join(work, "beat.mid")
    write_midi(notes, mid, bpm=140)

    rec = R.Recipe(
        meta=R.Meta(
            tempo_bpm=R.MetaField(value=140, confidence=0.9),
            key=R.MetaField(value="F# minor", confidence=0.6),
            time_signature=R.MetaField(value="4/4", confidence=0.9),
        ),
        elements=[
            R.Element(element_id="drums", role="kick", label="Drums",
                      midi=R.Midi(status="extracted", midi_ref=mid, note_count=len(notes))),
            R.Element(element_id="smp1", role="perc", label="Perc 1",
                      sample_match=R.SampleMatch(status="matched", matched_path=samples[0], distance=0.1)),
            R.Element(element_id="smp2", role="clap", label="Perc 2",
                      sample_match=R.SampleMatch(status="matched", matched_path=samples[1], distance=0.1)),
        ],
    )
    print(f"  recipe: {len(rec.elements)} elements (1 drum-MIDI + 2 matched samples)")

    out = os.path.join(work, "render.wav")
    res = execute_recipe(rec, bin_path=BIN, out_wav=out, session_dir=work, timeout_s=180)

    print(f"  ran: {res.ran}  notes_resolved: {res.notes_resolved}  rms: {res.audio_rms:.4f}  "
          f"nonsilent: {res.nonsilent}")
    print(f"  yield.actual: {res.yield_actual}")
    print(f"  reconstruction_class: {rec.reconstruction_class.value}")
    if res.error:
        print(f"  engine note: {res.error}")
    cmds_ok = sum(1 for r in res.results if r.get("ok"))
    print(f"  commands: {cmds_ok}/{len(res.results)} ok")

    fails = []
    if not res.ran:
        fails.append(f"did not run: {res.error}")
    if not res.nonsilent:
        fails.append(f"render was silent (rms {res.audio_rms:.5f})")
    if res.notes_resolved < 1:
        fails.append("MIDI notes not resolved from the SMF")
    if res.yield_actual.get("overall", 0) <= 0.0:
        fails.append(f"zero measured yield ({res.yield_actual})")
    # the recipe must carry the written-back yield
    if rec.yield_.actual.overall != res.yield_actual.get("overall"):
        fails.append("yield.actual not written back into the recipe")

    if fails:
        print("\n  FAIL: " + "; ".join(fails))
        return 1
    print("\n  PASS — §9 compiled a real Recipe → MoshOps → non-silent render + measured yield")
    return 0


if __name__ == "__main__":
    sys.exit(main())
