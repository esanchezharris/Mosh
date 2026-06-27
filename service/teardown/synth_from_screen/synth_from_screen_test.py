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

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
