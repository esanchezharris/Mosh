"""Mix-polish FX chains for the beat factory — native built-ins only, delta-gated.

Owner-approved moves vs the HONEST native inventory (MoshOps kBuiltins, 2026-07-02):
  - OTT/multiband on drums     → moshOTT EXISTS (full param surface)            ✅ v0
  - saturation on the 808      → NO native saturator exists anywhere; nearest
    honest substitute is compressor DENSITY — shipped as '808-density-v0' and
    labeled presence/density, never "saturation" (native moshSaturator = future C++)
  - stereo width on pads/leads → chorus/phaser expose ZERO automatable params
    (CachedValues only) — OUT of v0, do NOT load an uncontrollable 50%-wet chorus
  - master glue                → no master-insert command; contingent on the
    bus-render probe (set_track_output state is proven, audio through it is not)

All params go through set_plugin_param NORMALIZED [0,1]; PARAM_TABLES maps real
values via the plugins' declared ranges (creation-order indices — describe_plugin
does NOT exist in the binary; fx_probe.py round-trips every preset value through
__snapshot before any pack render). Chains are applied by the factory as a SECOND
render per candidate and shipped only when the gain-aligned residual says the change
is audible AND every gate re-passes — the pack-002 "sounds identical?" lesson.
"""
from __future__ import annotations

from typing import Optional

# builtin type → {param name: (paramIndex, lo, hi)} — creation order == paramIndex
PARAM_TABLES = {
    "moshOTT": {"amount": (0, 0.0, 1.0), "time": (1, 5.0, 500.0),
                "low": (2, -12.0, 12.0), "mid": (3, -12.0, 12.0),
                "high": (4, -12.0, 12.0), "mix": (5, 0.0, 1.0),
                "output": (6, -18.0, 6.0)},
    # tracktion compressor: threshold is LINEAR GAIN [0.01,1]; ratio param = 1/ratio
    # in [0,0.95]; output in dB
    "compressor": {"threshold": (0, 0.01, 1.0), "ratio": (1, 0.0, 0.95),
                   "attack": (2, 0.3, 200.0), "release": (3, 10.0, 300.0),
                   "outputDb": (4, -10.0, 24.0)},
}

DRUM_ROLES = ("kick", "snare", "hat", "clap", "perc")
BASS_ROLES = ("808", "bass")

# conservative v0 presets (real values; the owner's chips calibrate next pack)
FX_PRESETS = {
    "drum-ott-v0": {"type": "moshOTT", "roles": DRUM_ROLES,
                    "params": {"amount": 0.18, "time": 120.0, "low": 0.0, "mid": 0.0,
                               "high": 0.0, "mix": 1.0, "output": -1.0}},
    "808-density-v0": {"type": "compressor", "roles": BASS_ROLES,
                       # threshold −8 dB → gain 0.398; ratio 3:1 → param 1/3
                       "params": {"threshold": 0.398, "ratio": 1.0 / 3.0,
                                  "attack": 10.0, "release": 80.0, "outputDb": 2.0}},
}


def norm_value(ptype: str, name: str, real: float) -> tuple:
    """(paramIndex, normalized [0,1]) for a real value via the declared linear range."""
    idx, lo, hi = PARAM_TABLES[ptype][name]
    return idx, max(0.0, min(1.0, (real - lo) / (hi - lo)))


def preset_param_rows(preset: dict, track_var: str, fx_var: str) -> list:
    """set_plugin_param command rows for one preset instance on one track."""
    rows = []
    for name, real in preset["params"].items():
        idx, nv = norm_value(preset["type"], name, real)
        rows.append({"command": "set_plugin_param",
                     "args": {"trackId": track_var, "index": f"${{{fx_var}}}",
                              "paramIndex": idx, "value": round(nv, 6)}})
    return rows


def fx_chain_commands(roles: list, chains: Optional[list] = None) -> tuple:
    """(command rows, applied chain names, {chain: real params}) for a recipe's track
    roles (track i == element i, the compiler's layout). Chains default to every preset
    whose role set intersects the recipe."""
    chains = chains if chains is not None else list(FX_PRESETS)
    cmds: list = []
    applied: list = []
    params: dict = {}
    for cname in chains:
        preset = FX_PRESETS[cname]
        targets = [i for i, r in enumerate(roles) if r in preset["roles"]]
        if not targets:
            continue
        applied.append(cname)
        params[cname] = dict(preset["params"])
        for i in targets:
            fx_var = f"FX{i}_{preset['type']}"
            cmds.append({"command": "load_builtin",
                         "args": {"trackId": f"${{T{i}}}", "type": preset["type"]},
                         "capture": {fx_var: "index"}})
            cmds += preset_param_rows(preset, f"${{T{i}}}", fx_var)
    return cmds, applied, params
