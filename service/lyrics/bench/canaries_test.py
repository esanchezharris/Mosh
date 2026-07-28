#!/usr/bin/env python3
"""Golden tests for the metric canaries (FMS WS1 / M5).

Two directions, and both are needed. The canaries must FIRE against a broken
metric (or they are decoration), and they must STAY SILENT against the real one
(or they are noise nobody will keep running). A suite that only proves the second
is the vacuous half.

Run:  python3 service/lyrics/bench/canaries_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import canaries, metrics  # noqa: E402
from lyrics.bench._testlex import make_pron  # noqa: E402

PRON = make_pron()
fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def item(n=0):
    return {"itemId": f"v2:rhyme:gs:{n}:s0:l0", "granularity": "rhyme", "split": "dev",
            "songId": f"gs:{n}", "views": 10,
            "target": {"text": "grind", "syllables": 1, "stress": "X"},
            "context": {"before": ["they said i would not make it out the cold"],
                        "maskedLine": "i came up from the ____", "after": []},
            "constraints": {"syllables": 1, "syllableTol": 0, "rhymeWith": "mind",
                            "rhymeStrictness": "slant"}}


ITEMS = [item(i) for i in range(3)]

# ---- 1. the real metrics pass the canary suite ----
rep = canaries.run_canaries(ITEMS, PRON)
check("canaries: the shipped metrics survive the suite", rep["ok"],
      str(rep["violations"][:2]))
check("canaries: the suite actually asserted something",
      rep["assertionsChecked"] >= 12, str(rep["assertionsChecked"]))
check("canaries: a positive control is included (not all-reject)",
      any(c["id"] == "truth-positive-control" for c in canaries.canary_fills(item())))

# ---- 2. they FIRE against broken metrics (the half that makes them real) ----
_real_score = metrics.score_item


def _always_pass(it, cands, pron):
    row = _real_score(it, cands, pron)
    return {**row, "syl_fit": 1, "rhyme_fit": 1, "exact": 1}


metrics.score_item = _always_pass
try:
    broken = canaries.run_canaries(ITEMS, PRON)
finally:
    metrics.score_item = _real_score
check("canaries: a metric that passes everything is caught", not broken["ok"],
      f"{len(broken['violations'])} violations")
check("canaries: the violation names the metric and the canary",
      broken["violations"] and {"canary", "metric", "why"} <= set(broken["violations"][0]),
      str(broken["violations"][0]) if broken["violations"] else "none")
kinds = {v["canary"] for v in broken["violations"]}
check("canaries: repeated-token, syllable-violator and off-menu all fire",
      {"repeated-token", "syllable-violator", "off-menu"} <= kinds, str(sorted(kinds)))


def _always_fail(it, cands, pron):
    row = _real_score(it, cands, pron)
    return {**row, "syl_fit": 0, "rhyme_fit": 0, "exact": 0}


metrics.score_item = _always_fail
try:
    dead = canaries.run_canaries(ITEMS, PRON)
finally:
    metrics.score_item = _real_score
check("canaries: a metric that REJECTS everything is caught by the positive control",
      not dead["ok"] and any(v["canary"] == "truth-positive-control"
                             for v in dead["violations"]),
      str({v["canary"] for v in dead["violations"]}))

# ---- 3. the subtle canary is documented as NOT caught by any metric ----
pe = [c for c in canaries.canary_fills(item()) if c["id"] == "perfect-but-empty"][0]
row = metrics.score_item(item(), [pe["fill"]], PRON)
check("perfect-but-empty: it does rhyme perfectly (so no rhyme metric objects)",
      row.get("rhyme_fit") == 1, str(row.get("rhyme_fit")))
check("perfect-but-empty: and it is NOT the artist's word", row.get("exact") == 0)
check("perfect-but-empty: the canary records that this is the uncaught failure",
      "not quality" in pe["why"])

# ---- 3b. the off-menu canary is VERIFIED, not guessed ----
# The suite's default partner ("mind") does not rhyme with the first pool word, so
# a guessing implementation looks identical there — it passed a sabotage that
# skipped the check entirely. This uses a lexicon where the FIRST pool word DOES
# rhyme with the partner, so an unverified pick would be wrong.
from phonology.core import Pronouncer  # noqa: E402

# `lozenge` is given a rime IDENTICAL to `orange`'s so the two genuinely rhyme in
# this fixture. Real English has no rhyme for orange, which is exactly why the
# default suite could not exhibit this case.
_RHYMES_ORANGE = {"orange": [["AO1", "R", "AH0", "N", "JH"]],
                  "lozenge": [["L", "AO1", "R", "AH0", "N", "JH"]],
                  "silver": [["S", "IH1", "L", "V", "ER0"]]}
_op = Pronouncer(lexicon=_RHYMES_ORANGE, g2p=lambda w: None)
check("off-menu fixture: the FIRST pool word really does rhyme with this partner",
      _op.rhyme(canaries._NON_RHYME_POOL[0], "lozenge", "slant"),
      f"{canaries._NON_RHYME_POOL[0]} vs lozenge")
_picked = canaries._non_rhyme_for("lozenge", "slant", _op)
check("off-menu: a rhyming candidate is SKIPPED, not returned",
      _picked != canaries._NON_RHYME_POOL[0], str(_picked))
check("off-menu: whatever is returned genuinely does not rhyme",
      _picked is None or not _op.rhyme(_picked, "lozenge", "slant"), str(_picked))
check("off-menu: no verifiable candidate ⇒ None, never a fabricated one",
      canaries._non_rhyme_for("lozenge", "slant", None) is None)

# ---- 4. canaries derive from the item, not from a frozen word list ----
alt = item(9)
alt["constraints"]["rhymeWith"] = "gold"
alt["target"]["text"] = "cold"
a = {c["id"]: c["fill"] for c in canaries.canary_fills(alt)}
b = {c["id"]: c["fill"] for c in canaries.canary_fills(item())}
check("canaries: the off-menu and truth fills move with the item",
      a["perfect-but-empty"] != b["perfect-but-empty"]
      and a["truth-positive-control"] != b["truth-positive-control"],
      f"{a['perfect-but-empty']} vs {b['perfect-but-empty']}")
check("canaries: an item with no rhyme partner still yields canaries",
      len(canaries.canary_fills({"constraints": {}, "target": {}, "context": {}})) >= 3)

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
