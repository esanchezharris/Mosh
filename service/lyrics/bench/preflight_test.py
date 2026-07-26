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
    # Named songs are the I2c default: a sitting where the rater cannot play a
    # single track is itself a blocker now, so the healthy fixture carries
    # identity on all but a control slice.
    p = {"pairId": f"p{i}", "granularity": "line" if i % 2 else "span",
         "arm": "arm-a", "left": "l", "right": "r",
         "before": ["b"] * ctx, "after": ["a"] * 2}
    if i % 5 == 0:
        p["identityHidden"] = True
    else:
        p.update({"artist": f"Artist {i}", "title": f"Song {i}",
                  "section": "Verse 1", "listenUrl": "https://example.test/x"})
    return p


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

# ---- I2c: the checks that would have caught the first un-blinded mint --------
# That mint passed every existing check and was still unusable: 22 songs the
# owner had never heard of (so he could not play any of them), and zero
# anchor-stratum vs_truth pairs (so the ceiling had a sample size of nothing).


def ident_pairs(n_shown, n_hidden, anchor_truth=4):
    ps, k = [], {}
    for i in range(n_shown + n_hidden):
        pid = f"p{i}"
        hidden = i >= n_shown
        kind = "vs_truth" if i < anchor_truth else "vs_arm"
        p = {"pairId": pid, "granularity": "line", "arm": "arm-a",
             "left": "l", "right": "r", "before": ["b"] * 8, "after": ["a"] * 8}
        if hidden:
            p["identityHidden"] = True
        else:
            p.update({"artist": "A", "title": "T", "section": "Verse 1",
                      "listenUrl": "https://example.test/x"})
        ps.append(p)
        k[pid] = {"kind": kind, "itemId": f"v1:line:gs:{i:03}:s0:l2",
                  "granularity": "line", "arm": "arm-a", "truthSide": "left",
                  "identityHidden": hidden,
                  "selection": "anchor" if i < anchor_truth else "disagreement"}
    return ps, k


ok_p, ok_k = ident_pairs(24, 8)
r_ok = preflight.check_sitting(ok_p, ok_k)
check("a healthy un-blinded sitting still passes", not r_ok["blockers"],
      str(r_ok["blockers"]))
check("preflight reports the shown/hidden split",
      r_ok["stats"]["identityShown"] == 24
      and r_ok["stats"]["identityHidden"] == 8, str(r_ok["stats"]))

blind_p, blind_k = ident_pairs(0, 32)
check("BLOCKER when no pair names its song — the owner can play nothing",
      any("play" in b or "identity" in b
          for b in preflight.check_sitting(blind_p, blind_k)["blockers"]),
      str(preflight.check_sitting(blind_p, blind_k)["blockers"]))

most_p, most_k = ident_pairs(12, 20)
check("BLOCKER when the control stratum has eaten most of the sitting",
      preflight.check_sitting(most_p, most_k)["blockers"],
      str(preflight.check_sitting(most_p, most_k)["blockers"]))

thin_p, thin_k = ident_pairs(30, 2, anchor_truth=0)
r_thin = preflight.check_sitting(thin_p, thin_k)
check("warns when the anchor stratum holds too few human bars to fix a ceiling",
      any("ceiling" in w for w in r_thin["warnings"]), str(r_thin["warnings"]))
check("reports the anchor vs_truth count that the ceiling rests on",
      r_thin["stats"]["anchorTruthPairs"] == 0
      and r_ok["stats"]["anchorTruthPairs"] == 4, str(r_ok["stats"]))

check("the time estimate separates clicking from playing the tracks",
      r_ok["stats"]["estMinutes"] > 0
      and r_ok["stats"]["estMinutesIfPlayed"] > r_ok["stats"]["estMinutes"],
      str(r_ok["stats"]))
check("render surfaces the listening cost so it is not a surprise",
      "play" in preflight.render(r_ok).lower(), preflight.render(r_ok))

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
