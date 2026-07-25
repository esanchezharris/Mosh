#!/usr/bin/env python3
"""Golden tests for the scoreboard renderer (FMS lyrics-bench I1).

render() is pure: run summaries in → committed-doc markdown out. Numbers and
hashes only — never corpus text. Until calibration exists the board must SAY
it is uncalibrated (deterministic columns only).

Run:  python3 service/lyrics/bench/scoreboard_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import scoreboard  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def summ(arm, slice_, exact_word):
    return {
        "slice": slice_, "runDir": f"2026-07-24T12-00-{arm}-{slice_}",
        "summary": {
            "arm": {"name": arm, "version": "v1", "productBackend": "llm", "k": 5},
            "items": 100, "itemsSha": "ab" * 32, "emptyCandidates": 0,
            "cache": {"hits": 0, "misses": 100},
            "metrics": {
                "word": {"n": 40, "exact": exact_word, "topk": exact_word + 0.1,
                         "syl_fit": 0.9, "constrained_fit": 0.9},
                "rhyme": {"n": 30, "exact": 0.2, "topk": 0.3, "syl_fit": 0.8,
                          "rhyme_fit": 0.7, "rhyme_perfect": 0.4,
                          "multi_depth": 1.2, "constrained_fit": 0.6},
            },
        },
    }


ENTRIES = [summ("llm-zeroshot", "dev", 0.30), summ("oracle", "dev", 1.0),
           summ("llm-zeroshot", "golden", 0.25)]

md = scoreboard.render(ENTRIES, trusted=None)
check("renders one row per (arm, slice)", md.count("llm-zeroshot") >= 2
      and "oracle" in md)
check("uncalibrated banner when no trusted metrics", "UNCALIBRATED" in md)
check("dev and golden reported separately", "golden" in md and "dev" in md)
check("percentages formatted", "30.0" in md and "100.0" in md, md[:400])
check("no corpus text can leak (only summaries are rendered)",
      "basement" not in md.lower())
check("deterministic render", all(scoreboard.render(ENTRIES, trusted=None) == md
                                  for _ in range(3)))
md_cal = scoreboard.render(ENTRIES, trusted={"word": {"metric": "constrained_fit",
                                                      "agreement": 0.78}})
check("trusted metric named once calibrated",
      "UNCALIBRATED" not in md_cal and "constrained_fit" in md_cal
      and "0.78" in md_cal)

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
