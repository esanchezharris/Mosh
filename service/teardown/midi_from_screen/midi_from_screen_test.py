#!/usr/bin/env python3
"""Test for §5 — the note-detection core on a SYNTHETIC piano roll (known notes), plus the
SMF export. Real per-DAW axis detection needs real clips + profiles (gated); this proves the
generic CV core recovers notes given the axes.

    python3 service/teardown/midi_from_screen/midi_from_screen_test.py   (needs cv2/numpy)
"""
import os
import sys
import tempfile
from pathlib import Path

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from teardown.midi_from_screen import Axes, detect_notes, write_midi  # noqa: E402

fails: list[str] = []


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


import cv2  # noqa: E402

TOP_MIDI, ROW_H, PPB = 72, 8, 40
N_ROWS, N_BEATS = 24, 8
H, W = N_ROWS * ROW_H, N_BEATS * PPB
axes = Axes(pitch_top_y=ROW_H / 2, row_h=ROW_H, top_midi=TOP_MIDI, time_left_x=0.0, px_per_beat=PPB)

img = np.full((H, W, 3), 30, np.uint8)                     # dark, desaturated background
for r in range(N_ROWS):
    cv2.line(img, (0, r * ROW_H), (W, r * ROW_H), (60, 60, 60), 1)   # gray grid (low sat → not a note)
for b in range(N_BEATS):
    cv2.line(img, (b * PPB, 0), (b * PPB, H), (80, 80, 80), 1)

KNOWN = [(60, 0, 2), (64, 2, 1), (67, 4, 2), (71, 6, 1)]   # (pitch, start_beat, len_beats)
for p, sb, lb in KNOWN:
    row = TOP_MIDI - p
    y1 = int(axes.pitch_top_y + row * ROW_H - ROW_H / 2)
    x1 = int(sb * PPB)
    cv2.rectangle(img, (x1, y1), (x1 + lb * PPB - 2, y1 + ROW_H - 1), (0, 200, 0), -1)  # saturated green note

notes = detect_notes(img, axes)
by_pitch = {n["pitch"]: n for n in notes}
check("recovers exactly the known pitches", sorted(by_pitch) == sorted(p for p, _, _ in KNOWN),
      str(sorted(by_pitch)))
check("note starts within ±0.15 beat", all(abs(by_pitch[p]["start"] - sb) < 0.15 for p, sb, _ in KNOWN))
check("note durations within ±0.2 beat",
      all(abs((by_pitch[p]["end"] - by_pitch[p]["start"]) - lb) < 0.2 for p, sb, lb in KNOWN))
check("no octave errors (exact pitch)", all(p in by_pitch for p, _, _ in KNOWN))

with tempfile.TemporaryDirectory() as td:
    mid = write_midi(notes, Path(td) / "out.mid", bpm=140)
    data = Path(mid).read_bytes()
    check("export writes a valid SMF (MThd header)", data[:4] == b"MThd" and len(data) > 30)
    check("SMF has a track chunk", b"MTrk" in data)

runs = {tuple(sorted((n["pitch"], n["start"]) for n in detect_notes(img, axes))) for _ in range(3)}
check("detect_notes deterministic x3", len(runs) == 1)

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
