"""Read a whole patch from a synth-GUI frame using a per-synth control-map PROFILE, into
`synth_patch.params` with per-param confidence. A profile is
{control_name: {"type": "knob|toggle|menu", ...geometry, "range": [lo,hi]}}. Adding a synth
= adding a profile. Returns {"params": {...}, "confidence": {...}} (status → params_visible).
"""
from __future__ import annotations

import numpy as np

from .controls import read_knob, read_menu, read_toggle


def read_patch(img: np.ndarray, profile: dict) -> dict:
    import cv2

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    params: dict = {}
    conf: dict = {}
    for name, spec in profile.items():
        kind = spec.get("type")
        if kind == "knob":
            r = read_knob(gray, spec["cx"], spec["cy"], spec["r"],
                          sweep_deg=spec.get("sweep_deg", 270.0),
                          dark_pointer=spec.get("dark_pointer", True))
            lo, hi = spec.get("range", [0.0, 1.0])
            params[name] = round(lo + r["value"] * (hi - lo), 4)
            conf[name] = r["confidence"]
        elif kind == "toggle":
            r = read_toggle(gray, tuple(spec["bbox"]), spec.get("on_thresh", 128.0))
            params[name] = bool(r["on"])
            conf[name] = r["confidence"]
        elif kind == "menu":
            r = read_menu(img, tuple(spec["bbox"]))
            params[name] = r["text"]
            conf[name] = r["confidence"]
    return {"params": params, "confidence": conf}
