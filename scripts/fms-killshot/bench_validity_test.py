#!/usr/bin/env python3
"""Golden tests for the metric-validity gate (injected score_vocal → no audio/venvs).

Run:  python3 scripts/fms-killshot/bench_validity_test.py   (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_validity as bv  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def fake_score(ref, gen, **kw):
    good = gen.endswith("good.wav")
    return {"correctness": {"onsets": {"f1": 0.9 if good else 0.4},
                            "f0": {"abs_median_st": 0.3 if good else 3.0}},
            "naturalness": {"pq": 6.5 if good else 4.0, "singmos": 4.1 if good else 2.0}}


v = bv.validity_verdict("ref.wav", "good.wav", "bad.wav", deps={"score_vocal": fake_score})
check("gate PASSES when good beats bad on both axes", v["pass"] is True, str(v["ranks"]))
check("verdict records per-axis ranks", v["ranks"]["correctness_ok"] and v["ranks"]["naturalness_ok"])

v2 = bv.validity_verdict("ref.wav", "bad.wav", "good.wav", deps={"score_vocal": fake_score})
check("gate FAILS when 'good' is actually worse", v2["pass"] is False, str(v2["ranks"]))

# a naturalness-blind run (venvs absent → both None) gates on correctness ALONE — the gate
# must not FAIL just because pq/singmos aren't installed (the local reality).
def corr_only(ref, gen, **kw):
    good = gen.endswith("good.wav")
    return {"correctness": {"onsets": {"f1": 0.9 if good else 0.4}}, "naturalness": {"pq": None, "singmos": None}}


v3 = bv.validity_verdict("ref.wav", "good.wav", "bad.wav", deps={"score_vocal": corr_only})
check("naturalness absent -> gate passes on correctness alone", v3["pass"] is True, str(v3["ranks"]))
check("verdict flags naturalness not evaluated", v3["naturalness_evaluated"] is False)
check("correctness still ranked good", v3["ranks"]["correctness_ok"] is True)

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
