#!/usr/bin/env python3
"""Golden tests for the full-take section planner + line offsetter (2026-07-16).

Codex rendered the full 137s take as ONE SoulX clip and silently hit the MAX_BARS=32
truncation — this module is the deliberate handling: split the take at real rests into
sections the grid can bin, build each section's grid+lyrics locally, then shift the
authored lines' slot times back onto the take timeline so author_score emits ONE score.

Run:  python3 scripts/fms-killshot/backhalf_sections_test.py   (exit 0 = pass)
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "service"))

import backhalf_sections as bs  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


HOP = 0.01
Q, L = 0.02, 0.5   # quiet / loud envelope levels


def env_of(*runs):
    """[(level_frames)...] -> envelope list; runs = (level, seconds)."""
    out = []
    for lvl, secs in runs:
        out += [lvl] * int(round(secs / HOP))
    return out


# ── 1. rest_gaps: silences between gate spans, >= min_rest_s only ───────────────────────
env = env_of((Q, 0.2), (L, 1.0), (Q, 0.6), (L, 1.0), (Q, 0.1), (L, 0.5), (Q, 0.3))
gaps = bs.rest_gaps(env, HOP, min_rest_s=0.4)
check("rest_gaps: only the >=0.4s inter-span silence qualifies", len(gaps) == 1
      and abs(gaps[0][0] - 1.2) <= 0.03 and abs(gaps[0][1] - 1.8) <= 0.03, str(gaps))

# ── 2. plan_sections: a short take is ONE section, no cuts ──────────────────────────────
short = bs.plan_sections(env, HOP, cap_s=10.0)
check("plan: take under the cap -> one section covering it", len(short) == 1
      and short[0]["a"] == 0.0 and abs(short[0]["b"] - len(env) * HOP) < 1e-9
      and short[0]["cut"] == "end", str(short))

# ── 3. plan_sections: the cap forces a split AT the rest midpoint ────────────────────────
env2 = env_of((Q, 0.2), (L, 2.0), (Q, 0.8), (L, 2.0), (Q, 0.2))
two = bs.plan_sections(env2, HOP, cap_s=3.5)
check("plan: cap forces a split at the rest midpoint (~2.6s)", len(two) == 2
      and abs(two[0]["b"] - 2.6) <= 0.05 and two[0]["cut"] == "rest",
      str([(s["a"], s["b"], s["cut"]) for s in two]))
check("plan: sections tile the take contiguously", two[0]["a"] == 0.0
      and two[0]["b"] == two[1]["a"] and abs(two[1]["b"] - len(env2) * HOP) < 1e-9, str(two))
check("plan: every section respects the cap", all(s["b"] - s["a"] <= 3.5 + 1e-9 for s in two))

# ── 4. plan_sections: prefers the LONGEST rest in the later half of the window ──────────
# two rests in reach: a short one at ~3.0s and a LONG one at ~4.5s — pick the long one.
env3 = env_of((L, 2.8), (Q, 0.45), (L, 1.0), (Q, 1.0), (L, 2.0), (Q, 0.2))
pref = bs.plan_sections(env3, HOP, cap_s=6.0)
check("plan: the longest eligible rest wins the cut", len(pref) == 2
      and abs(pref[0]["b"] - 4.75) <= 0.06 and pref[0]["cut"] == "rest",
      str([(s["a"], round(s["b"], 2), s["cut"]) for s in pref]))

# ── 5. plan_sections: NO rest in reach -> hard cut at the cap, honestly flagged ─────────
wall = bs.plan_sections(env_of((L, 8.0)), HOP, cap_s=3.0)
check("plan: rest-less audio hard-cuts at the cap and says so",
      len(wall) == 3 and wall[0]["b"] == 3.0 and wall[0]["cut"] == "hard"
      and wall[1]["cut"] == "hard" and wall[2]["cut"] == "end",
      str([(s["a"], s["b"], s["cut"]) for s in wall]))

# ── 6. offset_lines: slot + segment times shift by t0; the input is untouched ───────────
LINE = {"index": 0, "text": "hold the flame", "asserted": True,
        "score": {"v": 1, "algo": "energy", "bar": 0, "bpm": 152.0,
                  "slots": [{"start": 0.5, "end": 1.0, "velocity": 90, "kind": "gap",
                             "segments": [{"start": 0.5, "end": 0.75, "pitch": 57},
                                          {"start": 0.75, "end": 1.0, "pitch": 60}]}]}}
orig = json.loads(json.dumps(LINE))
shifted = bs.offset_lines([LINE], 45.5)
check("offset: slot times shift by t0", shifted[0]["score"]["slots"][0]["start"] == 46.0
      and shifted[0]["score"]["slots"][0]["end"] == 46.5,
      str(shifted[0]["score"]["slots"][0]))
check("offset: segment times shift too", shifted[0]["score"]["slots"][0]["segments"][0]["start"] == 46.0
      and shifted[0]["score"]["slots"][0]["segments"][1]["end"] == 46.5,
      str(shifted[0]["score"]["slots"][0]["segments"]))
check("offset: the input lines are untouched (deep copy)", LINE == orig)

# ── 7. offset + author integration: the authored score lands on the take timeline ───────
from soulx import score as sx  # noqa: E402
au = sx.author_score(bs.offset_lines([LINE], 45.5))
first_rest = float(au["score"][0]["duration"].split()[0])
check("offset->author: leading <SP> rest reaches the shifted first slot (~46.0s)",
      au["ok"] and abs(first_rest - 46.0) <= 0.001, str(first_rest))

# ── 8. determinism: 3x identical plans ───────────────────────────────────────────────────
digs = {hashlib.sha256(json.dumps(bs.plan_sections(env3, HOP, cap_s=6.0), sort_keys=True).encode()).hexdigest()
        for _ in range(3)}
check("plan_sections 3x deterministic", len(digs) == 1)

if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print("\nOK: 0 failure(s)")
