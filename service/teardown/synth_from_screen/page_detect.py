"""Tab/page detection — which page of a synth GUI is on screen, so §5b loads the right page
profile. Reads the active-tab indicator (a coloured underline in Vital, a green dot in Serum)
from the tab strip and maps it to the nearest tab anchor. Pure CV (no OCR) → hermetic.

A synth profile declares its tab strip in a `"tabs"` block (reference-pixel space, scaled to
the frame like the control coords):
    "tabs": {"band": [y0, y1], "highlight": "green"|"saturated", "anchors": {name: x, ...}}

`detect_active_tab(img, synth)` returns {"tab", "confidence", "peak_x"}. The synth is normally
known from §4 (the tutorial's plugin-name OCR/metadata); `identify_synth` is a best-effort
fallback that picks whichever profile yields the strongest, cleanest highlight.
"""
from __future__ import annotations

import json
import os

import numpy as np

PROFILE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "profiles")


def _load_tabs(synth: str, frame_w: int, frame_h: int) -> dict | None:
    """Load + scale a profile's tab strip to the actual frame size. None if the profile has no
    tabs block."""
    path = os.path.join(PROFILE_DIR, f"{synth.lower()}.json")
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        data = json.load(f)
    tabs = data.get("tabs")
    if not tabs or not tabs.get("anchors"):
        return None
    ref_w, ref_h = data.get("reference_size", [frame_w, frame_h])
    sx, sy = frame_w / float(ref_w), frame_h / float(ref_h)
    y0, y1 = tabs.get("band", [0, 0])
    return {
        "band": [int(round(y0 * sy)), int(round(y1 * sy))],
        "highlight": tabs.get("highlight", "saturated"),
        # x-window (scaled) restricts the search to the tab row, excluding the synth logo on
        # the left and the preset/menu area on the right (both can carry saturated pixels).
        "x_min": int(round(tabs.get("x_min", 0) * sx)),
        "x_max": int(round(tabs.get("x_max", ref_w) * sx)),
        "anchors": {n: x * sx for n, x in tabs["anchors"].items()},
        "min_count": tabs.get("min_count", 2),
    }


def _highlight_columns(img: np.ndarray, band: list[int], kind: str) -> np.ndarray:
    """Per-column count of active-indicator pixels in the tab-strip band."""
    import cv2

    y0, y1 = max(0, band[0]), min(img.shape[0], band[1])
    if y1 <= y0:
        return np.zeros(img.shape[1])
    hsv = cv2.cvtColor(img[y0:y1], cv2.COLOR_BGR2HSV) if img.ndim == 3 else None
    if hsv is None:
        return np.zeros(img.shape[1])
    H, S, V = hsv[..., 0].astype(np.float32), hsv[..., 1].astype(np.float32), hsv[..., 2].astype(np.float32)
    if kind == "green":
        mask = (S > 70) & (V > 95) & (H > 30) & (H < 95)
    else:  # "saturated" — any vivid hue (the accent underline) vs the grey inactive tabs
        mask = (S > 60) & (V > 80)
    return mask.sum(axis=0).astype(np.float32)


def detect_active_tab(img: np.ndarray, synth: str) -> dict:
    """Which tab is active in this `synth` frame. {"tab", "confidence", "peak_x"}; tab=None if
    no indicator is found (wrong synth / occluded / not a GUI frame)."""
    cfg = _load_tabs(synth, img.shape[1], img.shape[0])
    if not cfg:
        return {"tab": None, "confidence": 0.0, "peak_x": None}
    cols = _highlight_columns(img, cfg["band"], cfg["highlight"])
    x0 = max(0, cfg["x_min"])
    x1 = min(len(cols), cfg["x_max"]) if cfg["x_max"] > 0 else len(cols)
    cols[:x0] = 0.0
    cols[x1:] = 0.0
    if cols.max() < cfg["min_count"]:
        return {"tab": None, "confidence": 0.0, "peak_x": None}
    peak_x = int(np.argmax(cols))
    name, dist = min(((n, abs(peak_x - x)) for n, x in cfg["anchors"].items()), key=lambda t: t[1])
    # spacing sets the "is it clearly this tab" scale; confidence falls off with distance.
    xs = sorted(cfg["anchors"].values())
    spacing = min((b - a for a, b in zip(xs, xs[1:])), default=float(img.shape[1]))
    conf = max(0.0, min(1.0, 1.0 - (dist / (0.5 * spacing)))) if spacing > 0 else 0.0
    return {"tab": name, "confidence": round(conf, 3), "peak_x": peak_x}


def identify_synth(img: np.ndarray, candidates: list[str] | None = None) -> dict:
    """Best-effort: try each candidate profile's tab detection and return the synth whose
    highlight is strongest + best-localized. {"synth", "tab", "confidence"}."""
    if candidates is None:
        candidates = [f[:-5] for f in os.listdir(PROFILE_DIR) if f.endswith(".json")]
    best = {"synth": None, "tab": None, "confidence": 0.0}
    for synth in candidates:
        r = detect_active_tab(img, synth)
        if r["tab"] and r["confidence"] > best["confidence"]:
            best = {"synth": synth, "tab": r["tab"], "confidence": r["confidence"]}
    return best
