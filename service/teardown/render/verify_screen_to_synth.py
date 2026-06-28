#!/usr/bin/env python3
"""REAL-binary proof of the full SCREEN→SYNTH-AUDIO chain (the 'synth-audio seams' work): a
skeleton synth element, fed only by SCREEN READS, plays a part on the actual engine —

  §5b enrich  : reads the Vital GUI off a keyframe (committed vital_init.png) → params_visible
  §5  midi    : reads a piano-roll keyframe → MIDI attached to that synth element
  §9  execute : loads Vital, applies the read params, plays the read notes → non-silent

No hand-written MIDI, no hand-set params — both come from the screen-read seams. Needs the binary
+ Vital installed; absent → SKIP (exit 0).

    MOSH_BIN=/Applications/Mosh.app/Contents/MacOS/Mosh \
      python3 service/teardown/render/verify_screen_to_synth.py
"""
from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import cv2  # noqa: E402
import numpy as np  # noqa: E402

from teardown import recipe as R  # noqa: E402
from teardown.render.execute import _list_instruments, execute_recipe  # noqa: E402
from teardown.render.from_screen import enrich_synths_from_frames, midi_from_frames  # noqa: E402
from teardown.vision.frames import Frame  # noqa: E402

BIN = os.environ.get("MOSH_BIN", "").strip() or "/Applications/Mosh.app/Contents/MacOS/Mosh"
FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "synth_from_screen", "fixtures", "vital_init.png")


def _roll_frame():
    """A clean piano-roll embedded in a larger frame (the §5 input shape)."""
    H, W, ox, oy, RW, RH, ROW_H, PPB, TOP = 600, 800, 200, 150, 400, 200, 8, 40, 72
    img = np.full((H, W, 3), 30, np.uint8)
    for r in range(RH // ROW_H + 1):
        cv2.line(img, (ox, oy + r * ROW_H), (ox + RW, oy + r * ROW_H), (60, 60, 60), 1)
    for b in range(RW // PPB + 1):
        cv2.line(img, (ox + b * PPB, oy), (ox + b * PPB, oy + RH), (80, 80, 80), 1)
    for p, sb, lb in [(60, 0, 2), (64, 2, 1), (67, 4, 2), (71, 6, 1)]:
        y1 = oy + int((TOP - p) * ROW_H)
        x1 = ox + int(sb * PPB)
        cv2.rectangle(img, (x1, y1), (x1 + lb * PPB - 2, y1 + ROW_H - 1), (0, 200, 0), -1)
    return img


def main() -> int:
    if not os.path.isfile(BIN):
        print(f"  SKIP  Mosh binary not found at {BIN}")
        return 0
    if not os.path.isfile(FIX):
        print(f"  SKIP  vital_init.png fixture not found at {FIX}")
        return 0
    if not any(n.startswith("vital") for n in _list_instruments(BIN, None, 120)):
        print("  SKIP  Vital not installed")
        return 0
    print("  synth available: Vital")

    work = tempfile.mkdtemp(prefix="td-screen2synth-")
    # a §4 skeleton element: OCR-named Vital, status unknown, NO params, NO midi
    rec = R.Recipe(
        meta=R.Meta(tempo_bpm=R.MetaField(value=140, confidence=0.9)),
        elements=[R.Element(element_id="synth_0", role="lead", label="Vital",
                            synth_patch=R.SynthPatch(status="unknown",
                                                     plugin=R.Plugin(name="Vital")))],
    )
    frames = [Frame(0.0, cv2.imread(FIX)), Frame(3.0, _roll_frame())]

    n_params = enrich_synths_from_frames(rec, frames)
    midi_res = midi_from_frames(rec, frames, out_dir=os.path.join(work, "midi"))
    el = rec.elements[0]
    print(f"  §5b enrich: upgraded {n_params} → {len(el.synth_patch.params)} params, "
          f"status={el.synth_patch.status.value}")
    print(f"  §5  midi:   attached={midi_res.get('attached')} notes={midi_res.get('notes')} "
          f"status={el.midi.status.value}")

    res = execute_recipe(rec, bin_path=BIN, out_wav=os.path.join(work, "out.wav"),
                         session_dir=work, timeout_s=180)
    print(f"  §9 render:  synths_loaded={res.synths_loaded}  params_set={res.synth_params_set}  "
          f"notes_resolved={res.notes_resolved}  rms={res.audio_rms:.4f}  nonsilent={res.nonsilent}")
    print(f"  yield.actual: {res.yield_actual}")
    if res.error:
        print(f"  engine note: {res.error}")

    fails = []
    if n_params != 1 or el.synth_patch.status.value != "params_visible":
        fails.append("§5b did not read params off the GUI")
    if not midi_res.get("attached") or el.midi.status.value != "partial":
        fails.append("§5 did not attach screen-read MIDI")
    if res.synths_loaded < 1:
        fails.append("synth not loaded")
    if res.notes_resolved < 1:
        fails.append("screen-read MIDI not resolved at render")
    if not res.nonsilent:
        fails.append(f"render silent (rms {res.audio_rms:.5f})")

    if fails:
        print("\n  FAIL: " + "; ".join(fails))
        return 1
    print(f"\n  PASS — from SCREEN READS ALONE: §5b read {len(el.synth_patch.params)} params + §5 read "
          f"{midi_res.get('notes')} notes → Vital loaded + played a non-silent part (rms {res.audio_rms:.3f})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
