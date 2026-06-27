"""Per-control readers. `read_knob` recovers a 0–1 value from the indicator angle (the core
CV); `read_toggle` from region brightness; `read_menu` via OCR. Angle convention: clockwise
from 12-o'clock, value 0 at -sweep/2 (down-left) → value 1 at +sweep/2 (down-right).

Indicator styles:
  • dark/bright pointer  — a single radial mark; its angular centroid IS the value (generic).
  • "white" pointer      — a bright, LOW-SATURATION radial line (Vital, Serum, most modern
                           synths) drawn ON TOP of a saturated colour fill-arc. Reading all
                           bright pixels would fold the fill-arc into the centroid (a full
                           arc's centroid sits at the top → every high value reads ~0.5); so
                           "white" mode isolates the colourless pointer from the coloured arc
                           by saturation, giving an ACCURATE absolute read. Needs the colour
                           frame (passed as img_bgr).
"""
from __future__ import annotations

import math

import numpy as np


def _angle_value(dx: float, dy: float, sweep_deg: float) -> float:
    phi = math.degrees(math.atan2(dx, -dy))               # clockwise from top: 0=up, +90=right
    half = sweep_deg / 2.0
    return min(1.0, max(0.0, (phi + half) / sweep_deg))


def read_knob(gray: np.ndarray, cx: int, cy: int, r: int, sweep_deg: float = 270.0,
              dark_pointer: bool = True, img_bgr: np.ndarray | None = None,
              pointer: str | None = None) -> dict:
    """Return {value (0–1), confidence}.

    pointer="white" (with img_bgr): isolate the colourless pointer line (bright + desaturated)
    from any coloured fill-arc → accurate absolute value. Otherwise read the dark/bright radial
    mark off the grayscale (the generic path; backward-compatible)."""
    h, w = gray.shape[:2]
    y0, y1 = max(0, cy - r), min(h, cy + r)
    x0, x1 = max(0, cx - r), min(w, cx + r)
    if y1 <= y0 or x1 <= x0:
        return {"value": 0.5, "confidence": 0.0}
    ys, xs = np.mgrid[y0:y1, x0:x1]
    dx = (xs - cx).astype(np.float32)
    dy = (ys - cy).astype(np.float32)
    rr = dx * dx + dy * dy
    within = (rr <= r * r) & (rr > (0.30 * r) ** 2)        # exclude the hub

    # white mode needs a 3-channel colour frame whose geometry matches `gray` (so the bbox and
    # the `within` mask line up); anything else falls through to the grayscale path rather than
    # raising on a shape/channel mismatch.
    white_ok = (pointer == "white" and img_bgr is not None and img_bgr.ndim == 3
                and img_bgr.shape[:2] == gray.shape[:2])
    if white_ok:
        sub = img_bgr[y0:y1, x0:x1].astype(np.float32)
        b, g, rc = sub[..., 0], sub[..., 1], sub[..., 2]
        mx = np.maximum(np.maximum(b, g), rc)
        chroma = mx - np.minimum(np.minimum(b, g), rc)
        # The pointer is COLOURLESS (low chroma) → this excludes the saturated colour fill-arc.
        # Crucially we do NOT assume an absolute pointer brightness: the pointer is read RELATIVE
        # to the knob's own body brightness, so a white pointer on a dark body (Vital/Serum 2)
        # AND a dark pointer on a light body (light skins / Serum 1) both work. Reading an
        # absolute-bright mask would let a light-grey knob body flood the centroid → wrong value.
        lowchroma = (chroma <= 60.0) & within
        if int(lowchroma.sum()) < 4:
            return {"value": 0.5, "confidence": 0.0}
        body = float(np.median(mx[lowchroma]))            # the dominant knob-face brightness
        dev_signed = np.where(lowchroma, mx - body, 0.0)
        pos_peak = float(dev_signed.max())                # brightest colourless pixel above body
        neg_peak = float(-dev_signed.min())               # darkest colourless pixel below body
        # choose the pointer's polarity (bright pointer on a dark body, OR dark pointer on a light
        # body) by whichever extreme is stronger, then keep only the pointer CORE — pixels within
        # ~60% of that extreme. That excludes the knob's mid-level 3D rim/shadow shading (which a
        # naive |dev| mask would fold in and skew the angle).
        if pos_peak >= neg_peak:
            thr = max(30.0, 0.6 * pos_peak)
            pmask = lowchroma & (dev_signed >= thr)
        else:
            thr = max(30.0, 0.6 * neg_peak)
            pmask = lowchroma & (dev_signed <= -thr)
        if int(pmask.sum()) < 3:
            return {"value": 0.5, "confidence": 0.0}
        wgt = np.where(pmask, np.abs(dev_signed), 0.0)
        tot = float(wgt.sum()) or 1.0
        mxr = float((dx * wgt).sum() / tot)
        myr = float((dy * wgt).sum() / tot)
        value = _angle_value(mxr, myr, sweep_deg)
        # confidence falls if the deviating set is too large (a flood, not a clean line).
        n = int(pmask.sum())
        conf = 0.75 if 6 <= n <= 0.3 * float(within.sum()) else 0.6
        return {"value": round(value, 3), "confidence": conf}

    sub = gray[y0:y1, x0:x1].astype(np.float32)
    if sub.size == 0:
        return {"value": 0.5, "confidence": 0.0}
    m = float(sub.mean())
    pmask = ((sub < m - 18) if dark_pointer else (sub > m + 18)) & within
    if int(pmask.sum()) < 3:
        return {"value": 0.5, "confidence": 0.0}
    value = _angle_value(float(dx[pmask].mean()), float(dy[pmask].mean()), sweep_deg)
    return {"value": round(value, 3), "confidence": 0.5}    # approximate by nature → mid confidence


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
