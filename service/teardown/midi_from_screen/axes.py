"""Piano-roll axes — the pitch (y→MIDI) and time (x→beat) mapping. `Axes` carries the
calibrated mapping; `detect_axes` infers it from a frame via the grid + keyboard gutter
(per-DAW heuristic; rough — the real per-profile tuning needs real clips, gated). The
note-detection core (notes.py) takes `Axes` and is fully testable.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class Axes:
    pitch_top_y: float    # y (px) of the TOP row's centre
    row_h: float          # px per semitone row (rows go DOWN = lower pitch)
    top_midi: int         # MIDI pitch of the top row
    time_left_x: float    # x (px) of beat 0
    px_per_beat: float    # px per beat


_BLACK_CLASSES = frozenset({1, 3, 6, 8, 10})   # C#, D#, F#, G#, A# — the black keys, from C=0


def _keyboard_top_pitch(gray, row_h: float, pitch_top_y: float, default_top: int) -> int | None:
    """Anchor the TOP row's MIDI pitch ABSOLUTELY by reading the piano-keyboard gutter (the left
    strip). Black keys (C#/D#/F#/G#/A#) render darker than the white keys; their 12-row pattern is
    unique, so its phase fixes which rows are C → the top row's pitch CLASS. Without this, detect_axes
    assumes the top row is a fixed default (84/C6), so a scrolled roll reads the WRONG note names
    (not just the wrong octave). The absolute OCTAVE across arbitrary DAW skins still needs a label,
    so we keep `default_top`'s octave — the robust, high-value part is the pitch class.

    CONSERVATIVE: returns None (caller keeps the default) unless the gutter shows a clean keyboard —
    a real dark/light spread AND the black-key pattern matching ≥0.85 of rows over ≥1 octave. A
    confidently-WRONG anchor would mislabel every note, so the bar to override is high. OCR-free."""
    import numpy as np

    h, gw = gray.shape[0], gray.shape[1]
    gutter_w = max(6, int(round(gw * 0.05)))
    n = int((h - pitch_top_y) / row_h) if row_h > 0 else 0
    if n < 12 or gutter_w < 3:
        return None
    bright = []
    half = max(1, int(row_h * 0.3))
    for r in range(n):
        y = int(round(pitch_top_y + r * row_h))
        y0, y1 = max(0, y - half), min(h, y + half + 1)
        if y1 <= y0:
            return None
        bright.append(float(gray[y0:y1, :gutter_w].mean()))
    b = np.asarray(bright)
    if b.size < 12 or (b.max() - b.min()) < 25.0:      # no clear dark/light keys → not a keyboard
        return None
    is_black = b < (b.max() + b.min()) / 2.0
    best_tc, best_agree = 0, 0.0
    for tc in range(12):
        pred = np.array([((tc - r) % 12) in _BLACK_CLASSES for r in range(len(is_black))])
        agree = float((pred == is_black).mean())
        if agree > best_agree:
            best_agree, best_tc = agree, tc
    if best_agree < 0.85:                                # pattern doesn't read as a keyboard → bail
        return None
    base = default_top - ((default_top - best_tc) % 12)  # nearest pitch <= default with class best_tc
    return int(min((base, base + 12), key=lambda p: abs(p - default_top)))


def detect_axes(img: np.ndarray, top_midi: int = 84, px_per_beat: float | None = None) -> Axes:
    """Best-effort axis inference: grid spacing (median horizontal-line gap → row_h, vertical →
    px_per_beat) + an absolute pitch anchor from the keyboard gutter when one is cleanly visible
    (else `top_midi` stays the default — honest). Rough; per-DAW profiles refine it."""
    import cv2

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    h, w = gray.shape[:2]
    edges = cv2.Canny(gray, 40, 120)
    # row spacing: count edge density per row, find the dominant period
    row_profile = edges.sum(axis=1)
    col_profile = edges.sum(axis=0)

    def _period(profile, lo, hi):
        idx = np.where(profile > profile.mean() + profile.std())[0]
        if idx.size < 2:
            return None
        # a drawn grid line yields a rising AND a falling Canny edge ~1-2px apart; measuring raw
        # consecutive gaps then alternates [line_width, spacing] and the median lands on the wrong
        # value (e.g. 8 for a 10px grid). Merge edges within a couple px into one LINE, then take the
        # gap between line CENTERS — the true period.
        lines = []
        run = [int(idx[0])]
        for v in idx[1:]:
            if v - run[-1] <= 2:
                run.append(int(v))
            else:
                lines.append(sum(run) / len(run))
                run = [int(v)]
        lines.append(sum(run) / len(run))
        if len(lines) < 2:
            return None
        gaps = np.diff(lines)
        gaps = gaps[(gaps >= lo) & (gaps <= hi)]
        return float(np.median(gaps)) if gaps.size else None

    row_h = _period(row_profile, 3, h // 8) or 8.0
    ppb = px_per_beat or (_period(col_profile, 8, w // 2) or 40.0)
    pitch_top_y = row_h / 2
    anchored = _keyboard_top_pitch(gray, row_h, pitch_top_y, top_midi)
    if anchored is not None:
        top_midi = anchored
    return Axes(pitch_top_y=pitch_top_y, row_h=row_h, top_midi=top_midi, time_left_x=0.0, px_per_beat=ppb)
