#!/usr/bin/env python3
"""Golden tests for the taste probe (workshop charter 2026-07-19, week-1 Q1).

A tiny, fully deterministic logistic probe over per-render feature vectors, evaluated on a
TEMPORAL split (train on the older labels, evaluate on the newer — taste drifts; random
splits leak seed variants; charter "settled" point 1). Pure stdlib — no numpy/sklearn — so
the fit is bit-identical everywhere and the golden runs 3x identical.

The probe must be honest about degenerate data: a family with a missing class on either
side of the split reports status "insufficient_labels", never a fake AUC — that honesty IS
the week-1 deliverable given the label census.

Run:  python3 service/taste/taste_probe_test.py   (exit 0 = pass)
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from taste import probe  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# --- AUC (Mann-Whitney, tie-aware) ------------------------------------------------
check("auc perfect ranking = 1.0",
      probe.auc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0]) == 1.0)
check("auc inverted ranking = 0.0",
      probe.auc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0]) == 0.0)
check("auc all-tied scores = 0.5",
      probe.auc([0.5, 0.5, 0.5, 0.5], [1, 1, 0, 0]) == 0.5)
check("auc single-class returns None",
      probe.auc([0.5, 0.4], [1, 1]) is None)

# --- temporal split ----------------------------------------------------------------
rows = [{"ts": t, "y": y, "x": [float(t)]} for t, y in
        [(10, 1), (20, 0), (30, 1), (40, 0), (50, 1), (60, 0), (70, 1), (80, 0)]]
tr, ev = probe.temporal_split(rows, eval_frac=0.25)
check("temporal split: newest quarter goes to eval",
      [r["ts"] for r in ev] == [70, 80] and [r["ts"] for r in tr][-1] == 60)
tr2, ev2 = probe.temporal_split(list(reversed(rows)), eval_frac=0.25)
check("temporal split sorts by ts first", [r["ts"] for r in ev2] == [70, 80])

# --- logistic fit: separable data -> eval AUC 1.0 ---------------------------------
# Feature x[0] separates classes perfectly and consistently over time.
sep = []
for i in range(40):
    y = i % 2
    sep.append({"ts": 1000 + i, "y": y, "x": [3.0 + (1.0 if y else -1.0) + 0.01 * (i % 5)]})
res = probe.evaluate(sep, eval_frac=0.25)
check("separable family: status ok", res["status"] == "ok", json.dumps(res))
check("separable family: eval AUC = 1.0", res["auc"] == 1.0, str(res.get("auc")))
check("evaluate reports split sizes", res["n_train"] == 30 and res["n_eval"] == 10)

# --- uninformative feature -> AUC ~ 0.5 -------------------------------------------
flat = [{"ts": 1000 + i, "y": i % 2, "x": [1.0]} for i in range(40)]
res_flat = probe.evaluate(flat, eval_frac=0.25)
check("constant feature: AUC 0.5", res_flat["status"] == "ok" and res_flat["auc"] == 0.5,
      str(res_flat.get("auc")))

# --- degenerate labels are refused honestly ---------------------------------------
one_class = [{"ts": 1000 + i, "y": 1, "x": [float(i)]} for i in range(10)]
res_deg = probe.evaluate(one_class, eval_frac=0.25)
check("single-class archive: insufficient_labels, auc None",
      res_deg["status"] == "insufficient_labels" and res_deg["auc"] is None)

# Eval side loses a class even though train has both -> still insufficient.
skew = ([{"ts": 1000 + i, "y": i % 2, "x": [float(i % 2)]} for i in range(30)]
        + [{"ts": 2000 + i, "y": 1, "x": [1.0]} for i in range(10)])
res_skew = probe.evaluate(skew, eval_frac=0.25)
check("class missing on eval side: insufficient_labels",
      res_skew["status"] == "insufficient_labels")

check("empty rows: no_labels", probe.evaluate([], eval_frac=0.25)["status"] == "no_labels")

# --- determinism: 3 identical fits ------------------------------------------------
runs = [json.dumps(probe.evaluate(sep, eval_frac=0.25), sort_keys=True) for _ in range(3)]
check("evaluate 3x bit-identical", runs[0] == runs[1] == runs[2])

# Mixed-dimension guard: rows must agree on feature length.
try:
    probe.evaluate([{"ts": 1, "y": 0, "x": [1.0]}, {"ts": 2, "y": 1, "x": [1.0, 2.0]}],
                   eval_frac=0.25)
    check("mixed feature dims rejected", False)
except ValueError:
    check("mixed feature dims rejected", True)

print()
if fails:
    print(f"FAILED: {len(fails)} — {fails}")
    sys.exit(1)
print("taste_probe_test: ALL PASS")
