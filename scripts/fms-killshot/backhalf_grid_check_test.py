#!/usr/bin/env python3
"""Golden tests for the grid-corrections applier (strict round, Step 2).

The owner: "some counts feel wrong" — the slot grid is the ruler every strictness
gate measures against, so before the next paid render the owner verifies counts by
ear and replies with corrections {phrase index: true count}. The applier adjusts
slots deterministically: count < slots ⇒ fold the lowest-velocity slot into its
longer neighbor (melisma-style; segments preserved beneath); count > slots ⇒ split
the longest slot at its midpoint (inherits pitch/velocity). Never mutates the
original skeleton.

Run:  python3 scripts/fms-killshot/backhalf_grid_check_test.py   (exit 0 = pass)
"""
import copy
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "service"))

import backhalf_grid_check as gc  # noqa: E402
from lyrics import flowspec  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def SLOT(a, b, vel, pitch):
    return {"start": a, "end": b, "velocity": float(vel), "kind": "gap",
            "segments": [{"start": a, "end": b, "pitch": pitch}]}


def LS(bar, slots):
    return {"v": 1, "algo": "v4", "bar": bar, "bpm": 138.0, "timeSig": [4, 4],
            "grid": "1/16", "clamped": False, "slots": slots}


# Two phrases (a 1.5s rest splits them): P0 = 3 slots in bar 0, P1 = 2 slots in bar 1.
SKEL = {
    "lineScores": [
        LS(0, [SLOT(0.0, 0.3, 90, 55), SLOT(0.32, 0.6, 40, 57), SLOT(0.62, 0.9, 85, 59)]),
        LS(1, [SLOT(2.5, 2.9, 80, 60), SLOT(2.95, 3.4, 70, 62)]),
    ],
    "lines": [{"index": 0, "seedText": "", "syllableTarget": 3},
              {"index": 1, "seedText": "", "syllableTarget": 2}],
    "lineHeard": [],
}


def phrase_counts(skel):
    return [len(p["slots"]) for p in flowspec.group_by_rest(skel.get("lineScores") or [],
                                                            gap_s=0.35, min_syllables=1)]


before = json.dumps(SKEL, sort_keys=True)

# ── 1. FOLD: P0 corrected 3 -> 2; the lowest-velocity slot (idx 1, vel 40) merges ──────
c1 = gc.apply_grid_corrections(SKEL, {0: 2}, gap_s=0.35, min_syllables=1)
check("fold reaches the corrected count", phrase_counts(c1) == [2, 2], str(phrase_counts(c1)))
s0 = c1["lineScores"][0]["slots"]
check("the weak slot merged into a NEIGHBOR (span covered, no hole)",
      abs(s0[0]["end"] - 0.6) < 1e-9 or abs(s0[-1]["start"] - 0.32) < 1e-9, str(s0))
check("the LOWEST-VELOCITY slot is the one that folded (strong articulations survive)",
      sorted(float(s["velocity"]) for s in s0) == [85.0, 90.0],
      str([s["velocity"] for s in s0]))
check("merged slot keeps both segments beneath (melisma-style)",
      any(len(s["segments"]) == 2 for s in s0), str([len(s["segments"]) for s in s0]))
check("the untouched phrase is byte-identical",
      c1["lineScores"][1] == SKEL["lineScores"][1])
check("the original skeleton is NOT mutated", json.dumps(SKEL, sort_keys=True) == before)

# ── 2. SPLIT: P1 corrected 2 -> 3; the longest slot (idx 1, 0.45s) splits at midpoint ──
c2 = gc.apply_grid_corrections(SKEL, {1: 3}, gap_s=0.35, min_syllables=1)
check("split reaches the corrected count", phrase_counts(c2) == [3, 3], str(phrase_counts(c2)))
s1 = c2["lineScores"][1]["slots"]
halves = [s for s in s1 if 2.94 < s["start"] and s["end"] <= 3.41]
check("the longest slot split into two contiguous halves",
      len(halves) == 2 and abs(halves[0]["end"] - halves[1]["start"]) < 1e-6, str(halves))
check("both halves inherit pitch and velocity",
      all(s["velocity"] == 70 and s["segments"][0]["pitch"] == 62 for s in halves), str(halves))

# ── 3. multi-step + validation ─────────────────────────────────────────────────────────
c3 = gc.apply_grid_corrections(SKEL, {0: 1}, gap_s=0.35, min_syllables=1)
check("multi-fold reaches a 2-step correction", phrase_counts(c3) == [1, 2], str(phrase_counts(c3)))
try:
    gc.apply_grid_corrections(SKEL, {9: 4}, gap_s=0.35, min_syllables=1)
    check("unknown phrase index fails loudly", False)
except (ValueError, KeyError):
    check("unknown phrase index fails loudly", True)

# ── 4. determinism ─────────────────────────────────────────────────────────────────────
digs = {hashlib.sha256(json.dumps(gc.apply_grid_corrections(SKEL, {0: 2, 1: 3},
                                                            gap_s=0.35, min_syllables=1),
                                  sort_keys=True).encode()).hexdigest() for _ in range(3)}
check("applier is deterministic (3x)", len(digs) == 1)

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
