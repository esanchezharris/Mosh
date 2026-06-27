#!/usr/bin/env python3
"""Golden tests for lyric ANALYSIS (Finish-My-Song §4, L1 — the flow visualizer feed).

`analyze(spec)` returns precise per-line phonology — syllable count, the stress contour,
the rhyme grade vs the line's rhyme-group anchor, and per-word slots — so the UI can draw
a flow visualizer that AGREES with the generation gate (it reuses the same _evaluate()).
This is the precise dictionary path, beyond the UI's instant vowel-group estimate.

Deterministic + hermetic: structural/syllable checks use whatever lexicon is present
(cmudict if importable, else the stdlib heuristic — both deterministic); the stress /
dict-confidence / rhyme-grade checks pin a small fixed ARPAbet lexicon so they pass
identically on any machine. Stdlib + the phonology core only — no network, no LLM.

Run:  python3 service/lyrics/analyze_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from lyrics import core  # noqa: E402
from phonology import core as phon  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# ── A "comeback" hook: group A anchored by the fixed end word "flame". ────────────
SPEC = {
    "grid": "1/16", "topic": "comeback", "mood": "defiant", "rhymeStrictness": "slant",
    "lines": [
        {"index": 0, "role": "hook", "seedText": "", "text": "lighting up the flame",
         "syllableTarget": 5, "syllableTol": 1, "rhymeGroup": "A", "locked": False},
        {"index": 1, "role": "verse", "seedText": "", "text": "rising up with name",
         "syllableTarget": 5, "syllableTol": 1, "rhymeGroup": "A", "locked": False},
        {"index": 2, "role": "verse", "seedText": "", "text": "",
         "syllableTarget": 8, "syllableTol": 1, "rhymeGroup": "A", "locked": False},
        {"index": 3, "role": "verse", "seedText": "table ___ ___", "text": "",
         "syllableTarget": 8, "syllableTol": 1, "rhymeGroup": "B", "locked": False},
    ],
}


def by_index(res):
    return {l["index"]: l["analysis"] for l in res["lines"]}


# ── 1. analyze() returns exactly one analysis per line, ok ────────────────────────
res = core.analyze(SPEC)
check("analyze ok", res.get("ok") is True)
a = by_index(res)
check("one analysis per line (incl. empty + gapped)", sorted(a) == [0, 1, 2, 3])

# ── 2. A finalized line reports its syllable count + target + completeness ─────────
check("line 0 reports syllables", isinstance(a[0]["syllables"], int) and a[0]["syllables"] > 0)
check("line 0 carries the effective target", a[0]["target"] == 5)
check("line 0 is analyzed from its finalized text", a[0]["analyzed"] == "text")
check("line 0 is complete (text, no gaps)", a[0]["complete"] is True)

# ── 3. The empty line is honestly 'incomplete', not a hard fail ───────────────────
check("line 2 (empty) analyzed=empty", a[2]["analyzed"] == "empty")
check("line 2 (empty) complete=false", a[2]["complete"] is False)
check("line 2 (empty) endWord blank", a[2]["endWord"] == "")

# ── 4. A gapped seed is analyzed over its written words + flagged as having gaps ──
check("line 3 (gapped seed) analyzed=seed", a[3]["analyzed"] == "seed")
check("line 3 reports hasGap", a[3]["hasGap"] is True)
check("line 3 complete=false (gaps remain)", a[3]["complete"] is False)

# ── 5. Per-line analysis AGREES with the generation gate (_evaluate reuse) ────────
# Line 1 must rhyme to the group-A anchor 'flame'; analysis must mark rhymeGrade/ok.
check("line 1 anchor is the group's fixed end 'flame'", a[1]["rhymeAnchor"] == "flame")
check("line 0 (the anchor line) grade=anchor", a[0]["rhymeGrade"] == "anchor")

# ── 6. Determinism: identical spec → identical analysis ───────────────────────────
check("analyze is deterministic", core.analyze(SPEC)["lines"] == core.analyze(SPEC)["lines"])

# ── 7. Precise stress / dict-confidence / rhyme-grade — pin a fixed lexicon ───────
# So these assertions are identical with or without cmudict installed.
LEX = {
    "flame": [["F", "L", "EY1", "M"]],          # 1 syl, stress "X"
    "name":  [["N", "EY1", "M"]],               # 1 syl, perfect rhyme w/ flame
    "table": [["T", "EY1", "B", "AH0", "L"]],   # 2 syl, stress "Xx"
    "again": [["AH0", "G", "EH1", "N"]],        # 2 syl, stress "xX"
}
_saved = core._P
try:
    core._P = phon.Pronouncer(LEX)
    res2 = core.analyze({
        "grid": "1/16", "rhymeStrictness": "perfect",
        "lines": [
            {"index": 0, "role": "hook", "text": "flame", "seedText": "",
             "syllableTarget": 1, "syllableTol": 0, "rhymeGroup": "A", "locked": False},
            {"index": 1, "role": "verse", "text": "name", "seedText": "",
             "syllableTarget": 1, "syllableTol": 0, "rhymeGroup": "A", "locked": False},
            {"index": 2, "role": "verse", "text": "table again", "seedText": "",
             "syllableTarget": 4, "syllableTol": 0, "rhymeGroup": "C", "locked": False},
        ],
    })
    a2 = by_index(res2)
    check("'name' is a perfect rhyme with the 'flame' anchor",
          a2[1]["rhymeGrade"] == "perfect" and a2[1]["rhymeOk"] is True, str(a2[1]))
    check("end word 'flame' is reported in-dictionary", a2[0]["endInDict"] is True)
    check("stress contour of 'table again' is 'Xxx X' per-word → 'XxxX'",
          a2[2]["stress"] == "XxxX", a2[2]["stress"])
    check("per-word slots carry syllables + stress + inDict",
          a2[2]["words"] == [{"w": "table", "syllables": 2, "stress": "Xx", "inDict": True},
                             {"w": "again", "syllables": 2, "stress": "xX", "inDict": True}],
          str(a2[2]["words"]))
    check("'table again' = 4 syllables hits target 4 exactly → syllableOk",
          a2[2]["syllables"] == 4 and a2[2]["syllableOk"] is True)
finally:
    core._P = _saved

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failure(s)")
sys.exit(len(fails))
