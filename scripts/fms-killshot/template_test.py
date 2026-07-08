#!/usr/bin/env python3
"""Golden tests for the per-syllable template extractor (FMS reset, Stage 0).

Pins the deterministic core: real-word syllables come from the forced-aligned spans, gap
syllables from the note onsets inside the silence between real words, and every syllable gets
a strong/weak STRESS (longer-or-louder than the take's median) + a strong/weak BEAT (on the
known-BPM grid). The forced alignment / F0 / note detection that feed it are owner-gated; this
is the pure grid underneath, which the click track then validates by ear.

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


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# ── 1. units_from_lyric: real words + "*" mumble syllables ──────────────────────────────
u = tp.units_from_lyric(["hold the * * line", "* go"])
check("units parse: words + collapsed gap runs",
      u == [{"word": "hold"}, {"word": "the"}, {"gap": 2}, {"word": "line"}, {"gap": 1}, {"word": "go"}], str(u))


# ── 2. beat grid helpers (120 bpm → beat every 0.5s; strong = beats 1 & 3) ──────────────
check("on_strong_beat: downbeat strong", tp.on_strong_beat(0.0, 120) and tp.on_strong_beat(2.0, 120))
check("on_strong_beat: beat 3 strong", tp.on_strong_beat(1.0, 120))
check("on_strong_beat: beat 2 weak", not tp.on_strong_beat(0.5, 120))
check("on_strong_beat: off-grid weak", not tp.on_strong_beat(0.73, 120))
bp = tp.beat_positions(120, 2.0)
check("beat_positions: 5 beats, strong at 0/1.0/2.0",
      [b["t"] for b in bp] == [0.0, 0.5, 1.0, 1.5, 2.0]
      and [b["strong"] for b in bp] == [True, False, True, False, True], str(bp))


# ── 3. build_template: real from alignment, gap from note onsets, stress + beat ─────────
units = [{"word": "hold"}, {"gap": 2}, {"word": "flame"}]
aligned = [{"word": "hold", "start": 0.0, "end": 0.5}, {"word": "flame", "start": 2.0, "end": 2.6}]
notes = [{"start": 0.8, "end": 1.3}, {"start": 1.4, "end": 1.9}]        # two mumble onsets in the gap
f0 = [{"t": i * 0.02, "hz": 220.0} for i in range(150)]                 # constant 220 Hz → MIDI 57
env = [1.0] * 50 + [0.2] * 210                                          # "hold" (0–0.5s) loud, rest quiet
tpl = tp.build_template(units, aligned, notes, f0, env, hop_s=0.01, bpm=120.0)

check("one syllable per real word + one per gap onset (4 total)", len(tpl) == 4, str(len(tpl)))
check("time-ordered with dense i", [s["i"] for s in tpl] == [0, 1, 2, 3]
      and [s["onset"] for s in tpl] == sorted(s["onset"] for s in tpl))
check("origins: real, gap, gap, real", [s["origin"] for s in tpl] == ["real", "gap", "gap", "real"],
      str([s["origin"] for s in tpl]))
check("onsets land where expected", [s["onset"] for s in tpl] == [0.0, 0.8, 1.4, 2.0],
      str([s["onset"] for s in tpl]))
check("gap syllables placed at the note onsets", tpl[1]["word"] is None and tpl[2]["word"] is None)
check("pitch read from F0 (220Hz → MIDI 57)", all(s["pitch"] == 57 for s in tpl), str([s["pitch"] for s in tpl]))
check("STRESS: the loud 'hold' is strong, the quiet rest weak",
      tpl[0]["stress"] == "strong" and [s["stress"] for s in tpl[1:]] == ["weak", "weak", "weak"],
      str([s["stress"] for s in tpl]))
check("BEAT: real words on downbeats are strong, off-grid gaps weak",
      tpl[0]["beat"] == "strong" and tpl[3]["beat"] == "strong"
      and tpl[1]["beat"] == "weak" and tpl[2]["beat"] == "weak",
      str([s["beat"] for s in tpl]))

# gap with NO detected notes → even-spaced placeholder syllables (a missed mumble still gets a grid)
tpl2 = tp.build_template([{"word": "a"}, {"gap": 3}, {"word": "b"}],
                         [{"word": "a", "start": 0.0, "end": 0.3}, {"word": "b", "start": 1.5, "end": 1.8}],
                         notes=[], f0=f0, env=env, bpm=120.0)
gap_onsets = [s["onset"] for s in tpl2 if s["origin"] == "gap"]
check("gap with no notes → 3 even-spaced placeholder syllables", len(gap_onsets) == 3
      and abs(gap_onsets[0] - 0.3) < 0.01, str(gap_onsets))

# ── 4. determinism ─────────────────────────────────────────────────────────────────────
digs = {hashlib.sha256(json.dumps(tp.build_template(units, aligned, notes, f0, env, bpm=120.0),
                                  sort_keys=True).encode()).hexdigest() for _ in range(3)}
check("build_template 3× deterministic", len(digs) == 1, str(len(digs)))


if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print("\nOK: 0 failure(s)")
