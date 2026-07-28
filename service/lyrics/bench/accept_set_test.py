#!/usr/bin/env python3
"""Golden tests for accept-set plumbing (FMS WS1 / M5c).

Run:  python3 service/lyrics/bench/accept_set_test.py     (exit 0 = all pass)
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

_TD = tempfile.mkdtemp()
os.environ["MOSH_LYRICS_BENCH_DIR"] = _TD

from lyrics.bench import accept_set as A  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def item(i="v2:rhyme:gs:1:s0:l0", truth="grind"):
    return {"itemId": i, "target": {"text": truth}}


# ---- 1. append-only log, replayed into sets ----
A.record("dev", "i1", "hustle", "accept")
A.record("dev", "i1", "orange", "reject")
A.record("dev", "i2", "shine", "accept")
sets = A.load("dev")
check("log: judgements replay into per-item sets",
      sets["i1"]["accept"] == {"hustle"} and sets["i1"]["reject"] == {"orange"}
      and sets["i2"]["accept"] == {"shine"}, str(sets))

# ---- 2. a judgement is REVISED by appending, never by editing history ----
A.record("dev", "i1", "hustle", "reject")
sets = A.load("dev")
check("log: the last verdict wins", "hustle" in sets["i1"]["reject"]
      and "hustle" not in sets["i1"]["accept"], str(sets["i1"]))
raw = open(A.log_path("dev"), encoding="utf-8").read().strip().splitlines()
check("log: history is preserved (append-only, nothing rewritten)", len(raw) == 4,
      f"{len(raw)} lines")
check("log: a torn line is skipped, not fatal",
      (open(A.log_path("dev"), "a", encoding="utf-8").write("{not json\n") or True)
      and "i1" in A.load("dev"))

# ---- 3. scoring ----
S = {"x": {"accept": {"hustle"}, "reject": {"orange"}}}
check("score: the artist's own word is always a pass",
      A.accept_score(item("x"), ["grind"], S) == 1)
check("score: an owner-ACCEPTED substitute is a pass",
      A.accept_score(item("x"), ["hustle"], S) == 1)
check("score: an owner-REJECTED substitute is a fail",
      A.accept_score(item("x"), ["orange"], S) == 0)
check("score: an UNJUDGED word on a judged item is None, not a fail",
      A.accept_score(item("x"), ["chrome"], S) is None)
check("score: an item with no judgements at all is None, not a fail",
      A.accept_score(item("zzz"), ["chrome"], S) is None,
      "counting unlabelled items as 0 would make the metric look bad in exact "
      "proportion to how little labelling has happened")
check("score: no candidates is None", A.accept_score(item("x"), [], S) is None)

# ---- 4. coverage is reported beside the score ----
rows = [{"itemId": "x", "exact": 1, "accept_fit": 1},
        {"itemId": "y", "exact": 0, "accept_fit": 0},
        {"itemId": "z", "exact": 0, "accept_fit": None}]
s = A.summarize(rows)
check("summary: accept score is over JUDGED items only",
      s["acceptFit"] == 0.5 and s["judgedItems"] == 2, str(s))
check("summary: coverage is stated next to the score",
      abs(s["coverage"] - 2 / 3) < 1e-9, str(s["coverage"]))
check("summary: exact is reported alongside for comparison", s["exact"] is not None)
check("summary: zero labels gives acceptFit None, never 0.0",
      A.summarize([{"itemId": "a", "exact": 1, "accept_fit": None}])["acceptFit"] is None)

# ---- 5. the Goodhart alarm ----
base = {"exact": 0.30, "acceptFit": 0.50}
climb = {"exact": 0.40, "acceptFit": 0.50}      # exact up, accept flat
both = {"exact": 0.40, "acceptFit": 0.62}       # both up
check("goodhart: FIRES when exact climbs and accept-set does not",
      A.goodhart_alarm(base, climb)["status"] == "ALARM",
      str(A.goodhart_alarm(base, climb)))
check("goodhart: silent when both move together",
      A.goodhart_alarm(base, both)["status"] == "ok", str(A.goodhart_alarm(base, both)))
check("goodhart: reports both deltas so the call is checkable",
      A.goodhart_alarm(base, climb)["deltaExact"] == 0.10
      and A.goodhart_alarm(base, climb)["deltaAccept"] == 0.0)
check("goodhart: says 'no-labels' rather than manufacturing an alarm",
      A.goodhart_alarm({"exact": .3, "acceptFit": None}, climb)["status"] == "no-labels")
# Fixture adequacy: the alarm must not fire on everything.
check("goodhart fixture: a flat arm does not trip it",
      A.goodhart_alarm(base, {"exact": 0.30, "acceptFit": 0.50})["status"] == "ok")

# ---- 6. annotate joins rows to items ----
rows2 = [{"itemId": "x", "candidates": ["hustle"]},
         {"itemId": "q", "candidates": ["chrome"]}]
A.annotate(rows2, {"x": item("x"), "q": item("q")}, S)
check("annotate: stamps accept_fit per row",
      rows2[0]["accept_fit"] == 1 and rows2[1]["accept_fit"] is None, str(rows2))
check("annotate: a row with no matching item is None, not a crash",
      A.annotate([{"itemId": "missing", "candidates": ["a"]}], {}, S)[0]["accept_fit"]
      is None)

# ---- 7. normalization matches the metrics (or the two are incomparable) ----
A.record("dev", "n1", "  Hustle!  ", "accept")
check("normalize: judgements are stored normalized, like metrics.normalize",
      "hustle" in A.load("dev")["n1"]["accept"], str(A.load("dev")["n1"]))
check("normalize: a differently-cased candidate still matches",
      A.accept_score(item("n1"), ["HUSTLE"], A.load("dev")) == 1)

bad = False
try:
    A.record("dev", "i", "w", "maybe")
except ValueError:
    bad = True
check("record: an unknown verdict raises rather than being stored", bad)

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
