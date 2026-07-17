#!/usr/bin/env python3
"""Metric-validity gate: does score_vocal rank a known-GOOD render above a known-BAD one?

This is the ruler-check that earns the benchmark the right to gate real pipeline changes
(the V3 lesson: a metric that anti-correlates with the ear is worse than none). The gate
requires the correctness axis to rank good over bad; naturalness is required too WHEN it was
actually measured, but a naturalness axis with no comparable data (judges/singmos venvs
absent) does not FAIL the gate — it is flagged "not evaluated" and the gate stands on
correctness alone.

Usage:  bench_validity.py --reference R.wav --good G.wav --bad B.wav [--out DIR]
Exit 0 = pass, 1 = fail.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_metrics as bm  # noqa: E402


def validity_verdict(reference, good, bad, *, deps=None):
    score = (deps or {}).get("score_vocal")
    if score is None:
        import bench_score
        score = bench_score.score_vocal
    g = score(reference, good)
    b = score(reference, bad)
    r = bm.ranks(g, b)
    nat_evaluated = any(v != "tie" for v in r["detail"].get("naturalness", {}).values())
    passed = bool(r["correctness_ok"] and (r["naturalness_ok"] or not nat_evaluated))
    return {"ranks": r, "naturalness_evaluated": nat_evaluated,
            "pass": passed, "good": g, "bad": b}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", required=True)
    ap.add_argument("--good", required=True)
    ap.add_argument("--bad", required=True)
    ap.add_argument("--out")
    a = ap.parse_args()
    v = validity_verdict(a.reference, a.good, a.bad)
    print(json.dumps(v, indent=1, sort_keys=True))
    if a.out:
        os.makedirs(a.out, exist_ok=True)
        with open(os.path.join(a.out, "validity.json"), "w") as f:
            json.dump(v, f, indent=1, sort_keys=True)
    return 0 if v["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
