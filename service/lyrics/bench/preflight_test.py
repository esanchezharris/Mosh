#!/usr/bin/env python3
"""Golden tests for the sitting preflight (FMS lyrics-bench I2b).

Every validity bug in this program so far was found by a human LOOKING at the
output — never by the 245 unit tests, because those all ran on synthetic
fixtures and checked mechanisms in isolation. The preflight checks the REAL
artifact just before it costs someone 45 minutes:

  1. one-song collapse  (sitting 1: all 64 pairs from one 2000-era track)
  2. era front-loading  (ids are chronological; a prefix draw skews old)
  3. degenerate labels  (94% one-sided ⇒ no metric can be elected)
  4. undiscriminating   (columns agree everywhere ⇒ labels can't separate them)
  5. thin context       (owner could not judge flow from 3 bars)

Run:  python3 service/lyrics/bench/preflight_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import preflight  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def pair(i, song, ctx=12):
    return {"pairId": f"p{i}", "granularity": "line" if i % 2 else "span",
            "arm": "arm-a", "left": "l", "right": "r",
            "before": ["b"] * ctx, "after": ["a"] * 2}


def key_of(pairs, songs, kinds=None):
    return {p["pairId"]: {"kind": (kinds or {}).get(p["pairId"], "vs_arm"),
                          "itemId": f"v1:line:{songs[n]}:s0:l1",
                          "granularity": p["granularity"],
                          "arms": ["arm-a", "arm-b"], "optionArm": "arm-a"}
            for n, p in enumerate(pairs)}


# ---- healthy sitting passes ----
songs = [f"gd:{1000 + n}" for n in range(40)]
pairs = [pair(i, songs[i]) for i in range(40)]
cols = {"judge_win": {f"p{i}": i % 2 for i in range(40)},
        "emb": {f"p{i}": (i // 2) % 2 for i in range(40)}}
rep = preflight.check_sitting(pairs, key_of(pairs, songs), cols)
check("healthy sitting: no blockers", rep["blockers"] == [], str(rep["blockers"]))
check("healthy sitting: reports distinct songs", rep["stats"]["distinctSongs"] == 40)

# ---- 1. one-song collapse is a BLOCKER ----
one = [pair(i, "gd:0001") for i in range(40)]
rep1 = preflight.check_sitting(one, key_of(one, ["gd:0001"] * 40), cols)
check("one-song collapse blocks the sitting",
      any("song" in b.lower() for b in rep1["blockers"]), str(rep1["blockers"]))

# ---- 2. era front-loading warns (needs the corpus id range as reference:
# ids 0-39 are only "the oldest" relative to a corpus that reaches much higher)
old = [f"gd:{n}" for n in range(40)]
pairs_old = [pair(i, old[i]) for i in range(40)]
rep2 = preflight.check_sitting(pairs_old, key_of(pairs_old, old), cols,
                               corpus_id_range=(0, 8_000_000))
check("era front-loading is flagged against the corpus range",
      any("era" in w.lower() or "old" in w.lower()
          for w in rep2["warnings"] + rep2["blockers"]),
      str(rep2["warnings"]))
check("a spread-out draw over the same corpus does NOT warn",
      not any("era" in w.lower() for w in preflight.check_sitting(
          pairs, key_of(pairs, [f"gd:{n * 200_000}" for n in range(40)]), cols,
          corpus_id_range=(0, 8_000_000))["warnings"]))
check("no corpus range given → the era check is skipped, not guessed",
      not any("era" in w.lower() for w in
              preflight.check_sitting(pairs_old, key_of(pairs_old, old),
                                      cols)["warnings"]))

# ---- 3. undiscriminating columns block ----
same = {"judge_win": {f"p{i}": 1 for i in range(40)},
        "emb": {f"p{i}": 1 for i in range(40)}}
rep3 = preflight.check_sitting(pairs, key_of(pairs, songs), same)
check("columns that never disagree block the sitting",
      any("disagree" in b.lower() or "discriminat" in b.lower()
          for b in rep3["blockers"]), str(rep3["blockers"]))
check("a constant column is named outright",
      any("constant" in x.lower() for x in rep3["blockers"] + rep3["warnings"]),
      str(rep3["blockers"] + rep3["warnings"]))

# ---- 4. one-sided expected labels warn (vs_truth-only sittings) ----
truth_only = {p["pairId"]: "vs_truth" for p in pairs}
rep4 = preflight.check_sitting(pairs, key_of(pairs, songs, truth_only), cols)
check("an all-vs-truth sitting warns about label skew",
      any("skew" in w.lower() or "one-sided" in w.lower() or "balance" in w.lower()
          for w in rep4["warnings"]), str(rep4["warnings"]))

# ---- 5. thin context warns ----
thin = [pair(i, songs[i], ctx=1) for i in range(40)]
rep5 = preflight.check_sitting(thin, key_of(thin, songs), cols)
check("thin flow context is flagged",
      any("context" in w.lower() for w in rep5["warnings"] + rep5["blockers"]),
      str(rep5["warnings"]))

# ---- efficiency accounting ----
check("reports how many pairs actually discriminate",
      0 < rep["stats"]["discriminatingPairs"] <= len(pairs),
      str(rep["stats"].get("discriminatingPairs")))
check("estimates the minutes being asked of the owner",
      rep["stats"]["estMinutes"] > 0, str(rep["stats"].get("estMinutes")))
check("render is deterministic and mentions blockers",
      preflight.render(rep1) == preflight.render(rep1)
      and "BLOCK" in preflight.render(rep1).upper())

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
