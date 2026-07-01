#!/usr/bin/env python3
"""Test for the §4→§5 seam (render/from_screen.py:midi_from_frames + the piano_roll bbox localizer)
— locate the piano-roll in a keyframe, read its notes, and attach the MIDI to the lead synth element
so the synth plays a part at §9 render. Deterministic + portable (synthetic frames; no binary).

Headline guards:
  • piano_roll_present now returns a BBOX (was always None) → §5 can crop to the roll instead of
    masking the whole frame;
  • a clean roll embedded in a larger frame → notes recovered + attached to the lead SYNTH element
    (status 'partial', honest low confidence — pitch carries the scroll offset; rhythm is reliable);
  • CONSERVATIVE — a non-roll frame attaches nothing; a recipe with no synth/midi target no-ops;
  • deterministic 3×.

    python3 service/teardown/render/midi_from_frames_test.py   (needs cv2/numpy)
"""
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

import cv2  # noqa: E402

from teardown import recipe as R  # noqa: E402
from teardown.render.from_screen import midi_from_frames  # noqa: E402
from teardown.vision.frames import Frame  # noqa: E402
from teardown.vision.pianoroll import piano_roll_present  # noqa: E402

fails: list[str] = []


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


def _frame_with_roll():
    """A larger gray frame with a CLEAN piano-roll (4 known notes) embedded at an offset — the
    real-frame shape the localizer must crop to."""
    H, W = 600, 800
    ox, oy, RW, RH = 200, 150, 400, 200          # roll occupies >25% width, >12% height
    ROW_H, PPB, TOP_MIDI = 8, 40, 72
    img = np.full((H, W, 3), 30, np.uint8)
    for r in range(RH // ROW_H + 1):             # gray lane lines (low sat → not notes)
        cv2.line(img, (ox, oy + r * ROW_H), (ox + RW, oy + r * ROW_H), (60, 60, 60), 1)
    for b in range(RW // PPB + 1):               # gray bar lines
        cv2.line(img, (ox + b * PPB, oy), (ox + b * PPB, oy + RH), (80, 80, 80), 1)
    for p, sb, lb in [(60, 0, 2), (64, 2, 1), (67, 4, 2), (71, 6, 1)]:   # saturated green notes
        row = TOP_MIDI - p
        y1 = oy + int(row * ROW_H)
        x1 = ox + int(sb * PPB)
        cv2.rectangle(img, (x1, y1), (x1 + lb * PPB - 2, y1 + ROW_H - 1), (0, 200, 0), -1)
    return img


def _recipe_with_synth():
    return R.Recipe(
        meta=R.Meta(tempo_bpm=R.MetaField(value=140, confidence=0.9)),
        elements=[R.Element(element_id="synth_0", role="lead", label="Vital",
                            synth_patch=R.SynthPatch(status="params_visible",
                                                     plugin=R.Plugin(name="Vital"),
                                                     params={"oscillator 1 level": 0.5}))],
    )


roll_frame = _frame_with_roll()
gray = np.full((600, 800, 3), 30, np.uint8)

# ── the bbox localizer ───────────────────────────────────────────────────────────────────────
pr = piano_roll_present(roll_frame)
check("piano_roll_present finds the roll + returns a bbox", pr["present"] and pr["bbox"] is not None,
      str(pr.get("bbox")))
if pr["bbox"]:
    x, y, w, h = pr["bbox"]
    check("bbox roughly covers the embedded roll region (x~200,y~150,w~400,h~200)",
          150 <= x <= 260 and 110 <= y <= 200 and w >= 300 and h >= 150, str(pr["bbox"]))
check("piano_roll_present on a blank frame → no bbox", piano_roll_present(gray)["bbox"] is None)

# ── attach to the lead synth ───────────────────────────────────────────────────────────────────
import tempfile  # noqa: E402

with tempfile.TemporaryDirectory() as td:
    rec = _recipe_with_synth()
    res = midi_from_frames(rec, [Frame(0.0, gray), Frame(3.0, roll_frame)], out_dir=td)
    el = rec.elements[0]
    check("attached to the lead synth element", res.get("attached") and res.get("element_id") == "synth_0",
          str(res))
    check("recovered the 4 note blocks", res.get("notes") == 4, str(res.get("notes")))
    check("MIDI file written", res.get("midi_ref") and os.path.isfile(res["midi_ref"]))
    check("element midi marked partial + honest low confidence (pitch carries scroll offset)",
          el.midi.status.value == "partial" and el.midi.note_count == 4 and el.midi.confidence == 0.4,
          str(el.midi))
    check("synth_patch left intact (only midi added)",
          el.synth_patch.status.value == "params_visible" and el.synth_patch.params, str(el.synth_patch))

with tempfile.TemporaryDirectory() as td:
    rec = _recipe_with_synth()
    rec.elements.append(R.Element(element_id="midi_0", role="other", label="piano-roll part",
                                  midi=R.Midi(status="unknown")))
    rec.unresolved.append(R.Unresolved(issue="piano roll seen but not extracted", element_id="midi_0",
                                       suggested_action="run §5 MIDI-from-screen on the located region"))
    res = midi_from_frames(rec, [Frame(3.0, roll_frame)], out_dir=td)
    ids = [e.element_id for e in rec.elements]
    check("synth attach clears stale midi_0 placeholder", res.get("attached") and ids == ["synth_0"],
          str(ids))
    check("synth attach clears stale piano-roll unresolved",
          not any(u.element_id == "midi_0" for u in rec.unresolved), str(rec.unresolved))

with tempfile.TemporaryDirectory() as td:
    rec = R.Recipe(elements=[R.Element(element_id="midi_0", role="other", label="piano-roll part",
                                       midi=R.Midi(status="unknown"))],
                   unresolved=[R.Unresolved(issue="piano roll seen but not extracted", element_id="midi_0",
                                            suggested_action="run §5 MIDI-from-screen on the located region")])
    res = midi_from_frames(rec, [Frame(3.0, roll_frame)], out_dir=td)
    check("midi_0 target stays but clears stale unresolved",
          res.get("attached") and [e.element_id for e in rec.elements] == ["midi_0"]
          and not rec.unresolved, str((res, rec.unresolved)))

def _arrangement_frame():
    """A DAW ARRANGEMENT view: a COARSE track grid (few tall rows) + coloured clip blocks. It has
    grid lines + saturated rectangles like a roll, so it must be rejected by the fine-grid gate —
    otherwise its clips would be mis-read as bogus notes."""
    H, W = 600, 800
    img = np.full((H, W, 3), 30, np.uint8)
    for r in range(9):                                   # 8 tracks → coarse rows ~66px apart
        cv2.line(img, (0, r * 66), (W, r * 66), (70, 70, 70), 1)
    for b in range(9):                                   # bar dividers
        cv2.line(img, (b * 88, 0), (b * 88, H), (80, 80, 80), 1)
    for (cx, cy) in [(120, 40), (300, 180), (500, 320), (260, 400)]:   # coloured clips
        cv2.rectangle(img, (cx, cy), (cx + 140, cy + 50), (0, 180, 200), -1)
    return img


# ── conservative: no roll → no attach ─────────────────────────────────────────────────────────
with tempfile.TemporaryDirectory() as td:
    rec2 = _recipe_with_synth()
    res2 = midi_from_frames(rec2, [Frame(0.0, gray), Frame(3.0, gray)], out_dir=td)
    check("no roll frame → nothing attached (no garbage MIDI)",
          not res2.get("attached") and rec2.elements[0].midi.status.value == "unknown", str(res2))

# ── conservative: a DAW arrangement view (coarse grid + clips) → no attach (fine-grid gate) ─────
arr = _arrangement_frame()
with tempfile.TemporaryDirectory() as td:
    rec_arr = _recipe_with_synth()
    res_arr = midi_from_frames(rec_arr, [Frame(0.0, arr)], out_dir=td)
    check("arrangement view (coarse track grid + clips) → nothing attached (fine-grid gate)",
          not res_arr.get("attached") and rec_arr.elements[0].midi.status.value == "unknown", str(res_arr))

# ── never overwrite an element that already carries real (extracted) MIDI ───────────────────────
with tempfile.TemporaryDirectory() as td:
    rec_ex = R.Recipe(elements=[R.Element(
        element_id="synth_0", role="lead", label="Vital",
        synth_patch=R.SynthPatch(status="params_visible", plugin=R.Plugin(name="Vital")),
        midi=R.Midi(status="extracted", midi_ref="/tmp/real.mid", note_count=9, confidence=0.8))])
    res_ex = midi_from_frames(rec_ex, [Frame(0.0, roll_frame)], out_dir=td)
    m = rec_ex.elements[0].midi
    check("synth with real 'extracted' MIDI is NOT overwritten by the rough screen read",
          not res_ex.get("attached") and m.status.value == "extracted" and m.midi_ref == "/tmp/real.mid"
          and m.confidence == 0.8, str(m))

# ── conservative: no synth/midi target → no-op ────────────────────────────────────────────────
with tempfile.TemporaryDirectory() as td:
    rec3 = R.Recipe(elements=[R.Element(element_id="kick_0", role="kick", audio_ref="/tmp/k.wav")])
    res3 = midi_from_frames(rec3, [Frame(0.0, roll_frame)], out_dir=td)
    check("no synth/midi target element → no-op", not res3.get("attached"), str(res3))

# ── graceful: empty frames ────────────────────────────────────────────────────────────────────
with tempfile.TemporaryDirectory() as td:
    check("empty frames → no-op", not midi_from_frames(_recipe_with_synth(), [], out_dir=td).get("attached"))

# ── determinism ──────────────────────────────────────────────────────────────────────────────
outs = []
for _ in range(3):
    with tempfile.TemporaryDirectory() as td:
        r = _recipe_with_synth()
        res = midi_from_frames(r, [Frame(3.0, roll_frame)], out_dir=td)
        outs.append((res.get("attached"), res.get("notes")))
check("midi_from_frames deterministic x3", outs[0] == outs[1] == outs[2], str(outs))

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
