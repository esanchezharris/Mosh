"""Read a whole patch from a synth-GUI frame using a per-synth control-map PROFILE, into
`synth_patch.params` with per-param confidence. A profile is
{control_name: {"type": "knob|toggle|menu", ...geometry, "range": [lo,hi]}}. Adding a synth
= adding a profile. Returns {"params": {...}, "confidence": {...}} (status → params_visible).
"""
from __future__ import annotations

import json
import os

import numpy as np

from .controls import read_knob, read_menu, read_toggle

PROFILE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "profiles")


def list_profiles() -> list[str]:
    if not os.path.isdir(PROFILE_DIR):
        return []
    return sorted(f[:-5] for f in os.listdir(PROFILE_DIR) if f.endswith(".json"))


def load_profile(name: str, frame_w: int, frame_h: int) -> dict:
    """Load a per-synth control map and SCALE its reference-space coords to the actual
    frame size, so one calibrated profile works at any capture resolution. Returns the
    {control_name: spec} dict read_patch consumes."""
    path = os.path.join(PROFILE_DIR, f"{name.lower()}.json")
    with open(path) as f:
        data = json.load(f)
    ref_w, ref_h = data.get("reference_size", [frame_w, frame_h])
    sx, sy = frame_w / float(ref_w), frame_h / float(ref_h)
    s = (sx + sy) / 2.0
    out: dict = {}
    for cname, spec in data.get("controls", {}).items():
        spec = dict(spec)
        if "cx" in spec:
            spec["cx"] = int(round(spec["cx"] * sx))
        if "cy" in spec:
            spec["cy"] = int(round(spec["cy"] * sy))
        if "r" in spec:
            spec["r"] = int(round(spec["r"] * s))
        if "bbox" in spec:
            x, y, w, h = spec["bbox"]
            spec["bbox"] = [int(x * sx), int(y * sy), int(w * sx), int(h * sy)]
        out[cname] = spec
    return out


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
                          dark_pointer=spec.get("dark_pointer", True),
                          img_bgr=img if img.ndim == 3 else None,
                          pointer=spec.get("pointer"))
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
