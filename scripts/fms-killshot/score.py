#!/usr/bin/env python3
"""KS-B scoring: diagnostic.json + ground truth -> per-bar error metrics.

Ground truth JSON, one of two shapes:
  {"bars": {"0": 4, "1": 7, ...}}                                  # ear-counted syllables
  {"phrases": [{"bar": 0, "plain": "late night pressure ..."}]}    # known lyrics per bar
                                                                    # (syllables via phonology)

Usage:  score.py --diagnostic outdir/diagnostic.json --truth truth.json
Emits metrics JSON to stdout and a human table to stderr.
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))


def _truth_counts(truth: dict) -> dict[int, int]:
    if "bars" in truth:
        return {int(k): int(v) for k, v in truth["bars"].items()}
    from phonology import core as ph  # lazy: only the phrase shape needs it
    pr = ph.Pronouncer()
    out: dict[int, int] = {}
    for p in truth.get("phrases", []):
        words = [w for w in str(p.get("plain", "")).split() if any(c.isalpha() for c in w)]
        out[int(p["bar"])] = sum(pr.syllables(w.strip(".,!?'\"-").lower()) or 1 for w in words)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--diagnostic", required=True)
    ap.add_argument("--truth", required=True)
    args = ap.parse_args()

    diag = json.load(open(args.diagnostic))
    truth = _truth_counts(json.load(open(args.truth)))
    got = {b["bar"]: b for b in diag["bars"]}

    rows, errs = [], []
    for bar in sorted(set(truth) | set(got)):
        t = truth.get(bar)
        g = got.get(bar, {}).get("syllableTarget", 0)
        row = {"bar": bar, "truth": t, "detected": g,
               "err": (g - t) if t is not None else None,
               "clamped": got.get(bar, {}).get("clamped", False)}
        rows.append(row)
        if row["err"] is not None:
            errs.append(abs(row["err"]))

    metrics = {
        "input": diag.get("input"),
        "bars_scored": len(errs),
        "median_abs_err": statistics.median(errs) if errs else None,
        "mean_abs_err": round(sum(errs) / len(errs), 3) if errs else None,
        "max_abs_err": max(errs) if errs else None,
        "bars_within_tol1": sum(1 for e in errs if e <= 1),
        "pct_within_tol1": round(100.0 * sum(1 for e in errs if e <= 1) / len(errs), 1) if errs else None,
        "splits_total": diag.get("splits_total"),
        "f0_backend": (diag.get("f0_stats") or {}).get("backend"),
        "rows": rows,
    }
    print(json.dumps(metrics, indent=1))
    for r in rows:
        print(f"  bar {r['bar']:>2}: truth={r['truth']!s:>4} detected={r['detected']:>2} "
              f"err={r['err']!s:>4}{' CLAMPED' if r['clamped'] else ''}", file=sys.stderr)
    ok = metrics["median_abs_err"] is not None and metrics["median_abs_err"] <= 1
    print(f"  median|err|={metrics['median_abs_err']} -> {'PASS' if ok else 'FAIL'} (bar: <=1)",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
