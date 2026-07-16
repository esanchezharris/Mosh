#!/usr/bin/env python3
"""Golden tests for the energy-first segment detector (Phase C consolidation).

The benchtest verdict (2026-07-13, scripts/fms-killshot/backhalf_gridbench.py): a SIMPLE
energy detector — gate attacks + relative-dip re-articulations — matches/beats the elaborate
Basic-Pitch v3/v4 ladder on per-phrase syllable COUNTS against the owner's 147-mark truth.
This promotes that detector into product code: existence from the energy envelope + F0, with
melisma segments re-derived from F0 inside each nucleus (SoulX continuation glides survive).

Pure stdlib, deterministic. Run:  python3 service/skeleton/segment_test.py   (exit 0 = pass)
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from skeleton import segment as sg  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


HOP = 0.01  # 10 ms

# ── 1. gate_events: two loud bursts separated by silence -> 2 spans, 2 attacks ─────────
env2 = [0.02] * 10 + [0.5] * 30 + [0.02] * 20 + [0.5] * 30 + [0.02] * 10
attacks, spans = sg.gate_events(env2, HOP)
check("gate_events: two bursts -> 2 attacks / 2 spans", len(attacks) == 2 and len(spans) == 2,
      f"attacks={[round(a,2) for a in attacks]} spans={len(spans)}")
check("gate_events: first attack near the burst onset (~0.10s)", abs(attacks[0] - 0.10) <= 0.02, str(attacks[0]))

# ── 2. dip_events: la-la joined by a shallow valley that never crosses the gate -> 1 dip ─
lala = [0.02] * 10 + [0.5] * 30 + [0.2] * 5 + [0.5] * 30 + [0.02] * 10
_, spans1 = sg.gate_events(lala, HOP)
check("dip fixture is ONE gate span (valley never closes the gate)", len(spans1) == 1, str(len(spans1)))
dips = sg.dip_events(lala, HOP, spans1)
check("dip_events: the relative valley is a re-articulation boundary", len(dips) == 1, str(dips))

# ── 3. pitch_step_events: a sustained +semitone step fires one legato boundary ─────────
f0_step = ([{"t": i / 100.0, "hz": 220.0} for i in range(50)]
           + [{"t": i / 100.0, "hz": 277.18} for i in range(50, 100)])
steps = sg.pitch_step_events(f0_step)
check("pitch_step_events: a held +4st step fires >=1 boundary near 0.5s",
      len(steps) >= 1 and any(abs(t - 0.5) <= 0.05 for t in steps), str(steps))
check("pitch_step_events: a steady contour fires nothing",
      sg.pitch_step_events([{"t": i / 100.0, "hz": 220.0} for i in range(100)]) == [], "")

# ── 4. energy_nuclei: existence from gate+dip; each nucleus = ONE syllable slot ────────
nuc = sg.energy_nuclei(lala, HOP, None)
check("energy_nuclei: la-la -> 2 nuclei (attack + dip re-articulation)", len(nuc) == 2, str(len(nuc)))
check("energy_nuclei: each nucleus has velocity 1..127 + >=1 segment",
      all(1 <= n["velocity"] <= 127 and len(n["segments"]) >= 1 for n in nuc),
      str([(n["velocity"], len(n["segments"])) for n in nuc]))

# ── 5. melisma: a pitch step INSIDE one nucleus splits its segments, NOT its slot count ─
melisma_env = [0.02] * 10 + [0.5] * 80 + [0.02] * 10           # one continuous span
melisma_nuc = sg.energy_nuclei(melisma_env, HOP, f0_step)
check("melisma: one continuous span stays ONE syllable nucleus", len(melisma_nuc) == 1, str(len(melisma_nuc)))
check("melisma: the F0 step splits it into 2 pitch segments (SoulX glide preserved)",
      len(melisma_nuc[0]["segments"]) == 2, str([s["pitch"] for s in melisma_nuc[0]["segments"]]))
check("melisma: segments carry rising pitches (57 -> ~61)",
      melisma_nuc[0]["segments"][0]["pitch"] < melisma_nuc[0]["segments"][1]["pitch"],
      str([s["pitch"] for s in melisma_nuc[0]["segments"]]))

# ── 6. empty envelope -> no nuclei (caller degrades to the v1 floor) ───────────────────
check("energy_nuclei([]) -> [] (degrades, never crashes)", sg.energy_nuclei([], HOP, None) == [])

# ── 7. determinism: 3x identical ──────────────────────────────────────────────────────
digs = {hashlib.sha256(json.dumps(sg.energy_nuclei(lala, HOP, f0_step), sort_keys=True).encode()).hexdigest()
        for _ in range(3)}
check("energy_nuclei 3x deterministic", len(digs) == 1)


# ── 8. merge_short_nuclei: sub-floor slots fold into a neighbour (the density fix) ──────
# Measured 2026-07-16: the energy grid emits 40–110ms nuclei; every slot gets a word, so the
# score crams syllables no singer can articulate. Slots shorter than min_s fold into their
# nearest-in-time neighbour (equidistant -> the LONGER one, the grid_check fold precedent);
# a lone blip with no neighbour within join_gap_s drops (consonant burst/echo, not a syllable).
def N(a, b, vel=90, pitch=60):
    return {"start": a, "end": b, "velocity": vel,
            "segments": [{"start": a, "end": b, "pitch": pitch}]}


def _tiles(n):
    """Segments exactly tile the slot span, contiguously."""
    segs = n["segments"]
    return (segs and abs(segs[0]["start"] - n["start"]) < 1e-9
            and abs(segs[-1]["end"] - n["end"]) < 1e-9
            and all(abs(segs[i]["end"] - segs[i + 1]["start"]) < 1e-9 for i in range(len(segs) - 1)))


# 8a. all slots >= floor -> byte-identical no-op
ok_slots = [N(0.0, 0.30), N(0.40, 0.70), N(0.90, 1.40)]
check("merge: all >= floor is a no-op", sg.merge_short_nuclei(ok_slots) == ok_slots)

# 8b. short slot folds BACKWARD into a nearer preceding neighbour (velocity = max, tiles)
back = sg.merge_short_nuclei([N(0.0, 0.30, vel=80), N(0.31, 0.37, vel=110), N(0.60, 0.90)])
check("merge: folds backward into the nearer prev", len(back) == 2 and back[0]["end"] == 0.37,
      str([(n["start"], n["end"]) for n in back]))
check("merge: absorbed velocity = max(neighbour, short)", back[0]["velocity"] == 110, str(back[0]["velocity"]))
check("merge: backward-extended slot's segments tile its span", _tiles(back[0]),
      str(back[0]["segments"]))

# 8c. phrase-initial short slot folds FORWARD (only neighbour is the next slot)
fwd = sg.merge_short_nuclei([N(0.0, 0.06), N(0.10, 0.40)])
check("merge: phrase-initial folds forward", len(fwd) == 1 and fwd[0]["start"] == 0.0
      and fwd[0]["end"] == 0.40, str([(n["start"], n["end"]) for n in fwd]))
check("merge: forward-extended slot's segments tile its span", _tiles(fwd[0]), str(fwd[0]["segments"]))

# 8d. equidistant neighbours -> fold into the LONGER one (binary-exact gaps of 0.125)
tie = sg.merge_short_nuclei([N(0.0, 0.25), N(0.375, 0.4375), N(0.5625, 1.5625)])
check("merge: equidistant tie folds into the LONGER neighbour",
      len(tie) == 2 and tie[1]["start"] == 0.375 and tie[0]["end"] == 0.25,
      str([(n["start"], n["end"]) for n in tie]))

# 8e. a lone blip with no neighbour within join_gap_s DROPS
lone = sg.merge_short_nuclei([N(0.0, 0.30), N(1.0, 1.06), N(2.0, 2.30)])
check("merge: isolated sub-floor blip drops", len(lone) == 2
      and [n["start"] for n in lone] == [0.0, 2.0], str([(n["start"], n["end"]) for n in lone]))

# 8f. a CHAIN of tiny slots keeps folding until nothing is sub-floor
chain = sg.merge_short_nuclei([N(0.0, 0.04), N(0.05, 0.09), N(0.11, 0.41)])
check("merge: tiny chain collapses into the real slot", len(chain) == 1
      and chain[0]["start"] == 0.0 and chain[0]["end"] == 0.41,
      str([(n["start"], n["end"]) for n in chain]))
check("merge: chain result tiles + nothing sub-floor",
      _tiles(chain[0]) and all(n["end"] - n["start"] >= 0.10 for n in chain), str(chain))

# 8h. a real fast 16th SURVIVES: 105ms ~ a 16th at 138-152bpm — the floor must not eat it.
# Swept vs the owner's 147-mark truth (2026-07-16): floor 100ms is strictly better than raw
# (|delta| 28<31, F1@120 0.72>0.70, within-1 preserved); 120ms folded real 16ths (within-1
# 11->8). The cram class the ear caught was 40-99ms.
keep = sg.merge_short_nuclei([N(0.0, 0.30), N(0.35, 0.455)])
check("merge: a 105ms slot (real 16th) survives the floor", len(keep) == 2,
      str([(n["start"], n["end"]) for n in keep]))

# 8g. determinism: 3x identical on a mixed fixture
mixed = [N(0.0, 0.30), N(0.31, 0.37), N(0.60, 0.66), N(1.5, 1.56), N(2.0, 2.40)]
mdigs = {hashlib.sha256(json.dumps(sg.merge_short_nuclei(mixed), sort_keys=True).encode()).hexdigest()
         for _ in range(3)}
check("merge_short_nuclei 3x deterministic", len(mdigs) == 1)

if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print("\nOK: 0 failure(s)")
