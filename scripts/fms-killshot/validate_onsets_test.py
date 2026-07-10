#!/usr/bin/env python3
"""Golden for the onset-validation GT wiring (FMS Stage 0).

The onset-F1 metric itself is covered by overlap.py --selftest; this pins the one new pure piece:
forced-aligned words → per-SYLLABLE onset ground truth (each word split into its phonology-syllable
count of slots, slot-starts kept, sorted). Deterministic.

Run:  python3 scripts/fms-killshot/validate_onsets_test.py     (exit 0 = all pass)
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import validate_onsets as vo  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# "going" (2 syl) over [0,1.0] → 2 onsets (0.0, 0.5); "down" (1 syl) over [2.0,2.5] → 1 onset (2.0)
aligned = [{"word": "going", "start": 0.0, "end": 1.0}, {"word": "down", "start": 2.0, "end": 2.5}]
gt = vo.syllable_gt_onsets(aligned)
check("word-derived syllable count (going=2 + down=1 = 3 onsets)", len(gt) == 3, str(gt))
check("time-ordered", gt == sorted(gt), str(gt))
check("multi-syllable word contributes contiguous slot-starts", abs(gt[0] - 0.0) < 1e-6 and abs(gt[1] - 0.5) < 1e-6, str(gt))
check("monosyllable onset at its word start", abs(gt[2] - 2.0) < 1e-6, str(gt))
check("a single-word list yields exactly its syllable count",
      len(vo.syllable_gt_onsets([{"word": "everything", "start": 0.0, "end": 1.2}])) == 3)

digs = {hashlib.sha256(json.dumps(vo.syllable_gt_onsets(aligned), sort_keys=True).encode()).hexdigest() for _ in range(3)}
check("syllable_gt_onsets 3× deterministic", len(digs) == 1)

if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print("\nOK: 0 failure(s)")
