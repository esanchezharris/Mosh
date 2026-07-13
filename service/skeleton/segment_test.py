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

if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print("\nOK: 0 failure(s)")
