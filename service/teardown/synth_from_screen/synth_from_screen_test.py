#!/usr/bin/env python3
"""Test for §5b — the knob-angle reading core on SYNTHETIC knobs (known values), plus
read_patch over a profile. Real per-synth profile calibration needs real frames (gated);
this proves the generic core recovers a value from the pointer angle.

    python3 service/teardown/synth_from_screen/synth_from_screen_test.py   (needs cv2/numpy)
"""
import math
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

import cv2  # noqa: E402

from teardown.synth_from_screen import read_knob, read_patch  # noqa: E402

fails: list[str] = []


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


def draw_knob(img, cx, cy, r, value, sweep=270.0):
    cv2.circle(img, (cx, cy), r, (200, 200, 200), -1)        # light body
    phi = -sweep / 2 + value * sweep                          # clockwise from top
    rad = math.radians(phi)
    ex = int(cx + math.sin(rad) * r * 0.9)
    ey = int(cy - math.cos(rad) * r * 0.9)
    cv2.line(img, (cx, cy), (ex, ey), (20, 20, 20), 2)        # dark pointer


# ── single-knob recovery across the sweep ────────────────────────────────────
for v in [0.0, 0.25, 0.5, 0.75, 1.0]:
    img = np.full((120, 120, 3), 30, np.uint8)
    draw_knob(img, 60, 60, 40, v)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    rv = read_knob(gray, 60, 60, 40)["value"]
    check(f"knob value {v} recovered (±0.08)", abs(rv - v) < 0.08, f"got {rv}")

