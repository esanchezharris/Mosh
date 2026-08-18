#!/usr/bin/env python3
"""template_build golden tests (run 3x — must be byte-identical).

RED-proofs: the onset list must actually be consulted by merge_held_vowels (sabotaging
it changes the output), and CTC blank-between-repeats must SPLIT (the "down down down"
regression the plan pins).

Run:  "$PROBE_PY" scripts/fms-phoneme-probe/template_build_test.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import template_build as tb  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# ── 1. CTC collapse: repeats merge, blanks split repeats, spans + conf kept ─────────
TOKS = {0: "<blank>", 1: "a", 2: "d", 3: "n"}
ids = [0, 2, 1, 1, 0, 1, 1, 3, 0]          # d a a | a a n  (blank splits the two a-runs)
confs = [0.1, 0.9, 0.8, 0.6, 0.1, 0.4, 0.6, 0.7, 0.1]
ph = tb.ctc_collapse(ids, confs, blank_id=0, sec_per_frame=0.02, id_to_tok=TOKS.get)
check("collapse merges repeats", [p["tok"] for p in ph] == ["d", "a", "a", "n"],
      str([p["tok"] for p in ph]))
check("blank splits identical runs (re-articulation survives)",
      ph[1]["tok"] == "a" and ph[2]["tok"] == "a")
check("spans kept", ph[0]["start"] == 0.02 and abs(ph[1]["end"] - 0.08) < 1e-9,
      str([(p['start'], p['end']) for p in ph]))
check("conf is the run mean", abs(ph[1]["conf"] - 0.7) < 1e-9, str(ph[1]))

# ── 2. Line segmentation ────────────────────────────────────────────────────────────
words = [{"word": "I'm", "start": 0.1, "end": 0.3}, {"word": "going", "start": 0.35, "end": 0.7},
         {"word": "but", "start": 1.5, "end": 1.7}, {"word": "up", "start": 1.75, "end": 2.0}]
spans = tb.lines_from_words(words)
check("word gaps split lines", spans == [(0.1, 0.7), (1.5, 2.0)], str(spans))

phones = [{"tok": "a", "start": 0.1, "end": 0.3, "conf": 0.9},
          {"tok": "n", "start": 0.32, "end": 0.4, "conf": 0.9},
          {"tok": "d", "start": 1.5, "end": 1.6, "conf": 0.9}]
check("blank-gap fallback splits", tb.lines_from_blanks(phones) == [(0.1, 0.4), (1.5, 1.6)],
      str(tb.lines_from_blanks(phones)))
lines = tb.cut_lines(phones, [(0.1, 0.4), (1.5, 1.6)])
check("phones cut to their spans", [len(l) for l in lines] == [2, 1])

# ── 3. Held-vowel merge + RED-proof that onsets are consulted ───────────────────────
held = [{"tok": "a", "start": 1.00, "end": 1.20, "conf": 0.9},
        {"tok": "a", "start": 1.25, "end": 1.45, "conf": 0.7},   # 50ms gap — held
        {"tok": "a", "start": 2.00, "end": 2.20, "conf": 0.8}]   # 550ms gap — separate
merged = tb.merge_held_vowels(held, onsets=[])
check("held vowel merges (no onset)", len(merged) == 2 and merged[0]["end"] == 1.45,
      str(merged))
split = tb.merge_held_vowels(held, onsets=[1.22])
check("RED: onset in the gap prevents the merge (sabotage the onset list → output changes)",
      len(split) == 3, str(len(split)))
cons = [{"tok": "n", "start": 1.0, "end": 1.1, "conf": 0.9},
        {"tok": "n", "start": 1.15, "end": 1.25, "conf": 0.9}]
check("consonant runs never merge", len(tb.merge_held_vowels(cons, onsets=[])) == 2)

# ── 2b. Long-line split at the largest gap ──────────────────────────────────────────
long = [{"tok": "a", "start": 0.1 * k + (0.5 if k >= 3 else 0.0), "end": 0.1 * k + 0.05
         + (0.5 if k >= 3 else 0.0), "conf": 0.9} for k in range(5)]
parts = tb.split_long_lines([long], max_phones=3)
check("long line splits at the biggest gap", [len(p) for p in parts] == [3, 2],
      str([len(p) for p in parts]))
check("short lines untouched", tb.split_long_lines([long], max_phones=10) == [long])

# ── 3b. Voicing onsets from an f0 contour ───────────────────────────────────────────
contour = [{"t": 1.63, "hz": 91}, {"t": 1.64, "hz": 96}, {"t": 1.65, "hz": 103},
           {"t": 2.10, "hz": 120}, {"t": 2.11, "hz": 121}]
check("f0 voicing runs → onsets", tb.onsets_from_f0(contour) == [1.63, 2.10],
      str(tb.onsets_from_f0(contour)))
check("empty contour → no onsets", tb.onsets_from_f0([]) == [])

# ── 4. Stress from energy ───────────────────────────────────────────────────────────
rms = [0.1] * 10 + [0.9] * 10 + [0.1] * 10   # hop 0.1s → loud 1.0–2.0s
st = tb.stress_from_energy([(0.0, 0.5), (1.2, 1.8), (2.5, 3.0)], rms, 0.1)
check("loud vowel stressed", st == "xXx", st)
check("lone vowel is an accent", tb.stress_from_energy([(0.0, 0.5)], rms, 0.1) == "X")

# ── 5. build_line assembly ──────────────────────────────────────────────────────────
line_ph = [{"tok": "d", "start": 1.0, "end": 1.05, "conf": 0.9},
           {"tok": "aʊ", "start": 1.05, "end": 1.6, "conf": 0.8},
           {"tok": "n", "start": 1.6, "end": 1.7, "conf": 0.9}]
line = tb.build_line(line_ph, rms, 0.1, index=0)
check("line: segs normalized", line["segs"] == ["d", "a", "ʊ", "n"], str(line["segs"]))
check("line: one syllable, nucleus 'a'", line["syllables"] == 1 and line["vowels"] == ["a"],
      str(line))
check("line: empty input → None", tb.build_line([], rms, 0.1, index=0) is None)

# ── 6. Determinism ──────────────────────────────────────────────────────────────────
check("deterministic rebuild", tb.build_line(line_ph, rms, 0.1, index=0) == line)

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failing")
sys.exit(1 if fails else 0)
