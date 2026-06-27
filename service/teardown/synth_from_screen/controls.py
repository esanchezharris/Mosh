"""Per-control readers. `read_knob` recovers a 0–1 value from the indicator-pointer angle
(the core CV); `read_toggle` from region brightness; `read_menu` via OCR. Angle convention:
clockwise from 12-o'clock, value 0 at -sweep/2 (down-left) → value 1 at +sweep/2 (down-right).
"""
from __future__ import annotations

import math

import numpy as np


def read_knob(gray: np.ndarray, cx: int, cy: int, r: int, sweep_deg: float = 270.0,
              dark_pointer: bool = True) -> dict:
    """Return {value (0–1), confidence}. The pointer is the dark (or bright) radial mark."""
    h, w = gray.shape[:2]
    y0, y1 = max(0, cy - r), min(h, cy + r)
    x0, x1 = max(0, cx - r), min(w, cx + r)
    sub = gray[y0:y1, x0:x1].astype(np.float32)
    if sub.size == 0:
        return {"value": 0.5, "confidence": 0.0}
    ys, xs = np.mgrid[y0:y1, x0:x1]
    dx = xs - cx
    dy = ys - cy
    rr = dx * dx + dy * dy
    within = (rr <= r * r) & (rr > (0.25 * r) ** 2)        # exclude the hub
    m = float(sub.mean())
    pointer = ((sub < m - 18) if dark_pointer else (sub > m + 18)) & within
    if int(pointer.sum()) < 3:
        return {"value": 0.5, "confidence": 0.0}
    mx = float(dx[pointer].mean())
    my = float(dy[pointer].mean())
    phi = math.degrees(math.atan2(mx, -my))               # clockwise from top: 0=up, +90=right
    half = sweep_deg / 2.0
    value = min(1.0, max(0.0, (phi + half) / sweep_deg))
    return {"value": round(value, 3), "confidence": 0.5}   # approximate by nature → mid confidence


def read_toggle(gray: np.ndarray, region: tuple, on_thresh: float = 128.0) -> dict:
    x, y, w, h = region
    sub = gray[y:y + h, x:x + w]
    if sub.size == 0:
        return {"on": False, "confidence": 0.0}
    return {"on": float(sub.mean()) > on_thresh, "confidence": 0.4}


def read_menu(img: np.ndarray, region: tuple) -> dict:
    from ..vision.ocr import ocr_text
    text = ocr_text(img, region).strip()
    return {"text": text, "confidence": 0.5 if text else 0.0}