# ── white-pointer mode: a colourless pointer drawn over a SATURATED fill-arc ──────
# This is the Vital/Serum case. Reading all bright pixels would fold the arc into the
# centroid (a full arc's centroid sits at the top → reads ~0.5); "white" mode must isolate
# the desaturated pointer and recover the TRUE value even at full fill.
def draw_arc_knob(img, cx, cy, r, value, sweep=270.0, arc_bgr=(180, 200, 40)):
    cv2.circle(img, (cx, cy), r, (40, 40, 40), -1)             # dark body
    a0 = -sweep / 2                                            # start (down-left)
    a1 = -sweep / 2 + value * sweep                            # up to the value
    # teal/cyan fill-arc from start to value (saturated colour)
    for deg in np.arange(a0, a1, 1.0):
        rad = math.radians(deg)
        ex = int(cx + math.sin(rad) * r * 0.85)
        ey = int(cy - math.cos(rad) * r * 0.85)
        cv2.circle(img, (ex, ey), max(2, r // 12), arc_bgr, -1)
    # the white pointer line AT the value angle (colourless, bright)
    radv = math.radians(a1)
    ex = int(cx + math.sin(radv) * r * 0.9)
    ey = int(cy - math.cos(radv) * r * 0.9)
    cv2.line(img, (cx, cy), (ex, ey), (245, 245, 245), 3)


for v in [0.0, 0.3, 0.6, 1.0]:
    panelw = np.full((160, 160, 3), 25, np.uint8)
    draw_arc_knob(panelw, 80, 80, 55, v)
    rv = read_knob(cv2.cvtColor(panelw, cv2.COLOR_BGR2GRAY), 80, 80, 55,
                   img_bgr=panelw, pointer="white")
    check(f"white-pointer over fill-arc: value {v} (±0.08)", abs(rv["value"] - v) < 0.08,
          f"got {rv['value']} conf {rv['confidence']}")
# the regression that motivated this: a FULL arc must NOT read ~0.5 (the centroid trap)
panelf = np.full((160, 160, 3), 25, np.uint8)
draw_arc_knob(panelf, 80, 80, 55, 1.0)
naive = read_knob(cv2.cvtColor(panelf, cv2.COLOR_BGR2GRAY), 80, 80, 55, dark_pointer=False)["value"]
white = read_knob(cv2.cvtColor(panelf, cv2.COLOR_BGR2GRAY), 80, 80, 55, img_bgr=panelf, pointer="white")["value"]
check("naive bright-pixel read is fooled by a full arc (~0.5)", naive < 0.8, f"naive={naive}")
check("white-pointer read recovers full value (~1.0)", white > 0.9, f"white={white}")


# ── white mode hardening: invalid img_bgr must NOT crash, falls back to grayscale ──
panelg = np.full((160, 160, 3), 25, np.uint8)
draw_arc_knob(panelg, 80, 80, 55, 0.5)
g = cv2.cvtColor(panelg, cv2.COLOR_BGR2GRAY)
# (a) pointer="white" but img_bgr is 2D (grayscale) → no IndexError, grayscale fallback
r_2d = read_knob(g, 80, 80, 55, dark_pointer=False, img_bgr=g, pointer="white")
check("white mode with a 2D img_bgr does not crash (falls back)", 0.0 <= r_2d["value"] <= 1.0, str(r_2d))
# (b) pointer="white" but img_bgr spatial dims differ from gray → no broadcast error
big = np.full((320, 320, 3), 25, np.uint8)
r_mismatch = read_knob(g, 80, 80, 55, dark_pointer=False, img_bgr=big, pointer="white")
check("white mode with a mismatched-size img_bgr does not crash", 0.0 <= r_mismatch["value"] <= 1.0, str(r_mismatch))

# ── classify-free knob edge cases must never raise (degenerate inputs) ────────
tiny = np.full((4, 4, 3), 25, np.uint8)
check("knob on a tiny frame returns gracefully",
      read_knob(cv2.cvtColor(tiny, cv2.COLOR_BGR2GRAY), 2, 2, 3, img_bgr=tiny, pointer="white")["confidence"] == 0.0)


# ── read_patch over a 2-knob profile ─────────────────────────────────────────
panel = np.full((120, 260, 3), 30, np.uint8)
draw_knob(panel, 60, 60, 40, 0.3)
draw_knob(panel, 200, 60, 40, 0.7)
profile = {
    "cutoff": {"type": "knob", "cx": 60, "cy": 60, "r": 40, "range": [0.0, 1.0]},
    "reso": {"type": "knob", "cx": 200, "cy": 60, "r": 40, "range": [0.0, 1.0]},
}
res = read_patch(panel, profile)
check("read_patch cutoff ≈ 0.3", abs(res["params"]["cutoff"] - 0.3) < 0.1, str(res["params"]))
check("read_patch reso ≈ 0.7", abs(res["params"]["reso"] - 0.7) < 0.1, str(res["params"]))
check("per-param confidence present", all(c > 0 for c in res["confidence"].values()))

# ── range scaling ────────────────────────────────────────────────────────────
panel2 = np.full((120, 120, 3), 30, np.uint8)
draw_knob(panel2, 60, 60, 40, 0.5)
res2 = read_patch(panel2, {"freq": {"type": "knob", "cx": 60, "cy": 60, "r": 40, "range": [20.0, 20000.0]}})
check("range scaling maps 0.5 → mid of [20,20000]", 9000 < res2["params"]["freq"] < 11000, str(res2["params"]))

# ── determinism ──────────────────────────────────────────────────────────────
img6 = np.full((120, 120, 3), 30, np.uint8)
draw_knob(img6, 60, 60, 40, 0.6)
g6 = cv2.cvtColor(img6, cv2.COLOR_BGR2GRAY)
check("read_knob deterministic x3", len({read_knob(g6, 60, 60, 40)["value"] for _ in range(3)}) == 1)

# ── per-synth profiles: load + resolution-scaling (the calibrated Vital profile) ──────
from teardown.synth_from_screen.export import list_profiles, load_profile  # noqa: E402

check("vital profile is registered", "vital" in list_profiles(), str(list_profiles()))
check("serum profile is registered", "serum" in list_profiles(), str(list_profiles()))
# both profiles use white-pointer ADSR knobs; serum's ENV1 has no delay (5 knobs vs vital's 6)
sp = load_profile("serum", 2380, 1544)
check("serum profile loads 5 white-pointer knobs",
      len(sp) == 5 and sp["env1_sustain"].get("pointer") == "white", str(list(sp)))
check("vital profile uses white-pointer mode",
      load_profile("vital", 2342, 1436)["env1_sustain"].get("pointer") == "white")
# reference_size in vital.json is 2342x1436; loading at the SAME size is identity
ref = load_profile("vital", 2342, 1436)
check("profile loads its controls", len(ref) == 6 and "env1_sustain" in ref)
check("identity load keeps reference coords", ref["env1_sustain"]["cx"] == 2106 and ref["env1_sustain"]["cy"] == 426)
# loading at HALF size scales coords by ~0.5 (so one profile works at any capture res)
half = load_profile("vital", 1171, 718)
check("half-size load scales cx", abs(half["env1_sustain"]["cx"] - 1053) <= 1, str(half["env1_sustain"]["cx"]))
check("half-size load scales cy", abs(half["env1_sustain"]["cy"] - 213) <= 1, str(half["env1_sustain"]["cy"]))
check("half-size load scales radius", abs(half["env1_sustain"]["r"] - 15) <= 1, str(half["env1_sustain"]["r"]))

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
