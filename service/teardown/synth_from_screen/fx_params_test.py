#!/usr/bin/env python3
"""Test for the per-effect FX KNOB reader (fx_params.py) — rung 10. Reads each ENABLED effect's
parameter knobs, handling Vital's DYNAMIC stacking layout (panels slide by enabled-order).

The headline guard is the STACKING PROOF on real committed fixtures: Delay's knobs must read the
SAME values whether it sits stacked below Chorus (vital_effects.png) or alone at the top slot
(vital_delay_only.png) — only correct if panel_top(Delay) is computed per-config. Plus default-value
sanity, graceful degradation, and 3x determinism.

    python3 service/teardown/synth_from_screen/fx_params_test.py   (needs cv2/numpy)
"""
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

import cv2  # noqa: E402

from teardown.synth_from_screen.fx_params import read_fx_params  # noqa: E402

PANELS = os.path.join(_HERE, "fixtures", "panels")
fails: list[str] = []


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


# ── REAL fixture: Chorus + Delay both enabled (panels stacked) ────────────────────────────
both = os.path.join(PANELS, "vital_effects.png")
alone = os.path.join(PANELS, "vital_delay_only.png")
if os.path.isfile(both) and os.path.isfile(alone):
    rb = read_fx_params(cv2.imread(both), "vital")
    ra = read_fx_params(cv2.imread(alone), "vital")

    check("both-config reads Chorus + Delay (only the enabled effects)",
          set(rb) == {"Chorus", "Delay"}, str(set(rb)))
    check("Chorus exposes its 7 knobs",
          set(rb.get("Chorus", {}).get("params", {})) ==
          {"feedback", "mix", "depth", "delay1", "delay2", "cutoff", "spread"},
          str(set(rb.get("Chorus", {}).get("params", {}))))
    check("Delay exposes its 4 knobs",
          set(rb.get("Delay", {}).get("params", {})) == {"feedback", "mix", "cutoff", "spread"},
          str(set(rb.get("Delay", {}).get("params", {}))))

    # default-value sanity (Vital's factory effect defaults, read off the white pointer)
    cp = rb["Chorus"]["params"]
    check("Chorus MIX ~0.5 (default 50% wet)", 0.40 <= cp["mix"] <= 0.60, str(cp["mix"]))
    check("Chorus SPREAD ~1.0 (full stereo)", cp["spread"] >= 0.90, str(cp["spread"]))
    check("Chorus DELAY1 low, DELAY2 higher (distinct lines)",
          cp["delay1"] < 0.40 and cp["delay2"] > 0.55, f"{cp['delay1']},{cp['delay2']}")

    # ── STACKING PROOF: Delay reads identically whether stacked below Chorus or alone at top ──
    db, da = rb["Delay"]["params"], ra["Delay"]["params"]
    check("delay-alone reads ONLY Delay (Chorus off)", set(ra) == {"Delay"}, str(set(ra)))
    for k in ("feedback", "mix", "cutoff", "spread"):
        check(f"STACKING: Delay.{k} matches across stacked vs top-slot (|Δ|<0.06)",
              abs(db[k] - da[k]) < 0.06, f"both={db[k]:.3f} alone={da[k]:.3f}")
    check("both-config places Delay BELOW Chorus (status read, not position_unknown)",
          rb["Delay"].get("status") == "read")
else:
    check("vital fx fixtures present (effects + delay_only)", False, "missing fixture")

# ── graceful degradation: never raise, never invent ───────────────────────────────────────
blank = np.full((400, 400, 3), 20, np.uint8)
check("unknown synth → {}", read_fx_params(blank, "nope") == {})
check("empty/None synth → {}", read_fx_params(blank, "") == {} and read_fx_params(blank, None) == {})
check("synth without fx_modules (serum) → {}", read_fx_params(blank, "serum") == {})
check("None image → {} (no crash)", read_fx_params(None, "vital") == {})
if os.path.isfile(both):
    g = cv2.cvtColor(cv2.imread(both), cv2.COLOR_BGR2GRAY)
    check("grayscale frame → {} (no crash)", read_fx_params(g, "vital") == {})

# ── determinism: identical structured output across 3 reads ────────────────────────────────
if os.path.isfile(both):
    im = cv2.imread(both)
    outs = [read_fx_params(im, "vital") for _ in range(3)]
    check("read_fx_params deterministic x3", outs[0] == outs[1] == outs[2])

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
