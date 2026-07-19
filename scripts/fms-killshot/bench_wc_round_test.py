#!/usr/bin/env python3
"""Goldens for the word-campaign round driver's pure cores (verdict rule, defect count,
floor-leak scan).  Run:  python3 scripts/fms-killshot/bench_wc_round_test.py"""
import hashlib
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_wc_round as wcr  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


BASE = {"wordDefects": 10, "within1": 0.80, "rhythmMs": 50.0, "floorLeaks": 0}

v = wcr.round_verdict({"wordDefects": 8, "within1": 0.78, "rhythmMs": 52.0, "floorLeaks": 0}, BASE)
check("keep: defects down, guards within band", v["keep"] is True, v["why"])

v = wcr.round_verdict({"wordDefects": 10, "within1": 0.85, "rhythmMs": 40.0, "floorLeaks": 0}, BASE)
check("revert: defects not strictly down (equal)", v["keep"] is False, v["why"])

v = wcr.round_verdict({"wordDefects": 5, "within1": 0.71, "rhythmMs": 50.0, "floorLeaks": 0}, BASE)
check("revert: within-1st breached (>10% relative drop)", v["keep"] is False, v["why"])

v = wcr.round_verdict({"wordDefects": 5, "within1": 0.73, "rhythmMs": 50.0, "floorLeaks": 0}, BASE)
check("keep: within-1st just inside the band (0.73 >= 0.72)", v["keep"] is True, v["why"])

v = wcr.round_verdict({"wordDefects": 5, "within1": 0.80, "rhythmMs": 56.0, "floorLeaks": 0}, BASE)
check("revert: rhythm breached (56 > 55)", v["keep"] is False, v["why"])

v = wcr.round_verdict({"wordDefects": 5, "within1": 0.80, "rhythmMs": 50.0, "floorLeaks": 2}, BASE)
check("revert: any floor leak is fatal", v["keep"] is False and "floorLeaks" in v["why"])

v = wcr.round_verdict({"wordDefects": 12, "within1": 0.7, "rhythmMs": 90.0, "floorLeaks": 0}, None)
check("baseline round: verdict None", v["keep"] is None)

GATE = {"songs": {"a": {"missing": [{"word": "x"}], "sylDeficits": [{"lyricWords": ["y"]}]},
                  "b": {"missing": [], "sylDeficits": []},
                  "c": {"error": "boom"}}}
check("word_defects counts missing + deficits, skips errors", wcr.word_defects(GATE) == 2)

with tempfile.TemporaryDirectory() as td:
    clip = {"duration": "0.30 0.05 0.1499 0.20 0.1233", "note_type": "1 1 2 2 3"}
    json.dump([clip], open(os.path.join(td, "s_pipeline_score.json"), "w"))
    n = wcr.floor_leaks(td)
    check("floor_leaks: rests exempt, 0.1499 within tolerance, 0.1233 leaks", n == 1, str(n))

det = {hashlib.sha256(json.dumps(wcr.round_verdict(
    {"wordDefects": 8, "within1": 0.78, "rhythmMs": 52.0, "floorLeaks": 0}, BASE),
    sort_keys=True).encode()).hexdigest() for _ in range(3)}
check("verdict deterministic (3x)", len(det) == 1)

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
