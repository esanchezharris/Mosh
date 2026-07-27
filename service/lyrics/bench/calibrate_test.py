#!/usr/bin/env python3
"""Golden tests for pair minting + judge-vs-owner agreement stats (I2).

This is the module the whole program's honesty rests on: it decides which
automated metric earns the right to be optimized. So the tests check the math
against HAND-COMPUTED values, and check the minting for the two ways a blind
sitting silently goes wrong:
  - the page leaks which side is the truth (then agreement is measuring nothing);
  - the pairs are unbalanced (then one granularity/arm decides the verdict).

Run:  python3 service/lyrics/bench/calibrate_test.py     (exit 0 = all pass)
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import calibrate  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def close(a, b, tol=1e-9):
    return a is not None and abs(a - b) <= tol


# ── pair minting ────────────────────────────────────────────────────────────────
def rows_for(arm, gran, n, start=0):
    return [{"itemId": f"v1:{gran}:s{i + start}", "granularity": gran, "arm": arm,
             "truth": f"the real bar number {i + start}",
             "candidate": f"{arm} candidate number {i + start}",
             "context": {"before": ["prior bar"], "after": ["next bar"]},
             "metrics": {"emb": 0.5, "ppl": 0.2, "judge_win": 1}}
            for i in range(n)]


POOL = (rows_for("llm-constrained", "line", 20) + rows_for("product-llm", "line", 20)
        + rows_for("llm-constrained", "span", 20) + rows_for("product-llm", "span", 20))

pairs, key = calibrate.mint_pairs(POOL, n=24, dupes=4, seed=11)

check("mint: requested count honored (incl. duplicates)", len(pairs) == 24,
      str(len(pairs)))
check("mint: balanced across arm x granularity",
      len({(p["arm"], p["granularity"]) for p in pairs}) == 4
      and max(sum(1 for p in pairs if (p["arm"], p["granularity"]) == c)
              for c in {(p["arm"], p["granularity"]) for p in pairs}) <= 6,
      str(sorted((p["arm"], p["granularity"]) for p in pairs)[:4]))
check("mint: duplicate pairs repeat a pairId for self-consistency",
      len({p["pairId"] for p in pairs}) == 20
      and sum(1 for p in pairs if p.get("isDupe")) == 4,
      f"{len({p['pairId'] for p in pairs})} distinct of {len(pairs)}")

# the blindness contract
sides = {p["pairId"]: (p["left"], p["right"]) for p in pairs}
check("mint: pair carries only left/right text — no truth marker",
      all(set(p) >= {"pairId", "left", "right"} for p in pairs)
      and not any(k in p for p in pairs for k in
                  ("truth", "truthSide", "candidate", "isTruthLeft")),
      str(sorted(pairs[0].keys())))
check("blind key is a SEPARATE structure naming the truth side",
      set(key) == {p["pairId"] for p in pairs}
      and all(v["truthSide"] in ("left", "right") for v in key.values()))
check("both truth sides occur (not always left)",
      len({v["truthSide"] for v in key.values()}) == 2,
      # sorted(): a printed set orders by hash seed, which would make this
      # suite's 3x signature differ per process and hide real drift.
      str(sorted({v["truthSide"] for v in key.values()})))
check("key round-trips to the actual texts",
      all((sides[pid][0] if v["truthSide"] == "left" else sides[pid][1])
          == v["truthText"] for pid, v in key.items()))
check("mint: deterministic under the same seed",
      calibrate.mint_pairs(POOL, n=24, dupes=4, seed=11)[0] == pairs)
check("mint: a different seed changes the draw",
      calibrate.mint_pairs(POOL, n=24, dupes=4, seed=12)[0] != pairs)

# ── the rater and the judge must be shown the SAME thing ───────────────────────
# A span fill rendered bare ("real grim about my") is not judgeable; the LLM panel
# scores COMPLETED lines, so the page must too, or agreement compares two
# different tasks and means nothing.
span_pool = [{"itemId": "v1:span:x", "granularity": "span", "arm": "a",
              "truth": "counting up the", "candidate": "stacking all the",
              "maskedLine": "I was ____ ____ ____ rent, no debate",
              "context": {"before": ["prior"], "after": ["next"]}}]
span_pairs, span_key = calibrate.mint_pairs(
    calibrate.completed_pool(span_pool), n=1, dupes=0, seed=5)
p = span_pairs[0]
check("span pairs render the whole line, not the bare fill",
      "rent, no debate" in p["left"] and "rent, no debate" in p["right"],
      f"{p['left']!r} / {p['right']!r}")
check("completed_pool keeps the fills distinguishable",
      p["left"] != p["right"] and (
          "counting up the" in p["left"] or "counting up the" in p["right"]),
      f"{p['left']!r} / {p['right']!r}")
line_pool = [{"itemId": "v1:line:y", "granularity": "line", "arm": "a",
              "truth": "a whole human line", "candidate": "a whole machine line",
              "maskedLine": None, "context": {"before": ["p"], "after": ["n"]}}]
lp = calibrate.completed_pool(line_pool)[0]
check("line items pass through untouched (they are already whole lines)",
      lp["truth"] == "a whole human line"
      and lp["candidate"] == "a whole machine line", str(lp))

# ── owner-side scoring ─────────────────────────────────────────────────────────
# Owner picked the truth in 3 of 4; 'tie' is recorded but not scored as a win.
ratings = [
    {"pairId": "p1", "choice": "left"},
    {"pairId": "p2", "choice": "right"},
    {"pairId": "p3", "choice": "left"},
    {"pairId": "p4", "choice": "tie"},
]
key4 = {
    "p1": {"truthSide": "left", "truthText": "t"},    # owner chose truth  → 0
    "p2": {"truthSide": "left", "truthText": "t"},    # owner chose cand   → 1
    "p3": {"truthSide": "left", "truthText": "t"},    # owner chose truth  → 0
    "p4": {"truthSide": "right", "truthText": "t"},   # tie               → None
}
labels = calibrate.owner_labels(ratings, key4)
check("owner labels: choice resolved against the blind key",
      labels == {"p1": 0, "p2": 1, "p3": 0, "p4": None}, str(labels))

# ── self-consistency ───────────────────────────────────────────────────────────
dupe_ratings = [{"pairId": "p1", "choice": "left"}, {"pairId": "p1", "choice": "left"},
                {"pairId": "p2", "choice": "left"}, {"pairId": "p2", "choice": "right"}]
check("self-consistency: 1 of 2 repeated pairs answered the same way",
      close(calibrate.self_consistency(dupe_ratings), 0.5),
      str(calibrate.self_consistency(dupe_ratings)))

# ── agreement stats (hand-computed) ────────────────────────────────────────────
owner = {"a": 1, "b": 1, "c": 0, "d": 0, "e": None}
judge_a = {"a": 1, "b": 1, "c": 0, "d": 1, "e": 1}   # 3/4 on scored pairs
judge_b = {"a": 0, "b": 0, "c": 1, "d": 1, "e": 0}   # 0/4 — anti-correlated
agr_a = calibrate.pairwise_agreement(owner, judge_a)
check("pairwise agreement: 3 of 4 comparable pairs", close(agr_a["accuracy"], 0.75)
      and agr_a["n"] == 4, str(agr_a))
check("pairwise agreement skips pairs the owner tied", agr_a["n"] == 4)
check("anti-correlated judge scores 0.0",
      close(calibrate.pairwise_agreement(owner, judge_b)["accuracy"], 0.0))
lo, hi = agr_a["ci"]
check("Wilson CI brackets the estimate and is wide at n=4",
      lo < 0.75 < hi and (hi - lo) > 0.4, f"[{lo:.3f}, {hi:.3f}]")
check("Wilson CI at n=4, k=3 matches the closed form",
      close(lo, 0.30, 0.01) and close(hi, 0.95, 0.01), f"[{lo:.4f}, {hi:.4f}]")

# Spearman on a perfectly monotone pair = 1.0; reversed = -1.0
check("spearman: monotone = 1.0",
      close(calibrate.spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1.0))
check("spearman: reversed = -1.0",
      close(calibrate.spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1.0))
check("spearman: ties handled via average ranks",
      close(calibrate.spearman([1, 1, 2, 2], [5, 5, 9, 9]), 1.0))
check("spearman: too few points → None", calibrate.spearman([1], [2]) is None)

# Cohen's kappa: 2 raters, 4 items, 3 agreements, chance-corrected
k = calibrate.cohens_kappa([1, 1, 0, 0], [1, 1, 0, 1])
check("cohens kappa: hand-computed 0.5", close(k, 0.5, 1e-6), str(k))
check("cohens kappa: perfect agreement = 1.0",
      close(calibrate.cohens_kappa([1, 0, 1, 0], [1, 0, 1, 0]), 1.0))

# ── the election: which metric earns trust ─────────────────────────────────────
# vs owner {a:1, b:1, c:0, d:0}: judge_win hits a,b,c = 0.75; emb hits a,d = 0.50;
# ppl hits nothing = 0.00.
columns = {
    "judge_win": {"a": 1, "b": 1, "c": 0, "d": 1},      # 0.75
    "emb": {"a": 1, "b": 0, "c": 1, "d": 0},            # 0.50
    "ppl": {"a": 0, "b": 0, "c": 1, "d": 1},            # 0.00
}
# The trap this program actually hit: when the owner answers one way 94% of the
# time, a CONSTANT column "agrees" 94% without discriminating anything. Election
# must be chance-corrected, or it hands the HALT key to a column that says one
# word forever.
skewed_owner = {f"p{i}": (0 if i < 47 else 1) for i in range(50)}
constant_col = {f"p{i}": 0 for i in range(50)}          # always "truth"
real_col = {f"p{i}": (0 if i < 47 else 1) for i in range(50)}  # actually tracks
skew = calibrate.elect(skewed_owner, {"constant": constant_col}, bar=0.65)
check("constant column cannot be elected despite 94% raw agreement",
      skew["halt"] is True and skew["metric"] is None,
      str({k: skew.get(k) for k in ('metric', 'halt')}))
check("constant column's inflation is visible in the ranking",
      skew["ranked"][0]["accuracy"] > 0.9 and skew["ranked"][0]["kappa"] == 0.0,
      str(skew["ranked"][0]))
skill = calibrate.elect(skewed_owner, {"real": real_col, "constant": constant_col},
                        bar=0.65)
check("a genuinely discriminating column still wins on skewed labels",
      skill["metric"] == "real" and skill["halt"] is False, str(skill.get("metric")))
check("baseline (majority-class) is reported so inflation is legible",
      abs(skill["baseline"] - 0.94) < 1e-9, str(skill.get("baseline")))

elected = calibrate.elect(owner, columns, bar=0.65)
check("election: best column above the bar wins",
      elected["metric"] == "judge_win" and close(elected["agreement"], 0.75),
      str(elected))
check("election: runner-up recorded for the ledger",
      elected["runnerUp"]["metric"] == "emb", str(elected.get("runnerUp")))
check("election: nothing clears the bar → halt=True with no metric",
      calibrate.elect(owner, {"emb": columns["emb"]}, bar=0.65)["halt"] is True)
check("election: clearing the bar sets halt=False", elected["halt"] is False)
check("election: no comparable labels → halt, not a crash",
      calibrate.elect({"a": None}, columns, bar=0.65)["halt"] is True)

# ── report rendering ───────────────────────────────────────────────────────────
md = calibrate.render_report(
    {"line": elected, "span": calibrate.elect(owner, {"emb": columns["emb"]},
                                              bar=0.65)},
    {"selfConsistency": 0.9, "labels": 24, "bar": 0.65})
check("report names the bar, the winner and the HALT state",
      "0.65" in md and "judge_win" in md and "HALT" in md.upper(), md[:200])
check("report is deterministic", md == calibrate.render_report(
    {"line": elected, "span": calibrate.elect(owner, {"emb": columns["emb"]},
                                              bar=0.65)},
    {"selfConsistency": 0.9, "labels": 24, "bar": 0.65}))

# ── I2c: self-consistency under the per-fill instrument ────────────────────────
# The v1 implementation compared a `choice` field. Per-fill rows have no such
# field, so every repeat would have compared "" to "" and reported PERFECT
# self-consistency — a number that caps how much any agreement statistic can
# mean, silently set to 1.0.
V2_CONSISTENT = [{"pairId": "x", "side": "left", "rating": "keep"},
                 {"pairId": "x", "side": "right", "rating": "no"},
                 {"pairId": "x", "side": "left", "rating": "keep"},
                 {"pairId": "x", "side": "right", "rating": "no"}]
V2_FLIPPED = [{"pairId": "y", "side": "left", "rating": "keep"},
              {"pairId": "y", "side": "left", "rating": "no"}]
check("self-consistency: a repeated pair rated the same way scores 1.0",
      close(calibrate.self_consistency(V2_CONSISTENT), 1.0),
      str(calibrate.self_consistency(V2_CONSISTENT)))
check("self-consistency: a flipped repeat is NOT reported as consistent",
      close(calibrate.self_consistency(V2_FLIPPED), 0.0),
      str(calibrate.self_consistency(V2_FLIPPED)))
check("self-consistency: mixed repeats score in between",
      close(calibrate.self_consistency(V2_CONSISTENT + V2_FLIPPED), 2 / 3),
      str(calibrate.self_consistency(V2_CONSISTENT + V2_FLIPPED)))
check("self-consistency: no repeats → None, not a fabricated 1.0",
      calibrate.self_consistency(
          [{"pairId": "z", "side": "left", "rating": "keep"}]) is None)
check("self-consistency: the old forced-choice rows still measure",
      close(calibrate.self_consistency(
          [{"pairId": "q", "choice": "left"},
           {"pairId": "q", "choice": "right"}]), 0.0))

# ── I2c: absolute acceptability ────────────────────────────────────────────────
# The owner's framing: real-vs-generated is not a head-to-head, so what matters
# is whether the generated bar WORKS — reported against the rate at which the
# real bar itself works. Both are rates, so the answer is a difference with an
# interval, not an assertion.
KEY_C = {
    # anchor stratum: the RANDOM sample, so the ceiling estimated here is
    # unbiased. Disagreement pairs are selected precisely because the metrics
    # split on them, which is not a fair sample of anything absolute.
    "a1": {"kind": "vs_truth", "arm": "arm-a", "truthSide": "right",
           "granularity": "line", "selection": "anchor", "identityHidden": False},
    "a2": {"kind": "vs_truth", "arm": "arm-a", "truthSide": "left",
           "granularity": "line", "selection": "anchor", "identityHidden": False},
    "d1": {"kind": "vs_truth", "arm": "arm-a", "truthSide": "right",
           "granularity": "line", "selection": "disagreement",
           "identityHidden": False},
    "d2": {"kind": "vs_truth", "arm": "arm-a", "truthSide": "right",
           "granularity": "line", "selection": "disagreement",
           "identityHidden": True},
}
# anchors: real bar keeps twice; disagreement pairs: real bar never keeps.
RATED = {"a1": {"left": "keep", "right": "keep", "heard": True},
         "a2": {"left": "keep", "right": "passable", "heard": True},
         "d1": {"left": "no", "right": "no", "heard": False},
         "d2": {"left": "passable", "right": "no", "heard": False}}

acc = calibrate.acceptability(RATED, KEY_C)
check("acceptability: per-arm rate of the machine fill working",
      close(acc["arms"]["arm-a"]["keepRate"], 0.25)
      and close(acc["arms"]["arm-a"]["worksRate"], 0.75), str(acc["arms"]))
check("acceptability: reports how many fills it is based on",
      acc["arms"]["arm-a"]["n"] == 4, str(acc["arms"]))
check("acceptability: carries a Wilson interval, not a bare point estimate",
      len(acc["arms"]["arm-a"]["worksCi"]) == 2
      and acc["arms"]["arm-a"]["worksCi"][0] < 0.75 < acc["arms"]["arm-a"]["worksCi"][1])

ceil_ = calibrate.ceiling(RATED, KEY_C)
check("ceiling: the real bar's own rate, from the ANCHOR stratum only",
      ceil_["n"] == 2 and close(ceil_["worksRate"], 1.0), str(ceil_))
# RED-proof for the stratum rule: make the disagreement pairs wildly different.
# If the ceiling moved, it would be reading a biased sample.
SKEWED = {**RATED, "d1": {"left": "no", "right": "no", "heard": False},
          "d3": {"left": "no", "right": "no", "heard": False}}
KEY_SKEW = {**KEY_C, "d3": {"kind": "vs_truth", "arm": "arm-a",
                            "truthSide": "right", "granularity": "line",
                            "selection": "disagreement", "identityHidden": False}}
check("ceiling: ignores the disagreement stratum entirely",
      close(calibrate.ceiling(SKEWED, KEY_SKEW)["worksRate"], 1.0)
      and calibrate.ceiling(SKEWED, KEY_SKEW)["n"] == 2,
      str(calibrate.ceiling(SKEWED, KEY_SKEW)))
check("ceiling: no anchor pairs → None, never a silent zero",
      calibrate.ceiling(RATED, {"d1": KEY_C["d1"]})["worksRate"] is None)

gap = calibrate.diff_ci(3, 4, 2, 2)
check("diff_ci: a negative gap when the machine trails the human",
      gap["diff"] < 0 and gap["ci"][0] < gap["diff"] < gap["ci"][1], str(gap))
check("diff_ci: an interval spanning zero is honestly inconclusive",
      calibrate.diff_ci(2, 4, 2, 4)["ci"][0] < 0
      < calibrate.diff_ci(2, 4, 2, 4)["ci"][1])

split = calibrate.by_condition(RATED, KEY_C)
check("control read: shown vs hidden reported separately",
      split["shown"]["n"] == 3 and split["hidden"]["n"] == 1, str(split))
check("control read: heard vs not-heard reported separately",
      split["heard"]["n"] == 2 and split["notHeard"]["n"] == 2, str(split))

md2 = calibrate.render_report({"line": elected}, {
    "selfConsistency": 0.9, "labels": 24, "bar": 0.65,
    "acceptability": acc, "ceiling": ceil_, "conditions": split})
check("report leads with the product answer, not the election",
      md2.lower().index("does the bar work") < md2.lower().index("| column |"),
      md2[:120])
check("report states the ceiling the arms are measured against",
      "ceiling" in md2.lower() and "real bar" in md2.lower())
check("report names the control read so a moved ruler is visible",
      "hidden" in md2.lower() and "shown" in md2.lower())
check("report is still deterministic with the new sections",
      md2 == calibrate.render_report({"line": elected}, {
          "selfConsistency": 0.9, "labels": 24, "bar": 0.65,
          "acceptability": acc, "ceiling": ceil_, "conditions": split}))

# ── "no columns" is not the same failure as "no column cleared the bar" ────────
# An arm-vs-arm taste sitting carries no judge columns at all. Reporting that as
# HALT reads as "the judges were measured and failed", when nothing was measured
# — which would send someone off to fix judges that were never run.
empty = calibrate.elect({"p1": 1, "p2": 0}, {}, bar=0.65)
check("elect: no columns at all is flagged distinctly, not as a failed election",
      empty.get("noColumns") is True and empty["halt"] is True, str(empty))
check("elect: a column that exists but loses is NOT flagged noColumns",
      calibrate.elect({"p1": 1, "p2": 0}, {"emb": {"p1": 0, "p2": 1}},
                      bar=0.65).get("noColumns") is not True)
md_nc = calibrate.render_report({"rhyme": empty}, {"labels": 14, "bar": 0.65,
                                                   "selfConsistency": 0.67})
check("report says nothing was elected, rather than that judging failed",
      "no automated column" in md_nc.lower(), md_nc)
check("report does not claim HALT when there was nothing to halt on",
      "HALT" not in md_nc.upper(), md_nc)

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
