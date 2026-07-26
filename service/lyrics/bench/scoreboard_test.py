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
# A decoy field proves the renderer surfaces only its whitelisted fields — the
# old check ("basement" absent) could never fail because the input contained no
# corpus text at all (review finding #11).
decoy = [dict(ENTRIES[0])]
decoy[0]["summary"] = {**decoy[0]["summary"],
                       "leakedLyric": "counting up the basement rent decoy"}
check("renderer never surfaces unknown fields (decoy lyric stays out)",
      "basement" not in scoreboard.render(decoy, trusted=None).lower())
check("deterministic render", all(scoreboard.render(ENTRIES, trusted=None) == md
                                  for _ in range(3)))
md_cal = scoreboard.render(ENTRIES, trusted={"word": {"metric": "constrained_fit",
                                                      "agreement": 0.78}})
check("trusted metric named once calibrated",
      "UNCALIBRATED" not in md_cal and "constrained_fit" in md_cal
      and "0.78" in md_cal)

# ---- I3a: multi_depth column + the low-fame headline --------------------------
FAME_ENTRY = [{"slice": "dev", "runDir": "r1", "summary": {
    "arm": {"name": "prompt-rhyme-menu"}, "emptyCandidates": 0,
    "metrics": {"rhyme": {"n": 100, "exact": 0.50, "multi_depth": 1.8}},
    "metricsByFame": {
        "low": {"rhyme": {"n": 60, "exact": 0.30, "multi_depth": 1.9}},
        "high": {"rhyme": {"n": 40, "exact": 0.80, "multi_depth": 1.6}}}}}]
md_f = scoreboard.render(FAME_ENTRY, trusted=None)
check("scoreboard: multi_depth is a column, not buried in the per-run json",
      "multi_depth" in md_f, md_f[:300])
check("scoreboard: multi_depth value shown as a depth, not a percentage",
      "1.9" in md_f or "1.8" in md_f, md_f)
check("scoreboard: the LOW-fame bucket is reported",
      "low-fame" in md_f.lower(), md_f)
check("scoreboard: the high-fame bucket is shown too, not hidden",
      "high-fame" in md_f.lower())
check("scoreboard: the memorization gap is stated, not left to the reader",
      "memoriz" in md_f.lower(), md_f)
check("scoreboard: an entry without a fame split still renders",
      "rhyme" in scoreboard.render(ENTRIES, trusted=None))
check("scoreboard: fame render deterministic",
      all(scoreboard.render(FAME_ENTRY, trusted=None) == md_f for _ in range(3)))

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
