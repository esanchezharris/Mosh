#!/usr/bin/env python3
"""Golden tests for the pure metric aggregation + good-vs-bad ranking (no audio, no venvs).

Run:  python3 scripts/fms-killshot/bench_metrics_test.py   (exit 0 = all pass)
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_metrics as bm  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


GOOD = {"correctness": {"onsets": {"f1": 0.9}, "f0": {"abs_median_st": 0.3},
                        "energy": {"render_in_take_silence_pct": 5.0}},
        "naturalness": {"pq": 6.5, "singmos": 4.1}}
BAD = {"correctness": {"onsets": {"f1": 0.4}, "f0": {"abs_median_st": 3.0},
                       "energy": {"render_in_take_silence_pct": 40.0}},
       "naturalness": {"pq": 4.0, "singmos": 2.2}}

check("polarity: f1 higher-better", bm.POLARITY["f1"] == "hi")
check("polarity: abs_median_st lower-better", bm.POLARITY["abs_median_st"] == "lo")

agg = bm.aggregate([GOOD, BAD])
check("aggregate counts items", agg["n"] == 2)
check("aggregate means pq", abs(agg["naturalness"]["pq"] - 5.25) < 1e-9, str(agg["naturalness"]))
check("aggregate skips None",
      bm.aggregate([{"naturalness": {"pq": None}}, {"naturalness": {"pq": 4.0}}])["naturalness"]["pq"] == 4.0)

r = bm.ranks(GOOD, BAD)
check("good beats bad on correctness", r["correctness_ok"] is True)
check("good beats bad on naturalness", r["naturalness_ok"] is True)
check("ranks is symmetric-false", bm.ranks(BAD, GOOD)["correctness_ok"] is False)

det = {hashlib.sha256(json.dumps(bm.ranks(GOOD, BAD), sort_keys=True).encode()).hexdigest() for _ in range(3)}
check("ranks deterministic (3x)", len(det) == 1)

# ── human_band: the absolute scale from the real (mumble → finished) pairs ──────────────
b = bm.human_band([0.55, 0.69, 0.61])
check("human_band lo/hi", b["lo"] == 0.55 and b["hi"] == 0.69)
check("human_band mean", abs(b["mean"] - 0.6167) < 1e-3, str(b["mean"]))
check("human_band spread drives the tight-vs-per-song verdict", abs(b["spread"] - 0.14) < 1e-9)
check("human_band counts contributors", b["n"] == 3)
check("human_band skips None (a metric can be unavailable)",
      bm.human_band([0.5, None, 0.7]) == {"lo": 0.5, "hi": 0.7, "mean": 0.6, "spread": 0.2, "n": 2})
check("human_band on nothing is honest, not zero",
      bm.human_band([None]) == {"lo": None, "hi": None, "mean": None, "spread": None, "n": 0})
check("human_band single value has zero spread", bm.human_band([0.42])["spread"] == 0.0)

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
