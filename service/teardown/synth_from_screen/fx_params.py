"""Per-effect FX knob reader — read an ENABLED effect module's parameter knobs (the actual effect
values: Chorus FEEDBACK/MIX/DEPTH…, Delay FEEDBACK/MIX/CUTOFF…) that nothing else in §5b captures.

The hard part is Vital's layout: each enabled effect shows an expanded control PANEL, and the
panels STACK by enabled-order (a panel slides up when an earlier effect is off). So an effect's
panel y is DYNAMIC — it depends on which earlier effects are on. We model that exactly:

    panel_top(E) = base_y + Σ height[e]   for every enabled, CALIBRATED effect e before E in the
                                           fixed rack order.

then read E's knobs at (knob.cx, panel_top + knob.dy). A profile declares this in an `fx_modules`
block:
    "fx_modules": {"base_y": Y, "modules": {
        "Chorus": {"height": H, "knobs": {"feedback": {"cx":…, "dy":…, "r":…}, …}}, …}}

Honesty rules (never emit a wrong value):
  • only effects that are ON (per the fixed-rack power-dot detector, §fx_rack) are read;
  • an effect is read ONLY if every enabled effect BEFORE it is also calibrated — otherwise its
    panel_top can't be computed, so it's reported `position_unknown` rather than guessed;
  • an effect with no module sub-profile is skipped (uncalibrated), never invented.

`read_fx_params(img, synth)` → {effect_name: {"params": {knob: value}, "confidence": {...}}}.
Coords scale + host-correct through the shared `calib` map (the logo landmark), like every reader.
"""
from __future__ import annotations

import json
import os

import numpy as np

from .calib import axis_map
from .controls import read_knob
from .fx_rack import detect_fx_chain

PROFILE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "profiles")


def _load_modules(synth: str) -> dict | None:
    """Load a profile's raw `fx_modules` block (reference space; scaled per-frame by the caller).
    None if the synth is falsy, the profile is missing, or it has no fx_modules block."""
    if not synth:
        return None
    path = os.path.join(PROFILE_DIR, f"{synth.lower()}.json")
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        data = json.load(f)
    fm = data.get("fx_modules")
    if not fm or not fm.get("modules"):
        return None
    return {"data": data, "base_y": float(fm.get("base_y", 0.0)), "modules": fm["modules"]}


def read_fx_params(img_bgr: np.ndarray, synth: str) -> dict:
    """Read every ENABLED + calibrated effect's knobs. Returns
        {effect: {"params": {knob: 0..1}, "confidence": {knob: c}}}
    Effects that are off, uncalibrated, or whose panel position can't be resolved (an uncalibrated
    effect precedes them in the enabled stack) are omitted — the read never guesses a position.
    [] -> {} for unknown synth / no fx_modules / a non-colour frame (never raises)."""
    if img_bgr is None or getattr(img_bgr, "ndim", 0) != 3 or img_bgr.shape[2] != 3:
        return {}
    cfg = _load_modules(synth)
    if not cfg:
        return {}
    chain = detect_fx_chain(img_bgr, synth)            # fixed-rack order + on/off (the fixed signal)
    if not chain:
        return {}
    modules = cfg["modules"]
    cal = axis_map(cfg["data"], img_bgr.shape[1], img_bgr.shape[0], img_bgr)
    gray = __import__("cv2").cvtColor(img_bgr, __import__("cv2").COLOR_BGR2GRAY)

    out: dict = {}
    stack_y = cfg["base_y"]                             # running panel_top in REFERENCE space
    blocked = False                                     # an uncalibrated enabled effect breaks the stack
    for e in chain:
        if not e.get("on"):
            continue
        mod = modules.get(e["name"])
        if mod is None:
            # an enabled but uncalibrated effect: we can't know its panel height → every effect
            # AFTER it in the stack has an unknown position. Stop emitting positioned reads.
            blocked = True
            continue
        if blocked:
            out[e["name"]] = {"params": {}, "confidence": {}, "status": "position_unknown"}
            continue
        panel_top = stack_y
        params: dict = {}
        conf: dict = {}
        for kname, spec in mod.get("knobs", {}).items():
            cx = cal.x(spec["cx"])
            cy = cal.y(panel_top + spec["dy"])
            r = cal.length_i(spec.get("r", 30))
            res = read_knob(gray, cx, cy, r, sweep_deg=spec.get("sweep_deg", 270.0),
                            dark_pointer=spec.get("dark_pointer", True), img_bgr=img_bgr,
                            pointer=spec.get("pointer", "white"))
            params[kname] = round(res["value"], 4)
            conf[kname] = res["confidence"]
        out[e["name"]] = {"params": params, "confidence": conf, "status": "read"}
        stack_y += float(mod.get("height", 0.0))       # advance the stack by this panel's height
    return out
