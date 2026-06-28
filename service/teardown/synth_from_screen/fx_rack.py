"""FX-chain detector — "which effects are enabled, and in what order" — read from a synth's
EFFECTS/FX page (the effects RACK LIST). This is the load-bearing info the teardown Recipe needs:
a vocal-doubler chain reads as [Chorus on, Delay on, …]; the order is the synth's fixed rack order.

Pure CV (no OCR): the effect NAMES come from the profile's declared fixed top-to-bottom order, and
each effect's ON state comes from sampling its power-indicator dot/toggle — lit (coloured/saturated)
vs greyed. A synth declares its rack in an `"fx_list"` block on its EFFECTS-page profile:

    "fx_list": {
        "x_dot":      <power-indicator column x>,   # reference-pixel space
        "row0_y":     <first row's indicator center y>,
        "row_h":      <row pitch>,
        "on_sat_min": <HSV S cutoff for "lit">,     # S/V are resolution-invariant
        "on_val_min": <HSV V cutoff for "lit">,
        "effects":    ["Chorus", "Compressor", ...] # the synth's fixed order, top→bottom
    }

Coords are in the profile's reference_size pixel space; `_load_fx_list` scales them to the actual
frame size EXACTLY like page_detect._load_tabs (sx=frame_w/ref_w, sy=frame_h/ref_h). The HSV
saturation/value cutoffs are resolution-independent, so they are NOT scaled.

`detect_fx_chain(img, synth)` returns the ordered effect list
    [{"name": "Chorus", "on": True}, {"name": "Compressor", "on": False}, ...]
in the synth's fixed rack order — [] for an unknown synth, a profile with no fx_list, or a
grayscale frame (the indicator's colour/saturation can't be read without the 3 channels).
"""
from __future__ import annotations

import json
import os

import numpy as np

PROFILE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "profiles")


def _load_fx_list(synth: str, frame_w: int, frame_h: int) -> dict | None:
    """Load + scale a profile's `fx_list` block to the actual frame size. None if the synth is
    falsy (e.g. None — `identify_synth` returns {"synth": None} when it can't name the synth), the
    profile is missing, or it has no fx_list. Mirrors page_detect._load_tabs / matrix._load_matrix:
    positions scale by the frame ratio; the HSV S/V cutoffs are resolution-invariant (unscaled)."""
    if not synth:
        return None
    path = os.path.join(PROFILE_DIR, f"{synth.lower()}.json")
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        data = json.load(f)
    fx = data.get("fx_list")
    if not fx or not fx.get("effects"):
        return None
    ref_w, ref_h = data.get("reference_size", [frame_w, frame_h])
    sx, sy = frame_w / float(ref_w), frame_h / float(ref_h)
    return {
        "x_dot": int(round(fx["x_dot"] * sx)),
        "row0_y": int(round(fx["row0_y"] * sy)),
        "row_h": fx["row_h"] * sy,
        "on_sat_min": float(fx.get("on_sat_min", 70.0)),
        "on_val_min": float(fx.get("on_val_min", 90.0)),
        # the indicator patch is a small fraction of the row pitch (kept tight so a neighbour row's
        # dot can't leak in); a floor keeps it ≥1px at tiny capture sizes.
        "patch": max(2, int(round(0.18 * fx["row_h"] * sy))),
        "effects": list(fx["effects"]),
    }


def _indicator_lit(img_bgr: np.ndarray, cx: int, cy: int, patch: int,
                   sat_min: float, val_min: float) -> bool:
    """Is the power indicator at (cx, cy) lit? Sample a small patch, convert to HSV, and test
    whether its BRIGHTEST-saturated pixels clear the lit cutoffs. A lit dot/toggle is a coloured
    (high-S) and bright (high-V) blob; a greyed/off one is low-S, dim. We take the patch's max S
    among its bright pixels (robust to the dot being only part of the patch / anti-aliased edges)."""
    import cv2

    h, w = img_bgr.shape[:2]
    y0, y1 = max(0, cy - patch), min(h, cy + patch + 1)
    x0, x1 = max(0, cx - patch), min(w, cx + patch + 1)
    if y1 <= y0 or x1 <= x0:
        return False
    hsv = cv2.cvtColor(img_bgr[y0:y1, x0:x1], cv2.COLOR_BGR2HSV)
    S = hsv[..., 1].astype(np.float32)
    V = hsv[..., 2].astype(np.float32)
    lit = (S >= sat_min) & (V >= val_min)
    # require a small cluster, not a single stray pixel, so JPEG/anti-alias speckle can't flip off→on.
    return int(lit.sum()) >= 3


def detect_fx_chain(img_bgr: np.ndarray, synth: str) -> list[dict]:
    """Ordered effect list for this `synth`'s EFFECTS/FX page:
        [{"name": "Chorus", "on": True}, {"name": "Compressor", "on": False}, ...]
    in the synth's FIXED rack order (names from the profile, not OCR). `on` = the effect's power
    indicator is lit (coloured/saturated) vs greyed.

    Returns [] (never raises) when: the synth is unknown, the profile has no fx_list block, or the
    frame is not a 3-channel colour image (the lit/grey distinction needs colour)."""
    if img_bgr is None or img_bgr.ndim != 3 or img_bgr.shape[2] != 3:
        return []
    cfg = _load_fx_list(synth, img_bgr.shape[1], img_bgr.shape[0])
    if not cfg:
        return []
    out: list[dict] = []
    for i, name in enumerate(cfg["effects"]):
        cy = int(round(cfg["row0_y"] + i * cfg["row_h"]))
        on = _indicator_lit(img_bgr, cfg["x_dot"], cy, cfg["patch"],
                            cfg["on_sat_min"], cfg["on_val_min"])
        out.append({"name": name, "on": bool(on)})
    return out
