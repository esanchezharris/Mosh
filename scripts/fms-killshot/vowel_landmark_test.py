#!/usr/bin/env python3
"""Golden tests for the V0 vowel-landmark pure core (mechanism-verify spec §1).

Pins: word-instance grouping over the score's note chain (incl. the 'so so so' 2/2/3 case
and melisma type-3 runs), span agreement with soulx.score.word_event_spans, onset-cluster
classification (voiceless set), the debounced voicing-onset + gap-tolerant run estimators,
and the pure stats (spearman ties, OLS slope). Deterministic (3× identical digest).

Run:  python3 scripts/fms-killshot/vowel_landmark_test.py     (exit 0 = all pass)
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import vowel_landmark as vl  # noqa: E402
from soulx import score as sx  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# ── word_events ────────────────────────────────────────────────────────────────────────
# rest | time(1n) | so(1n) so(2n: 2,3) | rest | shared(1n, trailing no rest)
CLIP = {
    "index": "test_0_2600", "language": "English", "time": [0, 2600],
    "duration": "0.2000 0.3000 0.1000 0.1500 0.2500 0.4000 0.6000",
    "text": "<SP> time so so so <SP> shared",
    "phoneme": "<SP> en_T-AY1-M en_S-OW1 en_OW1 en_OW1 <SP> en_SH-EH1-R-D",
    "note_pitch": "0 60 62 62 63 0 58",
    "note_type": "1 2 2 2 3 1 2",
}
evs = vl.word_events(CLIP)
check("4 word instances", len(evs) == 4, str([e["word"] for e in evs]))
check("'time' span", evs[0]["start"] == 0.2 and abs(evs[0]["end"] - 0.5) < 1e-9)
check("first 'so' is a single note", evs[1]["n_notes"] == 1 and abs(evs[1]["end"] - 0.6) < 1e-9)
check("second 'so' rides its type-3 run (2 notes)",
      evs[2]["n_notes"] == 2 and abs(evs[2]["start"] - 0.6) < 1e-9 and abs(evs[2]["end"] - 1.0) < 1e-9,
      str(evs[2]))
check("melisma pitches kept in order", evs[2]["pitches"] == [62, 63])
check("trailing word closes without a rest", evs[3]["word"] == "shared" and abs(evs[3]["end"] - 2.0) < 1e-9)

spans = [(e["start"], e["end"]) for e in evs]
sx_spans = [(round(a, 4), round(b, 4)) for a, b in sx.word_event_spans(CLIP)]
check("span agreement with soulx.score.word_event_spans", spans == sx_spans,
      f"{spans} vs {sx_spans}")

REAL = os.path.expanduser(
    "~/mosh-fms-ksb/used2/asserted-proof/back-half/sing-handoff/scores/u2full-c00.json")
if os.path.isfile(REAL):
    with open(REAL) as f:
        rc = json.load(f)[0]
    revs = vl.word_events(rc)
    rspans = [(e["start"], e["end"]) for e in revs]
    rsx = [(round(a, 4), round(b, 4)) for a, b in sx.word_event_spans(rc)]
    check("real u2full-c00 span agreement", rspans == rsx, f"{len(rspans)} words")
    check("real chunk chain sums to time[1]",
          abs(sum(float(d) for d in rc["duration"].split()) - rc["time"][1] / 1000.0) < 0.005)
else:
    print("[skip] real u2full-c00.json not present — synthetic agreement only")

# ── onset_cluster ──────────────────────────────────────────────────────────────────────
for tok, want_cluster, want_voiceless in [
    ("en_T-AY1-M", ["T"], True),
    ("en_SH-EH1-R-D", ["SH"], True),
    ("en_F-L-IH1-P-S", ["F", "L"], False),          # L is voiced
    ("en_S-T-R-EY1-N-JH", ["S", "T", "R"], False),  # R is voiced
    ("en_N-AY1-T-S", ["N"], False),
    ("en_AH0", [], False),                           # vowel-initial: empty, never 'clean'
    ("en_HH-AA1-R-T", ["HH"], True),
    ("<SP>", [], False),
]:
    c, v = vl.onset_cluster(tok)
    check(f"onset_cluster {tok}", c == want_cluster and v == want_voiceless, f"{c} {v}")

# ── voicing estimators ─────────────────────────────────────────────────────────────────
HOP = 0.01
def grid(bits):
    return [(round(i * HOP, 4), bool(b)) for i, b in enumerate(bits)]

# onset at 50ms with solid voicing after; a lone voiced blip at 20ms must NOT pass debounce
fr = grid([0, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0])
on = vl.voiced_onset(fr, 0.0, 0.13)
check("debounce skips the lone blip", on == 0.05, str(on))
check("no onset in an unvoiced window", vl.voiced_onset(grid([0] * 10), 0.0, 0.09) is None)
check("window clips the search", vl.voiced_onset(fr, 0.0, 0.03) is None)

# run end: survives a 20ms gap, dies on a 30ms gap, respects the cap
fr2 = grid([1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1, 1])
check("run survives <=20ms gap", abs(vl.voiced_run_end(fr2, 0.0, 0.2) - 0.06) < 1e-9,
      str(vl.voiced_run_end(fr2, 0.0, 0.2)))
check("run capped", abs(vl.voiced_run_end(fr2, 0.0, 0.05) - 0.05) < 1e-9)
fr3 = grid([1, 1, 0, 0, 0, 0, 1, 1])
check("run dies on a >20ms gap", abs(vl.voiced_run_end(fr3, 0.0, 0.2) - 0.01) < 1e-9)

# ── stats ──────────────────────────────────────────────────────────────────────────────
check("spearman perfect", abs(vl.spearman([0, 1, 2, 3], [5, 10, 20, 40]) - 1.0) < 1e-9)
check("spearman inverse", abs(vl.spearman([0, 1, 2, 3], [40, 20, 10, 5]) + 1.0) < 1e-9)
check("spearman ties handled", vl.spearman([0, 0, 1, 1], [1, 1, 2, 2]) is not None)
check("spearman degenerate -> None", vl.spearman([1, 1, 1], [1, 2, 3]) is None)
check("ols slope", abs(vl.ols_slope([0, 1, 2], [10, 30, 50]) - 20.0) < 1e-9)
check("median even", vl.median([1, 2, 3, 4]) == 2.5)
check("ranks average ties", vl._ranks([10, 10, 20]) == [1.5, 1.5, 3.0])

# ── vowel_onset_report (B3: the QA-grade readout for overlap.py) ───────────────────────
# Synthetic: 'time' (T onset, clean) commanded 0.2–0.5 — take vowel at 0.25, render at
# 0.30 → +50ms delta; take run 0.25–0.45 (0.20s), render 0.30–0.44 (0.14s) → ratio 0.7.
take_fr = grid([0] * 25 + [1] * 21 + [0] * 160)             # voiced 0.25..0.45
rend_fr = grid([0] * 30 + [1] * 15 + [0] * 161)             # voiced 0.30..0.44
rep = vl.vowel_onset_report(CLIP, take_fr, rend_fr)
check("report available + counts words", rep["available"] and rep["words"] == 4, str(rep))
check("report clean subset = time + first-so + shared (voiceless onsets; the melisma 'so' is vowel-initial)",
      rep["clean"] == 3, str(rep))
check("report measures the +50ms delta on the clean word",
      rep["measured"] == 1 and abs(rep["median_vowel_onset_delta_ms"] - 50.0) <= 10.0, str(rep))
check("report sees the squeeze (dur ratio < 0.8)",
      rep["median_vowel_dur_ratio"] is not None and rep["median_vowel_dur_ratio"] < 0.8
      and rep["squeeze_frac"] == 1.0, str(rep))

# ── determinism (3×) ───────────────────────────────────────────────────────────────────
def digest():
    payload = {
        "evs": vl.word_events(CLIP),
        "on": vl.voiced_onset(fr, 0.0, 0.13),
        "run": vl.voiced_run_end(fr2, 0.0, 0.2),
        "rho": vl.spearman([0, 1, 2, 3, 4], [3, 9, 1, 12, 15]),
        "slope": vl.ols_slope([0, 1, 2, 3, 4], [3, 9, 1, 12, 15]),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()

d = {digest() for _ in range(3)}
check("3x deterministic", len(d) == 1, str(d))

if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print("\nOK: 0 failure(s)")
