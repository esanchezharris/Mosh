#!/usr/bin/env python3
"""Build COLORRACK_DATA — consolidate the validated SA3 steering axes ("colors")
from the research spike into a self-contained, runtime-friendly directory.

For each shippable color we slice the single peak-layer row out of the axis's
`steer[24,1536]` and write `colors.json` (the registry) + `vecs/<name>.npy`. The
runtime (`colors/runtime.py`) reads only this dir — it never reaches into the
spike tree. Per spec 05 §6: each color carries `astd_max` (the quality-collapse
clamp), `more_sign` (polarity), and `no_stack_with` (interference) so the UI can
ASTD-clamp and the engine can compose ≤3.

Run (stdlib + numpy only — no MLX needed):
    python3 service/colors/build_colorrack.py
    SA3_SPIKE_DATA=/path/to/sa3-editability-spike/data python3 ... build_colorrack.py
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np

SPIKE_DATA = os.environ.get(
    "SA3_SPIKE_DATA",
    os.path.expanduser("~/Documents/Mosh/sa3-editability-spike/data"))
OUT = os.environ.get(
    "COLORRACK_DATA",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "COLORRACK_DATA"))

DEFAULT_ASTD_MAX = 0.30   # conservative ceiling for un-capped REAL/CLEAN axes (Lab unlocks 0.4)

# name → (data subdir, astd_max override or None, no_stack_with[])
# peak_layer / more_sign / verdict are auto-resolved from the axis's metadata.
SHIPPABLE = [
    ("brightness",      "axis_brightness",      None, []),
    ("epic",            "axis_epic",            None, []),
    ("distortion",      "axis_distortion",      None, []),
    ("futuristic",      "axis_futuristic",      None, []),
    ("tension",         "axis_tension",         None, []),
    ("grit",            "myaxis_grit",          None, []),
    ("air",             "myaxis_air",           None, []),                       # cap 0.08 from meta
    ("drum_aggression", "loc2_drum_aggression", 0.40, ["grid_tightness"]),       # hero
    ("grid_tightness",  "loc2_grid_tightness",  0.40, ["drum_aggression"]),      # hero
]


def _load_axis_library() -> dict:
    p = os.path.join(SPIKE_DATA, "axis_library.json")
    return json.load(open(p)) if os.path.exists(p) else {}


def _resolve(name: str, subdir: str, lib: dict):
    """Return (peak_layer, more_sign, astd_max_from_meta, verdict) from whatever
    metadata the axis carries: axis_library.json | meta.json | localization.json."""
    d = os.path.join(SPIKE_DATA, subdir)
    # 1) reference axes — axis_library.json
    if name in lib:
        e = lib[name]
        return int(e["best_layer"]), float(e.get("more_sign", 1.0)), \
            float(e.get("hard_alpha", DEFAULT_ASTD_MAX)).__abs__(), e.get("verdict", "CLEAN")
    # 2) user-minted — meta.json (carries peak_layer + optional cap)
    mp = os.path.join(d, "meta.json")
    if os.path.exists(mp):
        m = json.load(open(mp))
        cap = m.get("cap")
        return int(m["peak_layer"]), 1.0, \
            float(cap) if cap is not None else DEFAULT_ASTD_MAX, m.get("verdict", "REAL")
    # 3) localized heroes — localization.json (carries best_layer)
    lp = os.path.join(d, "localization.json")
    if os.path.exists(lp):
        loc = json.load(open(lp))
        return int(loc["best_layer"]), 1.0, DEFAULT_ASTD_MAX, loc.get("verdict", "CLEAN")
    raise FileNotFoundError(f"no metadata for color '{name}' in {d}")


def main() -> int:
    os.makedirs(os.path.join(OUT, "vecs"), exist_ok=True)
    lib = _load_axis_library()
    registry = {}

    for name, subdir, astd_override, no_stack in SHIPPABLE:
        vecs_npz = os.path.join(SPIKE_DATA, subdir, "vecs.npz")
        if not os.path.exists(vecs_npz):
            print(f"  skip {name}: no vecs.npz at {vecs_npz}", file=sys.stderr)
            continue
        peak_layer, more_sign, astd_meta, verdict = _resolve(name, subdir, lib)
        astd_max = float(astd_override) if astd_override is not None else astd_meta

        steer = np.load(vecs_npz)["steer"]                      # [24, 1536]
        row = steer[peak_layer].astype(np.float32)             # [1536]
        np.save(os.path.join(OUT, "vecs", f"{name}.npy"), row)

        registry[name] = {
            "vec_path": f"vecs/{name}.npy",
            "peak_layer": peak_layer,
            "astd_max": round(astd_max, 4),
            "more_sign": more_sign,
            "verdict": verdict,
            "no_stack_with": no_stack,
            "source": subdir,
        }
        print(f"  + {name:16s} L{peak_layer:<2d} astd_max={astd_max:.3f} "
              f"sign={more_sign:+.0f} {verdict}")

    # Preserve research-derived colors that DON'T come from the spike tree (their
    # vec is committed directly, not sliced from a spike axis). "sustain" is the
    # time-scheduled onset-hold axis (diff-of-means direction + a hold envelope) —
    # a re-run must not drop it. Carry forward its registry entry + keep its vec if
    # both are already present in OUT.
    out_json = os.path.join(OUT, "colors.json")
    EXTERNAL = ("sustain",)
    if os.path.exists(out_json):
        try:
            prev = json.load(open(out_json)).get("colors", {})
            for name in EXTERNAL:
                if name in prev and os.path.exists(os.path.join(OUT, prev[name].get("vec_path", ""))) \
                        and name not in registry:
                    registry[name] = prev[name]
                    print(f"  = {name:16s} (preserved research-derived color)")
        except (ValueError, OSError) as e:
            print(f"  ! could not preserve external colors: {e}", file=sys.stderr)

    json.dump({"schema": 1, "lab_alpha_max": 0.40, "compose": {"a2": 0.25, "a3": 0.20},
               "colors": registry}, open(out_json, "w"), indent=2)
    print(f"wrote {len(registry)} colors → {out_json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
