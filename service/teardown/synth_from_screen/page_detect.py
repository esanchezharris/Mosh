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

from .calib import axis_map

PROFILE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "profiles")


def _load_tabs(synth: str, img: np.ndarray) -> dict | None:
    """Load + map a profile's tab strip onto the actual frame, HOST-INVARIANTLY (the tab band's
    y is offset by the logo-landmark match, so it lands on the dots row regardless of the host's
    title-bar height — a band located by proportional scaling alone slides off the strip when the
    chrome differs, e.g. Ableton vs Mosh). None if the profile has no tabs block."""
    path = os.path.join(PROFILE_DIR, f"{synth.lower()}.json")
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        data = json.load(f)
    tabs = data.get("tabs")
    if not tabs or not tabs.get("anchors"):
        return None
    cal = axis_map(data, img.shape[1], img.shape[0], img)
    ref_w = data.get("reference_size", [img.shape[1], img.shape[0]])[0]
    y0, y1 = tabs.get("band", [0, 0])
    return {
        "band": [cal.y(y0), cal.y(y1)],
        "highlight": tabs.get("highlight", "saturated"),
        # x-window (scaled) restricts the search to the tab row, excluding the synth logo on
        # the left and the preset/menu area on the right (both can carry saturated pixels).
        "x_min": cal.x(tabs.get("x_min", 0)),
        "x_max": cal.x(tabs.get("x_max", ref_w)),
        "anchors": {n: cal.x(x) for n, x in tabs["anchors"].items()},
        "min_count": tabs.get("min_count", 2),
    }


def _highlight_columns(img: np.ndarray, band: list[int], kind: str) -> np.ndarray:
    """Per-column count of active-indicator pixels in the tab-strip band. The cutoff is ADAPTIVE
    (band-median + margin), so it stands the indicator out across skins/accent strengths rather
    than assuming one absolute level."""
    import cv2

    y0, y1 = max(0, band[0]), min(img.shape[0], band[1])
    if y1 <= y0 or img.ndim != 3:
        return np.zeros(img.shape[1] if img.ndim >= 2 else 1, np.float32)
    hsv = cv2.cvtColor(img[y0:y1], cv2.COLOR_BGR2HSV)
    H, S, V = hsv[..., 0].astype(np.float32), hsv[..., 1].astype(np.float32), hsv[..., 2].astype(np.float32)
    s_thr = max(45.0, float(np.median(S)) + 35.0)        # adaptive: the indicator out-saturates the strip
    if kind == "green":
        mask = (S > s_thr) & (V > 60.0) & (H > 30.0) & (H < 95.0)
    elif kind == "bright":
        # hue+saturation AGNOSTIC: the active dot is simply BRIGHTER than the dim grey inactive
        # dots, whatever its hue. Serum's active-tab dot renders green (Mosh/standalone), blue
        # (Ableton), OR white (the MIX tab) — only brightness is invariant across all of them.
        v_thr = max(120.0, float(np.median(V)) + 60.0)
        mask = V > v_thr
    else:  # "saturated" — the accent underline/dot vs the grey inactive tabs
        mask = (S > s_thr) & (V > 60.0)
    return mask.sum(axis=0).astype(np.float32)


def detect_active_tab(img: np.ndarray, synth: str) -> dict:
    """Which tab is active in this `synth` frame. {"tab", "confidence", "peak_x"}; tab=None if
    no indicator is found (wrong synth / occluded / not a GUI frame). The x-window keeps the synth
    logo / preset area out; the saturation cutoff is adaptive (see _highlight_columns)."""
    cfg = _load_tabs(synth, img)
    if not cfg:
        return {"tab": None, "confidence": 0.0, "peak_x": None}
    cols = _highlight_columns(img, cfg["band"], cfg["highlight"])
    x0 = max(0, cfg["x_min"])
    x1 = min(len(cols), cfg["x_max"]) if cfg["x_max"] > 0 else len(cols)
    cols[:x0] = 0.0
    cols[x1:] = 0.0
    strength = float(cols.max())
    if strength < cfg["min_count"]:
        return {"tab": None, "confidence": 0.0, "peak_x": None, "strength": 0.0}
    peak_x = int(np.argmax(cols))
    name, dist = min(((n, abs(peak_x - x)) for n, x in cfg["anchors"].items()), key=lambda t: t[1])
    xs = sorted(cfg["anchors"].values())
    spacing = min((b - a for a, b in zip(xs, xs[1:])), default=float(img.shape[1]))
    conf = max(0.0, min(1.0, 1.0 - (dist / (0.5 * spacing)))) if spacing > 0 else 0.0
    return {"tab": name, "confidence": round(conf, 3), "peak_x": peak_x, "strength": strength}


def identify_synth(img: np.ndarray, candidates: list[str] | None = None) -> dict:
    """Best-effort: try each candidate profile's tab detection and return the synth whose active
    indicator is both well-localized AND strongest. Ranking by strength×confidence (not distance
    alone) disambiguates a wrong synth whose misaligned band catches a faint spurious peak near
    one of its anchors. {"synth", "tab", "confidence"}."""
    if candidates is None:
        candidates = [f[:-5] for f in os.listdir(PROFILE_DIR) if f.endswith(".json")]
    best = {"synth": None, "tab": None, "confidence": 0.0, "_score": 0.0}
    for synth in candidates:
        r = detect_active_tab(img, synth)
        if not r["tab"]:
            continue
        score = r["confidence"] * r.get("strength", 0.0)
        if score > best["_score"]:
            best = {"synth": synth, "tab": r["tab"], "confidence": r["confidence"], "_score": score}
    return {"synth": best["synth"], "tab": best["tab"], "confidence": best["confidence"]}
