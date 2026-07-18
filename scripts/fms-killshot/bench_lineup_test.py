#!/usr/bin/env python3
"""Goldens for the waveform-lineup instrument (pure cores, synthetic envelopes).

Run:  python3 scripts/fms-killshot/bench_lineup_test.py   (exit 0 = all pass)
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_lineup as bl  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def env(spans, hop=0.01, total=None):
    """[(start, end, level)] -> envelope frames at `hop`; elsewhere 0.001 (noise floor)."""
    end = total if total is not None else max(e for _, e, _ in spans)
    n = int(end / hop)
    out = [0.001] * n
    for a, b, lv in spans:
        for i in range(int(a / hop), min(n, int(b / hop))):
            out[i] = lv
    return out


HOP = 0.01

# take: sings 0.2-1.0 and 1.4-2.2, rests 1.0-1.4 and edges
TAKE = env([(0.2, 1.0, 0.5), (1.4, 2.2, 0.5)], total=2.5)

# ── identical -> zero everywhere (calibration: identity reads as identity) ───────────────
rep = bl.lineup_from_envs(TAKE, list(TAKE), HOP)
check("identical: lag 0", rep["lag_ms"] == 0.0, str(rep["lag_ms"]))
check("identical: no missing/spurious", rep["raw"] == {"missing_frac": 0.0, "spurious_frac": 0.0},
      str(rep["raw"]))
check("identical: no spans", rep["spans"] == [])

# ── render 100ms late -> lag detected; global shift repairs the fracs ────────────────────
LATE = env([(0.3, 1.1, 0.5), (1.5, 2.3, 0.5)], total=2.5)
rep = bl.lineup_from_envs(TAKE, LATE, HOP)
check("late render: lag ~ +100 ms", abs(rep["lag_ms"] - 100.0) <= 10.0, str(rep["lag_ms"]))
check("late render: raw mismatch exists", rep["raw"]["missing_frac"] > 0.05, str(rep["raw"]))
check("late render: global shift repairs it",
      rep["after_global_shift"]["missing_frac"] <= 0.02
      and rep["after_global_shift"]["spurious_frac"] <= 0.02, str(rep["after_global_shift"]))

# ── render silent through the second note -> ONE missing span at the right place ─────────
HALF = env([(0.2, 1.0, 0.5)], total=2.5)
rep = bl.lineup_from_envs(TAKE, HALF, HOP)
miss = [s for s in rep["spans"] if s["kind"] == "missing"]
check("missing note: one span", len(miss) == 1, str(miss))
check("missing note: span covers 1.4-2.2", miss and abs(miss[0]["start"] - 1.4) < 0.05
      and abs(miss[0]["end"] - 2.2) < 0.05, str(miss))
check("missing note: fraction ~ half the voiced time",
      abs(rep["raw"]["missing_frac"] - 0.5) < 0.05, str(rep["raw"]))

# ── render sings through the take's rest -> spurious span (the vice versa) ───────────────
FILLED = env([(0.2, 2.2, 0.5)], total=2.5)
rep = bl.lineup_from_envs(TAKE, FILLED, HOP)
spur = [s for s in rep["spans"] if s["kind"] == "spurious"]
check("spurious: one span in the rest", len(spur) == 1
      and abs(spur[0]["start"] - 1.0) < 0.05 and abs(spur[0]["end"] - 1.4) < 0.05, str(spur))

# ── sub-80ms flutter is NOT a finding ───────────────────────────────────────────────────
FLICKER = env([(0.2, 0.55, 0.5), (0.60, 1.0, 0.5), (1.4, 2.2, 0.5)], total=2.5)  # 50ms hole
rep = bl.lineup_from_envs(TAKE, FLICKER, HOP)
check("50ms flicker ignored (min span gate)",
      all(s["dur_s"] >= 0.08 for s in rep["spans"]) and
      not any(0.5 < s["start"] < 0.7 for s in rep["spans"]), str(rep["spans"]))

# ── classification: commanded rest vs disobeyed note ────────────────────────────────────
# score commands singing 0.2-1.0 only; take sings 0.2-1.0 and 1.4-2.2; render matches score.
rep = bl.lineup_from_envs(TAKE, HALF, HOP, sung_spans=[(0.2, 1.0)])
miss = [s for s in rep["spans"] if s["kind"] == "missing"]
check("silence at a commanded REST classifies in_rest (authoring bug)",
      miss and miss[0]["commanded"] == "rest", str(miss))
# score commands singing through 2.2 but the render is silent -> model disobeyed
rep = bl.lineup_from_envs(TAKE, HALF, HOP, sung_spans=[(0.2, 1.0), (1.4, 2.2)])
miss = [s for s in rep["spans"] if s["kind"] == "missing"]
check("silence at a commanded NOTE classifies in_note (model under-fill)",
      miss and miss[0]["commanded"] == "note", str(miss))
check("span_s_by_class aggregates", rep["span_s_by_class"].get("missing@note", 0) > 0.7,
      str(rep["span_s_by_class"]))

# ── word attribution ────────────────────────────────────────────────────────────────────
words = [{"word": "we", "start": 0.2, "end": 1.0}, {"word": "been", "start": 1.4, "end": 2.2}]
rep = bl.lineup_from_envs(TAKE, HALF, HOP, words=words)
miss = [s for s in rep["spans"] if s["kind"] == "missing"]
check("missing span names the word it silences", miss and miss[0]["word"] == "been", str(miss))

# ── shift sign convention: positive lag means the render is LATE ────────────────────────
check("best_shift sign: late render = positive", bl.best_shift(TAKE, LATE, HOP) > 0)
EARLY = env([(0.1, 0.9, 0.5), (1.3, 2.1, 0.5)], total=2.5)
check("best_shift sign: early render = negative", bl.best_shift(TAKE, EARLY, HOP) < 0)

# ── determinism ─────────────────────────────────────────────────────────────────────────
det = {hashlib.sha256(json.dumps(bl.lineup_from_envs(TAKE, LATE, HOP, words=words,
                                                     sung_spans=[(0.2, 1.0)]),
                                 sort_keys=True).encode()).hexdigest() for _ in range(3)}
check("lineup_from_envs deterministic (3x)", len(det) == 1)

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
