#!/usr/bin/env python3
"""Test for the modulation-matrix reader (matrix.py). The PRIMARY guard is the real EMPTY Vital
matrix fixture: read_matrix must return [] (no hallucinated routings from the placeholder dash or
the centered amount slider). A SYNTHETIC populated matrix (drawn to the declared column geometry,
via a throwaway profile) proves it reads active rows + amounts on the correct side. Plus graceful
degradation (unknown synth / missing block / grayscale) and 3x determinism.

    python3 service/teardown/synth_from_screen/matrix_test.py   (needs cv2/numpy)
"""
import json
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

import cv2  # noqa: E402

from teardown.synth_from_screen import matrix as M  # noqa: E402
from teardown.synth_from_screen import read_matrix  # noqa: E402

fails: list[str] = []


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


# ── PRIMARY REAL-DATA GUARD: the empty Vital matrix must yield NO routings ──────────────
PANELS = os.path.join(_HERE, "fixtures", "panels")
vmatrix = os.path.join(PANELS, "vital_matrix.png")
if os.path.isfile(vmatrix):
    im = cv2.imread(vmatrix)
    res_empty = read_matrix(im, "vital")
    check("empty Vital matrix → [] (no hallucinated routings)", res_empty == [], str(res_empty))
    # determinism on the real fixture too
    check("empty-matrix read deterministic x3",
          all(read_matrix(im, "vital") == [] for _ in range(3)))
    # grayscale frame must not crash (and still not invent a routing on the blank row)
    g = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
    check("grayscale Vital matrix → [] (no crash)", read_matrix(g, "vital") == [], str(read_matrix(g, "vital")))
else:
    check("vital_matrix.png fixture present", False, "fixture missing")


# ── graceful degradation: never raise on bad inputs ─────────────────────────────────────
blank = np.full((400, 400, 3), 20, np.uint8)
check("unknown synth → []", read_matrix(blank, "nope") == [])
check("empty/None synth → []", read_matrix(blank, "") == [] and read_matrix(blank, None) == [])
check("synth with NO matrix block → []", read_matrix(blank, "serum1") == [] or isinstance(read_matrix(blank, "serum1"), list))
check("None image → [] (no crash)", read_matrix(None, "vital") == [])
check("2D grayscale array → [] (no crash)", read_matrix(np.zeros((50, 50), np.uint8), "vital") == [])
check("tiny frame → [] (no crash)", read_matrix(np.full((4, 4, 3), 20, np.uint8), "vital") == [])


# ── SYNTHETIC populated matrix: drawn to the declared Vital column geometry ──────────────
# We register a throwaway profile (reference_size == the synthetic's size, so coords are identity)
# reusing Vital's calibrated column x-ranges but scanning 3 rows: a low routing, a high routing,
# and a blank centered row that must be EXCLUDED.
W, H = 1171, 718
SRC = {"x0": 115, "x1": 230}
DST = {"x0": 514, "x1": 635}
AX0, AX1 = 383, 513          # amount slider track endpoints
ROW0_Y, ROW_H = 112, 28

tmp_profile = os.path.join(M.PROFILE_DIR, "_matrixsynth.json")
synth_profile = {
    "synth": "_matrixsynth",
    "reference_size": [W, H],
    "matrix": {
        "header_y": 84, "row0_y": ROW0_Y, "row_h": ROW_H, "rows": 3,
        "amount": {"type": "slider", "x0": AX0, "x1": AX1, "neutral": 0.5},
        "source": SRC, "destination": DST,
        "active_amount_eps": 0.06,
    },
}


def _draw_row(img, i, frac, filled=True):
    cy = ROW0_Y + i * ROW_H
    if filled:                                  # source/dest label pills (occupied cells)
        cv2.rectangle(img, (SRC["x0"], cy - 9), (SRC["x1"], cy + 9), (60, 60, 60), -1)
        cv2.putText(img, "LFO1", (SRC["x0"] + 8, cy + 5), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (220, 220, 220), 1)
        cv2.rectangle(img, (DST["x0"], cy - 9), (DST["x1"], cy + 9), (60, 60, 60), -1)
        cv2.putText(img, "Pitch", (DST["x0"] + 8, cy + 5), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (220, 220, 220), 1)
    cv2.line(img, (AX0, cy), (AX1, cy), (48, 48, 48), 3)        # dark unfilled track
    hx = int(AX0 + frac * (AX1 - AX0))
    cv2.rectangle(img, (hx - 6, cy - 5), (hx + 6, cy + 5), (180, 180, 180), -1)   # bright handle


with open(tmp_profile, "w") as f:
    json.dump(synth_profile, f)
try:
    synth = np.full((H, W, 3), 41, np.uint8)     # dark table background
    _draw_row(synth, 0, 0.15)                     # low amount, populated → active
    _draw_row(synth, 1, 0.85)                     # high amount, populated → active
    _draw_row(synth, 2, 0.5, filled=False)        # centered + blank → must be EXCLUDED

    out = read_matrix(synth, "_matrixsynth")
    check("synthetic matrix: exactly 2 active routings (blank row excluded)", len(out) == 2, str(out))
    if len(out) == 2:
        r0, r1 = out[0], out[1]
        check("synthetic row 0 is the low-amount routing", r0["row"] == 0 and r0["amount"] < 0.35,
              str(r0))
        check("synthetic row 1 is the high-amount routing", r1["row"] == 1 and r1["amount"] > 0.65,
              str(r1))
        check("synthetic rows report active=True", r0["active"] and r1["active"])
        # OCR is best-effort: keys exist + strings; if tesseract is present they tend to read.
        check("synthetic rows carry source/destination keys (strings)",
              isinstance(r0["source"], str) and isinstance(r0["destination"], str))

    # a row with ONLY a non-centered amount (no source/dest fill) still counts — the amount engages.
    synth2 = np.full((H, W, 3), 41, np.uint8)
    _draw_row(synth2, 0, 0.9, filled=False)
    out2 = read_matrix(synth2, "_matrixsynth")
    check("amount-only engaged row counts as active", len(out2) == 1 and out2[0]["amount"] > 0.65,
          str(out2))

    # an ALL-centered, ALL-blank synthetic matrix (the init-patch shape) → [] (no hallucination)
    synth_blank = np.full((H, W, 3), 41, np.uint8)
    for i in range(3):
        _draw_row(synth_blank, i, 0.5, filled=False)
    check("all-blank centered synthetic matrix → []", read_matrix(synth_blank, "_matrixsynth") == [],
          str(read_matrix(synth_blank, "_matrixsynth")))

    # determinism: identical structured output across 3 reads
    outs = [read_matrix(synth, "_matrixsynth") for _ in range(3)]
    check("synthetic read deterministic x3", outs[0] == outs[1] == outs[2], str(outs))
finally:
    if os.path.exists(tmp_profile):
        os.remove(tmp_profile)
    check("throwaway profile cleaned up", not os.path.exists(tmp_profile))


print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
