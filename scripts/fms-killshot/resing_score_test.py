#!/usr/bin/env python3
"""Golden tests for the re-sing score author (FMS re-sing, stage ④).

Pins the measured-rest behaviour that fixes the owner's top bug (the render singing where
his take is silent): a note that over-holds past his voicing is TRIMMED, a note entirely in
his silence is DROPPED, and the whole finalized sheet authors into ONE score with a `<SP>`
rest across the silence. Deterministic (3× identical). The MPS render is owner-gated; this is
the pure authoring underneath it.

Run:  python3 scripts/fms-killshot/resing_score_test.py     (exit 0 = all pass)
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import resing_score as rs  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def SLOT(a, b, pitch=60):
    return {"start": a, "end": b, "velocity": 90, "kind": "gap",
            "segments": [{"start": a, "end": b, "pitch": pitch}]}


def SC(*slots):
    return {"v": 1, "algo": "align", "bar": 0, "bpm": 120.0, "timeSig": [4, 4],
            "grid": "1/16", "clamped": False, "slots": list(slots)}


# take energy @ 10ms hop: voiced [0,1.0)s, SILENT [1.0,2.0)s, voiced [2.0,3.0)s
ENV = [1.0] * 100 + [0.0] * 100 + [1.0] * 100
HOP = 0.01


# ── 1. clamp_slots_to_voicing: trim over-holds, drop silent notes, keep voiced ──────────
sc = SC(SLOT(0.0, 0.8),      # fully voiced → unchanged
        SLOT(0.5, 1.8),      # over-holds across the silence → end trimmed to ~1.0
        SLOT(1.2, 1.7),      # entirely in the silence → dropped
        SLOT(2.1, 2.9))      # fully voiced (later region) → unchanged
clamped = rs.clamp_slots_to_voicing([sc], ENV, HOP)
kept = clamped[0]["slots"]
check("silent-only slot dropped (4 → 3)", len(kept) == 3, str(len(kept)))
check("fully-voiced slot unchanged", abs(kept[0]["end"] - 0.8) < 1e-6, str(kept[0]["end"]))
check("over-hold trimmed to the take's voicing (~1.0s, not 1.8)", abs(kept[1]["end"] - 1.0) < 0.02, str(kept[1]["end"]))
check("later voiced slot unchanged", abs(kept[2]["end"] - 2.9) < 1e-6, str(kept[2]["end"]))
check("trimmed slot's segment end follows the note end", abs(kept[1]["segments"][-1]["end"] - kept[1]["end"]) < 1e-6)

check("no env → slots returned unchanged (deep copy)",
      rs.clamp_slots_to_voicing([sc], None) == [sc] and rs.clamp_slots_to_voicing([sc], None) is not [sc])
d = {json.dumps(rs.clamp_slots_to_voicing([sc], ENV, HOP), sort_keys=True) for _ in range(3)}
check("clamp 3× deterministic", len(d) == 1)


# ── 2. author_resing_score: one score, rests where he rested ───────────────────────────
SHEET = {
    "lines": [
        {"index": 0, "text": "hold on", "origin": "sung"},
        {"index": 1, "text": "let it go", "origin": "generated"},
    ],
    "lineScores": [
        SC(SLOT(0.0, 0.5, 60), SLOT(0.5, 1.8, 60), SLOT(1.2, 1.6, 60)),   # over-hold + a silent note
        SC(SLOT(2.0, 2.5, 62), SLOT(2.5, 2.7, 62), SLOT(2.7, 2.9, 62)),   # count-fit: 3 words / 3 slots
    ],
}
res = rs.author_resing_score(SHEET, env=ENV, hop_s=HOP)
check("authors one clip", res.get("ok") and len(res.get("score", [])) == 1, str(res.get("error")))
clip = res["score"][0]
check("the silent-region note was dropped (slotsDropped=1)", res.get("slotsDropped") == 1, str(res.get("slotsDropped")))
check("a <SP> rest spans his silence", "<SP>" in clip["text"] and "1" in clip["note_type"].split(), clip["note_type"])
# the rest must be roughly the 1.0s gap (line0 trimmed to ~1.0 → line1 at 2.0)
durs = [float(x) for x in clip["duration"].split()]
types = [int(x) for x in clip["note_type"].split()]
rest_durs = [d for d, t in zip(durs, types) if t == 1]
check("the rest ≈ his 1.0s silent gap (over-hold trimmed, not sung through)",
      any(abs(rd - 1.0) < 0.1 for rd in rest_durs), str(rest_durs))
check("his kept words survive in the score", "hold" in clip["text"] and "let" in clip["text"], clip["text"])

digs = {hashlib.sha256(json.dumps(rs.author_resing_score(SHEET, env=ENV, hop_s=HOP), sort_keys=True).encode()).hexdigest()
        for _ in range(3)}
check("author_resing_score 3× deterministic", len(digs) == 1, str(len(digs)))

# B2.1 (2026-07-17): a line whose words outnumber its (possibly voicing-clamped) slots is
# REJECTED with the author's named error — the old squeeze crammed it silently. The clamp
# can legitimately shrink a line's slot count (dropped silent notes), so overflow must
# surface for a re-write, never sing.
OVERFLOW_SHEET = {
    "lines": [{"index": 0, "text": "let it go", "origin": "generated"}],
    "lineScores": [SC(SLOT(0.0, 0.5, 60), SLOT(0.5, 0.9, 60))],
}
res_of = rs.author_resing_score(OVERFLOW_SHEET, env=ENV, hop_s=HOP)
check("words > slots propagates line_overflow (no cram)",
      not res_of.get("ok") and res_of.get("error") == "line_overflow"
      and res_of.get("words") == 3 and res_of.get("slots") == 2, str(res_of))


# ── 3. a fully-silent section renders nothing (no audio where he never sang) ────────────
SILENT_ENV = [1.0] * 50 + [0.0] * 250          # voiced only [0,0.5)s
SILENT_SHEET = {
    "lines": [{"index": 0, "text": "nothing here", "origin": "generated"}],
    "lineScores": [SC(SLOT(1.0, 1.5), SLOT(1.5, 1.8))],   # both in the silence
}
res2 = rs.author_resing_score(SILENT_SHEET, env=SILENT_ENV, hop_s=HOP)
check("all-silent slots → no score (ok False, no phantom notes)",
      not res2.get("ok") and res2.get("error") == "no_voiced_slots", str(res2))


if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print("\nOK: 0 failure(s)")
