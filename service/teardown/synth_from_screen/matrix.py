"""Modulation-matrix reader — read a synth's MATRIX/routing page into a list of routings.

A synth's mod matrix is a TABLE: one row per routing, with a SOURCE cell, an AMOUNT control
(a horizontal slider or a knob) and a DESTINATION cell. This module reads each row's AMOUNT
(the load-bearing CV — `read_knob` for knobs, an analogous track-position read for sliders) and,
best-effort, OCRs the source/dest text. It returns ONE dict per OCCUPIED row.

The hard correctness bar is the EMPTY matrix: an init patch has blank rows whose amount slider
sits CENTERED (bipolar 0 = no modulation) and whose source/dest cells show a placeholder "-".
A naive read would invent a routing from every such row (centered handle reads "0.5", the dash
glyph reads as text). So a row counts as ACTIVE only when its amount is meaningfully away from
the row's neutral point AND/OR its source/dest cells are non-empty — see `_row_active`. When in
doubt this UNDER-reports (returns []) rather than hallucinating routings on a blank matrix.

A per-synth profile declares its matrix in a `"matrix"` block (reference-pixel space, scaled to
the frame exactly like page_detect._load_tabs / export.load_profile):

    "matrix": {
        "header_y": <y>,            # the column-label row (reference px)
        "row0_y":   <y>,            # vertical CENTER of the first routing row
        "row_h":    <px>,           # row pitch (center-to-center)
        "rows":     <int>,          # number of routing rows the page shows
        "amount": {                 # the AMOUNT control geometry, per row (x is row-invariant)
            "type": "slider"|"knob",
            "x0": <x>, "x1": <x>,   # slider: track endpoints (value 0..1 across [x0,x1])
            "neutral": 0.5,         # slider/knob value that means "no modulation" (bipolar center)
            "cx": <x>, "r": <px>,   # knob: center-x + radius (cy comes from the row)
            "sweep_deg": 270.0, "pointer": "white"|"blue_tick"|null
        },
        "source": {"x0": <x>, "x1": <x>},        # source cell x-range (for OCR + occupancy)
        "destination": {"x0": <x>, "x1": <x>},   # destination cell x-range
        "active_amount_eps": 0.04   # |amount-neutral| must exceed this for a row to count active
    }
"""
from __future__ import annotations

import json
import os

import numpy as np

from .controls import read_knob

PROFILE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "profiles")


def _load_matrix(synth: str, frame_w: int, frame_h: int) -> dict | None:
    """Load + scale a profile's `matrix` block to the actual frame size. None if the profile is
    missing or has no matrix block (caller then returns [] — never raises)."""
    if not synth:
        return None
    path = os.path.join(PROFILE_DIR, f"{synth.lower()}.json")
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        data = json.load(f)
    mx = data.get("matrix")
    if not mx:
        return None
    ref_w, ref_h = data.get("reference_size", [frame_w, frame_h])
    sx, sy = frame_w / float(ref_w), frame_h / float(ref_h)
    s = (sx + sy) / 2.0

    def _cell(c: dict | None) -> dict | None:
        if not c:
            return None
        out = dict(c)
        if "x0" in out:
            out["x0"] = int(round(out["x0"] * sx))
        if "x1" in out:
            out["x1"] = int(round(out["x1"] * sx))
        if "cx" in out:
            out["cx"] = int(round(out["cx"] * sx))
        if "r" in out:
            out["r"] = int(round(out["r"] * s))
        return out

    return {
        "header_y": int(round(mx.get("header_y", 0) * sy)),
        "row0_y": int(round(mx.get("row0_y", 0) * sy)),
        "row_h": max(1, int(round(mx.get("row_h", 1) * sy))),
        "rows": int(mx.get("rows", 0)),
        "amount": _cell(mx.get("amount")) or {},
        "source": _cell(mx.get("source")),
        "destination": _cell(mx.get("destination")),
        "active_amount_eps": float(mx.get("active_amount_eps", 0.04)),
    }


