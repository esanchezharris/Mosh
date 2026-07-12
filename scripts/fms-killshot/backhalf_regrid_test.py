#!/usr/bin/env python3
"""Golden tests for the re-grid detectors (grid audit round).

The shipped grid derives syllable EXISTENCE from Basic Pitch notes and can only
REMOVE from there — on the soft back-half mumble it under-counts (90 slots vs ~114
envelope peaks / ~130 ASR syllables) and the owner hears "pretty much all off".
Candidate E derives nuclei from the energy envelope (gate attacks + dips between
peaks); candidate F fuses E ∪ Basic-Pitch onsets ∪ ASR syllable anchors with
witness voting. Both emit lineScores-shaped slots so all downstream machinery
works unchanged.

Run:  python3 scripts/fms-killshot/backhalf_regrid_test.py   (exit 0 = pass)
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "service"))

import backhalf_regrid as rg  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


HOP = 0.01


def env_from(spec):
    """Build a 10ms-hop envelope from [(duration_s, level), ...]."""
    env = []
    for dur, lvl in spec:
        env += [lvl] * int(round(dur / HOP))
    return env


# ── fixture: one voiced span holding THREE syllables ───────────────────────────────────
# syllable 1 loud (0.60), dip, syllable 2 SOFT (0.22 — Basic Pitch would miss it),
# dip, syllable 3 (0.55) sliding into a MELISMA tail (no dip, continuous energy);
# then silence; then a 30ms breath spike (shorter than the gate's min span).
ENV = env_from([
    (0.30, 0.001),          # leading silence
    (0.20, 0.60),           # syl 1
    (0.06, 0.10),           # dip (consonant trough)
    (0.20, 0.22),           # syl 2 — soft
    (0.06, 0.08),           # dip
    (0.20, 0.55),           # syl 3
    (0.25, 0.50),           # melisma tail: continuous energy, NO dip
    (0.40, 0.001),          # silence
    (0.03, 0.45),           # breath spike (< MIN_SPAN_S)
    (0.30, 0.001),
])

nuc = rg.detect_e(ENV, HOP, f0=None, notes=[])
starts = [round(s["start"], 2) for s in nuc]
check("E finds exactly the three true syllables", len(nuc) == 3, f"starts={starts}")
check("the SOFT syllable is found (the Basic-Pitch miss class)",
      any(0.50 <= s <= 0.60 for s in starts), f"starts={starts}")
check("the melisma tail does NOT split (no dip = same syllable)",
      not any(s > 0.95 for s in starts), f"starts={starts}")
check("the breath spike is rejected (gate min-span)",
      not any(s > 1.5 for s in starts), f"starts={starts}")
check("slots carry the lineScores shape",
      all(set(s) >= {"start", "end", "velocity", "segments"} for s in nuc), str(nuc[:1]))
check("velocity scales with loudness (soft syllable quieter)",
      nuc[1]["velocity"] < nuc[0]["velocity"],
      f"{[s['velocity'] for s in nuc]}")

# pitch attachment: an F0 contour over syllable 1 lands as its segment pitch
F0 = [{"t": 0.30 + i * 0.01, "hz": 220.0} for i in range(20)]   # A3 = MIDI 57
nuc_p = rg.detect_e(ENV, HOP, f0=F0, notes=[])
check("median F0 attaches as the nucleus pitch",
      nuc_p[0]["segments"][0]["pitch"] == 57, str(nuc_p[0]["segments"]))
check("nuclei without F0 coverage fall back to a neighbor/default pitch",
      isinstance(nuc_p[2]["segments"][0]["pitch"], int), str(nuc_p[2]["segments"]))

# ── fusion voting ──────────────────────────────────────────────────────────────────────
# E bounds are the precise spine (a real E nucleus starts AT the span attack); BP/ASR
# extras only ADD splits when they are far from every energy bound, outside the span's
# attack-lag shadow, and backed by >=2 witnesses or voiced audio.
VENV = env_from([(0.9, 0.001), (0.4, 0.5), (0.9, 0.001)])   # voiced only ~0.9-1.3
E_N = [{"start": 0.90, "end": 1.30, "velocity": 90,
        "segments": [{"start": 0.90, "end": 1.30, "pitch": 57}]}]
BP = [{"start": 0.98, "end": 1.18, "pitch": 57, "velocity": 80}]     # late attack echo
WORDS = [{"word": "la", "start": 1.00, "end": 1.15, "conf": 0.8, "syl": 1},
         {"word": "gone", "start": 2.00, "end": 2.10, "conf": 0.6, "syl": 1}]   # lone, silent
fused = rg.detect_f(VENV, HOP, e_nuclei=E_N, notes=BP, words=WORDS)
fstarts = [round(s["start"], 2) for s in fused]
check("late witnesses of the attack do NOT split (ONE nucleus)",
      len([s for s in fstarts if s < 1.5]) == 1, str(fstarts))
check("a lone ASR anchor in silence is dropped", not any(s >= 1.9 for s in fstarts), str(fstarts))
lone_e = rg.detect_f(VENV, HOP, e_nuclei=E_N, notes=[], words=[])
check("a lone energy nucleus in VOICED audio survives", len(lone_e) == 1, str(lone_e))
# a LONE extra never splits — spans are voiced by definition, so "voiced" is not
# corroboration (the lone-accept rule ballooned the real take to 267 splits)
lone_bp = rg.detect_f(VENV, HOP, e_nuclei=E_N,
                      notes=[{"start": 1.15, "end": 1.28, "pitch": 59, "velocity": 80}],
                      words=[])
check("a lone BP onset in voiced audio does NOT split", len(lone_bp) == 1,
      str([round(s['start'], 2) for s in lone_bp]))
# the fusion VALUE-ADD: agreeing witnesses far from any energy bound split a dip-less span
BP2 = [{"start": 1.14, "end": 1.28, "pitch": 59, "velocity": 80}]
W2 = [{"word": "day", "start": 1.16, "end": 1.28, "conf": 0.8, "syl": 1}]
added = rg.detect_f(VENV, HOP, e_nuclei=E_N, notes=BP2, words=W2)
check("agreeing far witnesses ADD a split E's dips missed", len(added) == 2,
      str([round(s['start'], 2) for s in added]))

# ── determinism ────────────────────────────────────────────────────────────────────────
def dig():
    a = rg.detect_e(ENV, HOP, f0=F0, notes=[])
    b = rg.detect_f(VENV, HOP, e_nuclei=E_N, notes=BP, words=WORDS)
    return hashlib.sha256(json.dumps([a, b], sort_keys=True).encode()).hexdigest()


check("detectors are deterministic (3x)", len({dig() for _ in range(3)}) == 1)

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
