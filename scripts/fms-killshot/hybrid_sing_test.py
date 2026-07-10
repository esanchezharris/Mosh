#!/usr/bin/env python3
"""Golden tests for the hybrid-sing sheet builder (FMS hybrid rewrite-and-sing driver).

The audio decode (Basic Pitch / Whisper / FCPE) is owner-gated, so the driver's PURE core
is tested against a synthetic skeleton spec:
  - records_from_skeleton: skeleton lines -> gate records (origin + endWord evidence)
  - build_sheet: records -> a core spec with INFERRED rhyme groups + locked sung anchors,
    lineScores re-attached 1:1 for the later render stage.
The decisive test round-trips build_sheet through the real core.complete (fake backend).

Run:  python3 scripts/fms-killshot/hybrid_sing_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import hybrid_sing as hs  # noqa: E402
from lyrics import core as lyr  # noqa: E402
from phonology import core as ph  # noqa: E402

fails = []
_P = ph.Pronouncer()


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def SC(i):
    """A minimal lineScore blob (one slot, one segment) — enough to prove 1:1 re-attach."""
    return {"v": 1, "algo": "v4", "bar": i, "bpm": 120.0, "timeSig": [4, 4], "grid": "1/16",
            "clamped": False, "slots": [{"start": float(i), "end": float(i) + 0.5, "velocity": 90,
                                         "segments": [{"start": float(i), "end": float(i) + 0.5, "pitch": 55}]}]}


# A synthetic skeleton spec: 4 lines, two NON-rhyming SUNG anchors (so couplets hold) each
# paired with a MUMBLE line that must rewrite to rhyme with its sung neighbour.
SK = {
    "ok": True, "source": "skeleton", "grid": "1/16", "rhymeStrictness": "slant",
    "lines": [
        {"index": 0, "syllableTarget": 5, "rhymeGroup": "A", "seedText": "still i hold the flame",
         "text": "still I hold the flame", "origin": "sung"},
        {"index": 1, "syllableTarget": 8, "rhymeGroup": "B", "seedText": "___ ___ ___ ___ ___ ___ ___ ___"},
        {"index": 2, "syllableTarget": 4, "rhymeGroup": "A", "seedText": "down these city streets",
         "text": "down these city streets", "origin": "sung"},
        {"index": 3, "syllableTarget": 7, "rhymeGroup": "B", "seedText": "___ ___ ___ ___ ___ ___ ___"},
    ],
    "lineScores": [SC(0), SC(1), SC(2), SC(3)],
}


# ── 1. records_from_skeleton: origin + endWord evidence ────────────────────────────────
recs = hs.records_from_skeleton(SK)
check("one record per line", len(recs) == 4, str(len(recs)))
check("sung line → origin sung, endWord = its last word",
      recs[0]["origin"] == "sung" and recs[0]["endWord"] == "flame", str(recs[0]))
check("mumble line (no origin key) → origin mumble, endWord None",
      recs[1]["origin"] == "mumble" and recs[1]["endWord"] is None, str(recs[1]))
check("record carries the detected syllable target", recs[1]["syllables"] == 8, str(recs[1]))
# line 3 is a mumble line whose seed is all gaps → no end-word evidence
check("all-gap mumble seed → endWord None", recs[3]["endWord"] is None, str(recs[3]))

# ── 2. records_from_skeleton: a PARTIAL line ending on a real word gives that end-word ──
sk_partial = {"lines": [{"index": 0, "syllableTarget": 6, "seedText": "count me out the game",
                         "origin": "partial"}], "lineScores": [SC(0)]}
rp = hs.records_from_skeleton(sk_partial)
check("partial line ending on a real word → that end-word is evidence",
      rp[0]["origin"] == "partial" and rp[0]["endWord"] == "game", str(rp[0]))

# ── 3. build_sheet: couplet groups (non-rhyming sung anchors → AABB default), sung LOCKED
sheet = hs.build_sheet(SK)
groups = [l["rhymeGroup"] for l in sheet["lines"]]
check("non-rhyming sung anchors keep the couplet default (each mumble pairs a sung)",
      groups == ["A", "A", "B", "B"], str(groups))
check("sung lines are locked anchors",
      sheet["lines"][0].get("locked") is True and sheet["lines"][2].get("locked") is True, str(sheet["lines"][0]))
check("lineScores re-attached 1:1 (same count, index-aligned)",
      len(sheet.get("lineScores", [])) == 4 and sheet["lineScores"][3]["bar"] == 3, str(len(sheet.get("lineScores", []))))

# ── 4. THE ROUND-TRIP: core.complete rewrites the mumble lines, rhyming to sung anchors ─
gen = lyr.complete(sheet, backend="fake")
by_idx = {l["index"]: l for l in gen["lines"]}
check("sung anchors NOT proposed", 0 not in by_idx and 2 not in by_idx, str(list(by_idx)))
check("both mumble lines got proposals", bool(by_idx.get(1, {}).get("proposals")) and bool(by_idx.get(3, {}).get("proposals")), str(list(by_idx)))
p1 = (by_idx.get(1, {}).get("proposals") or [{}])[0]
p3 = (by_idx.get(3, {}).get("proposals") or [{}])[0]
check("rewritten mumble line 1 rhymes to its group-A anchor 'flame'",
      _P.rhyme(p1.get("endWord", ""), "flame", "slant"), f"end={p1.get('endWord')!r}")
check("rewritten mumble line 3 rhymes to its group-B anchor 'streets'",
      _P.rhyme(p3.get("endWord", ""), "streets", "slant"), f"end={p3.get('endWord')!r}")
check("rewritten mumble line 1 hits its detected syllable target (8)", p1.get("syllables") == 8, str(p1))

# ── 5. Determinism: 3x identical sheet ─────────────────────────────────────────────────
import hashlib
import json
sheets = {hashlib.sha256(json.dumps(hs.build_sheet(SK), sort_keys=True).encode()).hexdigest() for _ in range(3)}
check("3x deterministic sheet", len(sheets) == 1, str(sheets))

if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print("\nOK: 0 failure(s)")
