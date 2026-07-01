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

# ── keyboard-gutter ABSOLUTE pitch anchor (detect_axes) ──────────────────────────────────────
from teardown.midi_from_screen.axes import detect_axes  # noqa: E402

BLACK = {1, 3, 6, 8, 10}


def gutter_roll(top_true, rh=10, pb=40, nrows=36, nbeats=8, gw=60, note_pitch=72, note_beat=2):
    """A piano roll WITH a left keyboard gutter (black keys dark, white keys light) whose top row is
    `top_true` — plus a saturated note at note_pitch. detect_axes should anchor top_midi to top_true
    (pitch class), so detect_notes reads note_pitch absolutely. Single full-width lane lines (one per
    semitone, as a real roll draws them) keep row_h detection clean."""
    W = gw + nbeats * pb
    H = nrows * rh
    im = np.full((H, W, 3), 30, np.uint8)
    for r in range(nrows):                                          # gutter key fill (between lanes)
        cls = (top_true - r) % 12
        shade = (45, 45, 45) if cls in BLACK else (205, 205, 205)
        cv2.rectangle(im, (0, r * rh + 1), (gw, r * rh + rh - 1), shade, -1)
    for r in range(nrows + 1):                                      # one full-width lane line per row
        cv2.line(im, (0, r * rh), (W, r * rh), (110, 110, 110), 1)
    for b in range(nbeats):
        cv2.line(im, (gw + b * pb, 0), (gw + b * pb, H), (80, 80, 80), 1)
    row = top_true - note_pitch
    y1 = int(rh / 2 + row * rh - rh / 2)
    x1 = gw + note_beat * pb
    cv2.rectangle(im, (x1, y1), (x1 + 2 * pb - 2, y1 + rh - 1), (0, 200, 0), -1)  # saturated note
    return im


# The gutter fixes the pitch CLASS (note names / intervals) — the robust, high-value part. The
# absolute OCTAVE needs a label (not OCR-free), so the octave is anchored near the default.
# top=79 (class G=7): the class-correct pitch nearest the 84 default is 79 itself → exact pitch.
roll79 = gutter_roll(79, note_pitch=72)
ax = detect_axes(roll79)
check("gutter anchors the top row's pitch CLASS (79 ≡ G)", ax.top_midi % 12 == 79 % 12, str(ax.top_midi))
gnotes = detect_notes(roll79, ax)
check("note reads the correct pitch CLASS (72 ≡ C); here exact since 79 sits near the default",
      any(n["pitch"] % 12 == 0 for n in gnotes) and any(n["pitch"] == 72 for n in gnotes),
      str([n["pitch"] for n in gnotes]))
# WITHOUT the anchor the same note (true C) would read the WRONG class (top stuck at 84 → F) —
# this is the bug the anchor fixes.
no_anchor = detect_notes(roll79, Axes(pitch_top_y=ax.pitch_top_y, row_h=ax.row_h, top_midi=84,
                                      time_left_x=0.0, px_per_beat=ax.px_per_beat))
check("without the anchor the class is WRONG (proves the anchor is load-bearing)",
      all(n["pitch"] % 12 != 0 for n in no_anchor), str([n["pitch"] for n in no_anchor]))
# a different scroll (top=60 ≡ C): class recovered (note 55 ≡ G reads as class G)
ax60 = detect_axes(gutter_roll(60, note_pitch=55))
check("a differently-scrolled roll recovers its pitch class (top 60 ≡ C)", ax60.top_midi % 12 == 0,
      str(ax60.top_midi))
check("its note reads the correct class (55 ≡ G)",
      any(n["pitch"] % 12 == 55 % 12 for n in detect_notes(gutter_roll(60, note_pitch=55), ax60)))

# CONSERVATIVE: a gutter-less roll (no keyboard) → keep the honest default (84), never a wrong anchor
no_gutter = np.full((360, 8 * 40, 3), 30, np.uint8)
for r in range(36):
    cv2.line(no_gutter, (0, r * 10), (no_gutter.shape[1], r * 10), (110, 110, 110), 1)
check("gutter-less roll → top_midi stays the default (no false anchor)",
      detect_axes(no_gutter).top_midi == 84, str(detect_axes(no_gutter).top_midi))
check("gutter anchor deterministic x3", len({detect_axes(roll79).top_midi for _ in range(3)}) == 1)

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
