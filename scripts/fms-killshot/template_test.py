#!/usr/bin/env python3
"""Golden tests for the STRUCTURED (grid-quantized) template extractor (FMS reset, Stage 0).

Pins the two structural commitments: the syllable COUNT is exact (from the words — real words via
phonology, `*` mumble marks one each — never from noisy onset detection), and every onset snaps to
the musical grid (16th notes at the known BPM), monotonic, min one grid step. The forced alignment
that supplies rough timing is owner-gated; this is the pure grid underneath.

Run:  python3 scripts/fms-killshot/template_test.py     (exit 0 = all pass)
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import template as tp  # noqa: E402

fails = []
EPS = 1e-6


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# ── 1. units_from_lyric ─────────────────────────────────────────────────────────────────
u = tp.units_from_lyric(["hold the * * line", "* go"])
check("units parse: words + collapsed gap runs",
      u == [{"word": "hold"}, {"word": "the"}, {"gap": 2}, {"word": "line"}, {"gap": 1}, {"word": "go"}], str(u))


# ── 2. grid helpers ─────────────────────────────────────────────────────────────────────
check("grid_step: 120bpm 16ths = 0.125s", abs(tp.grid_step(120, 4) - 0.125) < EPS)
check("beat_dur: 120bpm = 0.5s", abs(tp.beat_dur(120) - 0.5) < EPS)
check("calibrate_phase: on-grid anchors → phase 0",
      abs(tp.calibrate_phase([0.0, 0.25, 0.5, 1.0], 0.125)) < EPS, str(tp.calibrate_phase([0.0, 0.25, 0.5], 0.125)))
bp = tp.beat_positions(120, 2.0)
check("beat_positions: strong at 0/1.0/2.0",
      [b["strong"] for b in bp] == [True, False, True, False, True], str(bp))


# ── 3. build_template: EXACT count from words, onsets snapped to the grid ────────────────
units = tp.units_from_lyric(["hello * * * world"])          # hello=2syl, 3 mumble, world=1syl → 6
aligned = [{"word": "hello", "start": 0.0, "end": 1.0}, {"word": "world", "start": 3.0, "end": 3.5}]
f0 = [{"t": i * 0.02, "hz": 220.0} for i in range(200)]     # → MIDI 57
env = [0.5] * 400
tpl = tp.build_template(units, aligned, f0=f0, env=env, bpm=120.0, subdiv=4)
step = 0.125

check("syllable count is EXACT from the words (2+3+1 = 6), not onset detection", len(tpl) == 6, str(len(tpl)))
check("origins follow the words: real,real,gap,gap,gap,real",
      [s["origin"] for s in tpl] == ["real", "real", "gap", "gap", "gap", "real"], str([s["origin"] for s in tpl]))
onsets = [s["onset"] for s in tpl]
check("onsets strictly increasing", all(b > a for a, b in zip(onsets, onsets[1:])), str(onsets))
check("every onset lands on the grid (a multiple of the 16th step)",
      all(abs((o / step) - round(o / step)) < 1e-4 for o in onsets), str(onsets))
check("grid indices k strictly increasing (monotonic, no collisions)",
      all(b > a for a, b in zip([s["k"] for s in tpl], [s["k"] for s in tpl][1:])), str([s["k"] for s in tpl]))
check("every duration ≥ one grid step (no crammed syllables)",
      all(s["dur"] >= step - 1e-4 for s in tpl), str([s["dur"] for s in tpl]))
check("pitch read from F0 (220Hz → MIDI 57)", all(s["pitch"] == 57 for s in tpl))
check("on-beat syllables marked strong (grid k % subdiv == 0)",
      all((s["stress"] == "strong") == (s["k"] % 4 == 0) for s in tpl))

# a real word contributes exactly its phonology-syllable count of entries
tpl2 = tp.build_template(tp.units_from_lyric(["everything"]),
                         [{"word": "everything", "start": 0.0, "end": 1.2}], f0=f0, bpm=120.0)
check("'everything' → 3 syllable entries (word-derived count)", len(tpl2) == 3, str(len(tpl2)))

# a gap uses the * count, not any audio — 4 stars → 4 gap syllables
tpl3 = tp.build_template(tp.units_from_lyric(["go * * * * home"]),
                         [{"word": "go", "start": 0.0, "end": 0.3}, {"word": "home", "start": 2.0, "end": 2.4}],
                         f0=f0, bpm=120.0)
check("gap of 4 stars → exactly 4 gap syllables", sum(1 for s in tpl3 if s["origin"] == "gap") == 4,
      str([s["origin"] for s in tpl3]))


# ── 4. determinism ─────────────────────────────────────────────────────────────────────
digs = {hashlib.sha256(json.dumps(tp.build_template(units, aligned, f0=f0, env=env, bpm=120.0),
                                  sort_keys=True).encode()).hexdigest() for _ in range(3)}
check("build_template 3× deterministic", len(digs) == 1, str(len(digs)))


if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print("\nOK: 0 failure(s)")
