"""ColorRack runtime — turn UI colors (0–100 ASTD sliders) into SA3 steering
tuples `[(layer, alpha, vec[1536]), ...]` for the engine (05 §6).

Mapping (mirrors the spike's `compose_axes.steers_for` + ASTD clamp):
  • 0–100 → centered ±1 → α = centered * ceil, where ceil = the color's `astd_max`
    (Lab mode unlocks ceil to `lab_alpha_max`, default ±0.4).
  • α is multiplied by the color's `more_sign` (polarity).
  • ≤3 colors; `no_stack_with` pairs are rejected; for 2-/3-color stacks the per-
    color magnitude is additionally backed off to a2=0.25 / a3=0.20 (compose_axes).

Pure numpy/json — no MLX. The engine forwards the result to `gen(..., steers=...)`.
"""
from __future__ import annotations

import json
import os

import numpy as np

COLORRACK_DATA = os.environ.get(
    "COLORRACK_DATA",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "COLORRACK_DATA"))

_REG = None
_VEC_CACHE: dict[str, np.ndarray] = {}


def _meta() -> dict:
    global _REG
    if _REG is None:
        p = os.path.join(COLORRACK_DATA, "colors.json")
        _REG = json.load(open(p)) if os.path.exists(p) else {"colors": {}, "lab_alpha_max": 0.4,
                                                              "compose": {"a2": 0.25, "a3": 0.20}}
    return _REG


def registry() -> dict:
    return _meta().get("colors", {})


def available() -> bool:
    return bool(registry())


def descriptor() -> list[dict]:
    """The /colors payload: each color's ASTD ceiling + metadata for the UI."""
    out = []
    for name, e in registry().items():
        out.append({"name": name, "astd_max": e["astd_max"], "peak_layer": e["peak_layer"],
                    "more_sign": e["more_sign"], "verdict": e["verdict"],
                    "no_stack_with": e.get("no_stack_with", [])})
    return out


def _vec(name: str, vec_path: str) -> np.ndarray:
    if name not in _VEC_CACHE:
        _VEC_CACHE[name] = np.load(os.path.join(COLORRACK_DATA, vec_path)).astype(np.float32)
    return _VEC_CACHE[name]


def _ui_to_alpha(value_0_100: float, astd_max: float, more_sign: float, lab: bool) -> float:
    ceil = float(_meta().get("lab_alpha_max", 0.4)) if lab else float(astd_max)
    centered = (float(value_0_100) - 50.0) / 50.0            # -1 .. +1
    raw = max(-ceil, min(ceil, centered * ceil))
    return raw * float(more_sign)


def resolve_steers(colors, lab: bool = False):
    """colors: [{name, value 0-100}, ...]. Returns [(layer, alpha, vec[1536]), ...]."""
    reg = registry()
    picked = [c for c in (colors or []) if c.get("name") in reg][:3]      # ≤3, drop unknowns

    names = {c["name"] for c in picked}
    for c in picked:
        bad = set(reg[c["name"]].get("no_stack_with", [])) & names
        if bad:
            raise ValueError(f"color '{c['name']}' composes poorly with {sorted(bad)} — pick one")

    comp = _meta().get("compose", {"a2": 0.25, "a3": 0.20})
    mag_cap = comp["a3"] if len(picked) >= 3 else (comp["a2"] if len(picked) == 2 else None)

    steers = []
    for c in picked:
        e = reg[c["name"]]
        a = _ui_to_alpha(c.get("value", 50), e["astd_max"], e["more_sign"], lab)
        if abs(a) < 1e-6:
            continue                                          # neutral → no steer
        if mag_cap is not None:                               # multi-color backoff
            a = max(-mag_cap, min(mag_cap, a))
        steers.append((int(e["peak_layer"]), float(a), _vec(c["name"], e["vec_path"])))
    return steers