def _read_slider_value(gray: np.ndarray, x0: int, x1: int, cy: int, row_h: int) -> dict:
    """A horizontal slider's value = the HANDLE's x-position normalized across [x0, x1]. The handle
    is the BRIGHTEST contiguous blob on the track row (Vital draws an unfilled track at the table-bg
    level with a distinctly lighter handle). Returns {"value": 0..1, "confidence"}; confidence 0 if
    no clear handle stands out (then the row reads as neutral/inactive, never a false routing)."""
    h, w = gray.shape[:2]
    if x1 <= x0:
        return {"value": 0.5, "confidence": 0.0}
    band_h = max(2, int(round(row_h * 0.35)))
    y0 = max(0, cy - band_h // 2)
    y1 = min(h, cy + band_h // 2 + 1)
    xa, xb = max(0, x0), min(w, x1)
    if y1 <= y0 or xb <= xa:
        return {"value": 0.5, "confidence": 0.0}
    strip = gray[y0:y1, xa:xb].astype(np.float32)
    col = strip.mean(axis=0)                       # per-column brightness along the track
    base = float(np.median(col))                   # the track/cell background level
    peak = float(col.max())
    # the handle must stand clearly above the track background; a flat strip (no handle / occluded)
    # gives no confident read → treat as neutral.
    if peak - base < 12.0:
        return {"value": 0.5, "confidence": 0.0}
    thr = base + 0.5 * (peak - base)
    hot = col >= thr
    idx = np.flatnonzero(hot)
    if idx.size == 0:
        return {"value": 0.5, "confidence": 0.0}
    # weight by how far each hot column rises above background → the handle centroid
    wgt = np.clip(col[idx] - base, 0.0, None)
    cx_local = float((idx * wgt).sum() / (wgt.sum() or 1.0))
    span = float(xb - 1 - xa) or 1.0
    value = min(1.0, max(0.0, cx_local / span))
    # a clean handle is a compact blob; a huge hot set means we caught the whole cell (low conf).
    frac = float(idx.size) / float(col.size)
    conf = 0.7 if frac <= 0.6 else 0.45
    return {"value": round(value, 3), "confidence": conf}


def _cell_nonempty(gray: np.ndarray, cell: dict | None, cy: int, row_h: int) -> bool:
    """Best-effort occupancy: does this source/dest cell hold more than its empty placeholder?

    An EMPTY Vital cell is a dark rounded pill with a tiny centered "-" dash (a few faint pixels).
    A POPULATED cell carries a wider label (a long bright run) or a coloured chip. We flag the cell
    occupied only when there is a SUBSTANTIAL bright/contrasting run — conservative on purpose, so
    the single-dash placeholder never counts as a routing."""
    if not cell or "x0" not in cell or "x1" not in cell:
        return False
    h, w = gray.shape[:2]
    x0, x1 = max(0, cell["x0"]), min(w, cell["x1"])
    band_h = max(2, int(round(row_h * 0.5)))
    y0 = max(0, cy - band_h // 2)
    y1 = min(h, cy + band_h // 2 + 1)
    if x1 <= x0 or y1 <= y0:
        return False
    sub = gray[y0:y1, x0:x1].astype(np.float32)
    base = float(np.median(sub))                   # the pill/cell background
    contrast = sub - base
    # count columns containing a pixel clearly above the cell background (text/chip ink)
    ink_cols = int((contrast.max(axis=0) > 28.0).sum())
    width = max(1, x1 - x0)
    # the "-" placeholder is a single short glyph (a few % of the cell width); real labels are wide.
    return (ink_cols / float(width)) > 0.18


def _row_active(amount: dict, src_filled: bool, dst_filled: bool,
                neutral: float, eps: float) -> bool:
    """A row is a real routing iff its source/dest cell is populated, OR its amount is confidently
    away from the neutral (bipolar-center) point. A centered amount on a blank row (the init-patch
    case) is NOT active."""
    if src_filled or dst_filled:
        return True
    if amount.get("confidence", 0.0) <= 0.0:
        return False
    return abs(amount.get("value", neutral) - neutral) > eps


def read_matrix(img_bgr, synth) -> list[dict]:
    """Read the modulation matrix on `synth`'s MATRIX page.

    Returns a list (one dict per OCCUPIED row):
        {"row": i, "amount": <0..1>, "active": True,
         "source": "<text or ''>", "destination": "<text or ''>"}

    An EMPTY matrix (all rows blank, amount sliders centered) returns [] — it does NOT invent
    routings from the placeholder dash or the centered handle. Unknown synth / missing matrix
    block / a grayscale frame all return [] without raising. OCR is best-effort (low confidence);
    when it yields nothing the source/destination strings stay "".
    """
    if img_bgr is None or not hasattr(img_bgr, "shape") or img_bgr.ndim < 2:
        return []
    h, w = img_bgr.shape[:2]
    cfg = _load_matrix(synth, w, h)
    if not cfg or cfg["rows"] <= 0:
        return []

    import cv2

    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY) if img_bgr.ndim == 3 else img_bgr
    bgr = img_bgr if img_bgr.ndim == 3 else None

    amt = cfg["amount"]
    neutral = float(amt.get("neutral", 0.5))
    eps = cfg["active_amount_eps"]
    out: list[dict] = []
    for i in range(cfg["rows"]):
        cy = cfg["row0_y"] + i * cfg["row_h"]
        if cy < 0 or cy >= h:
            continue

        kind = amt.get("type", "slider")
        if kind == "knob" and "cx" in amt and "r" in amt:
            r = read_knob(gray, amt["cx"], cy, amt["r"],
                          sweep_deg=amt.get("sweep_deg", 270.0),
                          dark_pointer=amt.get("dark_pointer", True),
                          img_bgr=bgr, pointer=amt.get("pointer"))
        else:
            r = _read_slider_value(gray, amt.get("x0", 0), amt.get("x1", 0), cy, cfg["row_h"])

        src_filled = _cell_nonempty(gray, cfg["source"], cy, cfg["row_h"])
        dst_filled = _cell_nonempty(gray, cfg["destination"], cy, cfg["row_h"])

        if not _row_active(r, src_filled, dst_filled, neutral, eps):
            continue

        # best-effort OCR of the source/dest cell text (only for rows we already deemed active).
        source_text, dest_text = "", ""
        if bgr is not None:
            source_text = _ocr_cell(bgr, cfg["source"], cy, cfg["row_h"])
            dest_text = _ocr_cell(bgr, cfg["destination"], cy, cfg["row_h"])

        out.append({
            "row": i,
            "amount": round(float(r.get("value", neutral)), 3),
            "active": True,
            "source": source_text,
            "destination": dest_text,
        })
    return out


def _ocr_cell(img_bgr, cell: dict | None, cy: int, row_h: int) -> str:
    """Best-effort OCR of a source/dest cell → text (or '' on any failure / missing tesseract).
    Wrapped so a missing OCR backend never breaks the read."""
    if not cell or "x0" not in cell or "x1" not in cell:
        return ""
    try:
        from ..vision.ocr import ocr_text
    except Exception:
        return ""
    x0, x1 = cell["x0"], cell["x1"]
    band_h = max(2, int(round(row_h * 0.7)))
    y0 = max(0, cy - band_h // 2)
    region = (int(x0), int(y0), int(max(1, x1 - x0)), int(band_h))
    try:
        return ocr_text(img_bgr, region).strip()
    except Exception:
        return ""
