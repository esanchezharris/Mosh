#!/usr/bin/env python3
"""Golden test for the forced-alignment ruler's pure aggregation (no venv/model)."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_align as ba  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


pw = [{"word": "a", "score": 0.9}, {"word": "b", "score": 0.2}, {"word": "c", "score": 0.5}]
agg = ba.aggregate_alignment(pw)
check("mean score", abs(agg["mean_score"] - 0.533) < 1e-3, str(agg))
check("hit_frac at 0.3 default (2 of 3 > 0.3)", agg["hit_frac"] == round(2 / 3, 3), str(agg))
check("n counts words", agg["n"] == 3)
check("empty → None/0", ba.aggregate_alignment([]) == {"mean_score": None, "hit_frac": None, "n": 0})
check("custom hit threshold", ba.aggregate_alignment(pw, hit=0.6)["hit_frac"] == round(1 / 3, 3))
check("skips scoreless entries", ba.aggregate_alignment([{"word": "x"}, {"word": "a", "score": 0.8}])["n"] == 1)

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
