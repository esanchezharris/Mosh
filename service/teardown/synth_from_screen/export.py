"""Read a whole patch from a synth-GUI frame using a per-synth control-map PROFILE, into
`synth_patch.params` with per-param confidence. A profile is
{control_name: {"type": "knob|toggle|menu", ...geometry, "range": [lo,hi]}}. Adding a synth
= adding a profile. Returns {"params": {...}, "confidence": {...}} (status → params_visible).
"""
from __future__ import annotations

import json
import os

import numpy as np

from .calib import axis_map
from .controls import read_knob, read_menu, read_toggle

PROFILE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "profiles")


def list_profiles() -> list[str]:
    if not os.path.isdir(PROFILE_DIR):
        return []
    return sorted(f[:-5] for f in os.listdir(PROFILE_DIR) if f.endswith(".json"))


def plugin_params(name: str) -> dict:
    """The profile's `plugin_params` alias map: §5b control name → the hosted plugin's actual
    param name (so a GUI read can drive set_plugin_param by name). {} if the profile has none
    (then the raw control names are used, which §9 will flag as unresolved — honest). The `_note`
    doc key is stripped."""
    path = os.path.join(PROFILE_DIR, f"{name.lower()}.json")
    if not os.path.isfile(path):
        return {}
    with open(path) as f:
        data = json.load(f)
    return {k: v for k, v in (data.get("plugin_params") or {}).items() if not k.startswith("_")}


def load_profile(name: str, frame_w: int, frame_h: int, img=None) -> dict:
    """Load a per-synth control map and map its reference-space coords onto the actual frame.

    Pass the frame `img` to enable HOST-INVARIANT calibration: a logo-landmark template match
    corrects for the host's title-bar height (Mosh vs Ableton vs standalone) so one profile reads
    correctly regardless of how much chrome sits above the plugin. Without `img` (or if the
    landmark isn't found) it falls back to the legacy proportional scaling — identical output when
    the frame preserves the reference aspect. Returns the {control_name: spec} dict read_patch
    consumes."""
    path = os.path.join(PROFILE_DIR, f"{name.lower()}.json")
    with open(path) as f:
        data = json.load(f)
    cal = axis_map(data, frame_w, frame_h, img)
    out: dict = {}
    for cname, spec in data.get("controls", {}).items():
        spec = dict(spec)
        if "cx" in spec:
            spec["cx"] = cal.x(spec["cx"])
        if "cy" in spec:
            spec["cy"] = cal.y(spec["cy"])
        if "r" in spec:
            spec["r"] = cal.length_i(spec["r"])
        if "bbox" in spec:
            x, y, w, h = spec["bbox"]
            spec["bbox"] = [cal.x(x), cal.y(y), cal.w(w), cal.h(h)]
        out[cname] = spec
    return out


def read_patch(img: np.ndarray, profile: dict) -> dict:
    import cv2

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    params: dict = {}
    conf: dict = {}
    for name, spec in profile.items():
        kind = spec.get("type")
        # malformed control specs (missing geometry) are skipped, not fatal — a profile typo
        # must not crash the whole read.
        if kind == "knob":
            if not all(k in spec for k in ("cx", "cy", "r")):
                continue
            r = read_knob(gray, spec["cx"], spec["cy"], spec["r"],
                          sweep_deg=spec.get("sweep_deg", 270.0),
                          dark_pointer=spec.get("dark_pointer", True),
                          img_bgr=img if img.ndim == 3 else None,
                          pointer=spec.get("pointer"))
            lo, hi = spec.get("range", [0.0, 1.0])
            params[name] = round(lo + r["value"] * (hi - lo), 4)
            conf[name] = r["confidence"]
        elif kind == "toggle":
            if "bbox" not in spec:
                continue
            r = read_toggle(gray, tuple(spec["bbox"]), spec.get("on_thresh", 128.0))
            params[name] = bool(r["on"])
            conf[name] = r["confidence"]
        elif kind == "menu":
            if "bbox" not in spec:
                continue
            r = read_menu(img, tuple(spec["bbox"]))
            params[name] = r["text"]
            conf[name] = r["confidence"]
    return {"params": params, "confidence": conf}
