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


def detect_axes(img: np.ndarray, top_midi: int = 84, px_per_beat: float | None = None) -> Axes:
    """Best-effort axis inference from grid spacing (median horizontal-line gap → row_h,
    median vertical-line gap → px_per_beat). Rough; per-DAW profiles refine it."""
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
        gaps = np.diff(idx)
        gaps = gaps[(gaps >= lo) & (gaps <= hi)]
        return float(np.median(gaps)) if gaps.size else None

    row_h = _period(row_profile, 3, h // 8) or 8.0
    ppb = px_per_beat or (_period(col_profile, 8, w // 2) or 40.0)
    return Axes(pitch_top_y=row_h / 2, row_h=row_h, top_midi=top_midi, time_left_x=0.0, px_per_beat=ppb)
