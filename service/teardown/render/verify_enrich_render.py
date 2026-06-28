#!/usr/bin/env python3
"""REAL-binary proof of the §4→§5b auto-wiring (the live `synths_loaded 0` fix). An A/B on the
actual Mosh engine:

  A) a SKELETON element exactly as §4 emits it — plugin named by OCR ("Vital"), status 'unknown',
     NO params — rendered as-is  → the synth does NOT load (nothing to apply);
  B) the SAME element after `enrich_synths_from_frames` reads the Vital GUI off a keyframe
     (the committed vital_init.png) → status 'params_visible' with real params → renders a
     non-silent synth line.

So the wiring is shown to be load-bearing: B loads + plays the synth, A does not. Mirrors
verify_synth_execute.py. Needs the binary + Vital installed; absent → SKIP (exit 0).

    MOSH_BIN=/Applications/Mosh.app/Contents/MacOS/Mosh \
      python3 service/teardown/render/verify_enrich_render.py
"""
from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import cv2  # noqa: E402

from teardown import recipe as R  # noqa: E402
from teardown.midi_from_screen.export import write_midi  # noqa: E402
from teardown.render.execute import _list_instruments, execute_recipe  # noqa: E402
from teardown.render.from_screen import enrich_synths_from_frames  # noqa: E402
from teardown.vision.frames import Frame  # noqa: E402

BIN = os.environ.get("MOSH_BIN", "").strip() or "/Applications/Mosh.app/Contents/MacOS/Mosh"
FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "synth_from_screen", "fixtures", "vital_init.png")


def _skeleton_recipe(mid: str, notes: list) -> R.Recipe:
    """Exactly what §4 assemble_skeleton emits for an OCR'd 'Vital': unread patch + a MIDI part."""
    return R.Recipe(
        meta=R.Meta(tempo_bpm=R.MetaField(value=140, confidence=0.9)),
        elements=[R.Element(
            element_id="synth_0", role="lead", label="Vital",
            synth_patch=R.SynthPatch(status="unknown",
                                     plugin=R.Plugin(name="Vital", available_locally=False)),
            midi=R.Midi(status="extracted", midi_ref=mid, note_count=len(notes)))],
    )


def main() -> int:
    if not os.path.isfile(BIN):
        print(f"  SKIP  Mosh binary not found at {BIN}")
        return 0
    if not os.path.isfile(FIX):
        print(f"  SKIP  vital_init.png fixture not found at {FIX}")
        return 0
    insts = _list_instruments(BIN, None, 120)
    if not any(n.startswith("vital") for n in insts):
        print(f"  SKIP  Vital not installed — have {sorted(insts)[:6]}")
        return 0
    print("  synth available: Vital")

    work = tempfile.mkdtemp(prefix="td-enrich-render-")
    notes = [{"pitch": p, "start": i * 0.5, "end": i * 0.5 + 0.5, "velocity": 100}
             for i, p in enumerate([60, 63, 67, 70])]
    mid = os.path.join(work, "lead.mid")
    write_midi(notes, mid, bpm=140)

    # ── A) raw skeleton (unread) ────────────────────────────────────────────────────────────
    rec_a = _skeleton_recipe(mid, notes)
    res_a = execute_recipe(rec_a, bin_path=BIN, out_wav=os.path.join(work, "a.wav"),
                           session_dir=os.path.join(work, "a"), timeout_s=180)
    print(f"  A (skeleton, unread):  synths_loaded={res_a.synths_loaded}  "
          f"params_set={res_a.synth_params_set}  rms={res_a.audio_rms:.4f}")

    # ── B) after the §4→§5b enrich reads the GUI keyframe ────────────────────────────────────
    rec_b = _skeleton_recipe(mid, notes)
    n = enrich_synths_from_frames(rec_b, [Frame(0.0, cv2.imread(FIX))])
    el = rec_b.elements[0]
    print(f"  enrich upgraded {n} element(s) → status={el.synth_patch.status.value}, "
          f"{len(el.synth_patch.params)} params (e.g. {sorted(el.synth_patch.params)[:2]})")
    res_b = execute_recipe(rec_b, bin_path=BIN, out_wav=os.path.join(work, "b.wav"),
                           session_dir=os.path.join(work, "b"), timeout_s=180)
    print(f"  B (after enrich):      synths_loaded={res_b.synths_loaded}  "
          f"params_set={res_b.synth_params_set}  rms={res_b.audio_rms:.4f}  nonsilent={res_b.nonsilent}")
    print(f"  B yield.actual: {res_b.yield_actual}")
    if res_b.error:
        print(f"  engine note: {res_b.error}")

    fails = []
    if n != 1:
        fails.append(f"enrich did not upgrade the element (n={n})")
    if el.synth_patch.status.value != "params_visible":
        fails.append("element not upgraded to params_visible")
    if res_b.synths_loaded < 1:
        fails.append("synth not loaded after enrich")
    if res_b.synth_params_set < 1:
        fails.append("no patch params applied after enrich")
    if not res_b.nonsilent:
        fails.append(f"synth render silent after enrich (rms {res_b.audio_rms:.5f})")
    if res_a.synths_loaded >= res_b.synths_loaded:
        fails.append(f"enrich not load-bearing: A loaded {res_a.synths_loaded}, B loaded {res_b.synths_loaded}")

    if fails:
        print("\n  FAIL: " + "; ".join(fails))
        return 1
    print(f"\n  PASS — §4→§5b auto-wiring is load-bearing: an unread skeleton synth (A: "
          f"{res_a.synths_loaded} loaded) becomes a non-silent rendered synth after enrich "
          f"(B: {res_b.synths_loaded} loaded, {res_b.synth_params_set} params, rms {res_b.audio_rms:.3f})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
