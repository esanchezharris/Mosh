"""Note detection — the generic CV core. Note blocks are SATURATED/coloured rectangles
distinct from the desaturated grid; connected-components on the saturation mask → boxes →
(pitch, start, end) via the calibrated `Axes`. Robust to per-track colouring (works on
saturation, not a fixed colour). The masking heuristic is the per-DAW profile knob.
"""
from __future__ import annotations

import numpy as np

from .axes import Axes


def detect_notes(img: np.ndarray, axes: Axes, sat_thresh: int = 70, min_area: int = 12,
                 default_velocity: int = 90) -> list[dict]:
    """Returns notes [{pitch, start, end, velocity}] (start/end in BEATS), time-ordered."""
    import cv2

    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    mask = (hsv[:, :, 1] > sat_thresh).astype(np.uint8) * 255   # coloured (note) pixels
    n, _lab, stats, _cent = cv2.connectedComponentsWithStats(mask, connectivity=8)
    notes: list[dict] = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if area < min_area or w < 2:
            continue
        cy = y + h / 2.0
        pitch = int(round(axes.top_midi - (cy - axes.pitch_top_y) / axes.row_h))
        start = (x - axes.time_left_x) / axes.px_per_beat
        end = (x + w - axes.time_left_x) / axes.px_per_beat
        notes.append({"pitch": pitch, "start": round(max(0.0, start), 3),
                      "end": round(max(0.0, end), 3), "velocity": default_velocity})
    notes.sort(key=lambda nn: (nn["start"], nn["pitch"]))
    return notes
