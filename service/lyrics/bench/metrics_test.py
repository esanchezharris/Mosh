#!/usr/bin/env python3
"""Golden tests for the deterministic bench metrics (FMS lyrics-bench I1).

Hermetic: injected lexicon only. The load-bearing phonology case is pinned here the
same way the phonology golden pins it: love/dove = PERFECT, love/move = SLANT (never
spelling), so rhyme_fit(slant) accepts both but rhyme_perfect separates them.

Run:  python3 service/lyrics/bench/metrics_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import metrics  # noqa: E402
from lyrics.bench._testlex import make_pron  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


PRON = make_pron()


def word_item(**kw):
    base = {
        "itemId": "v1:word:t:s0:l0", "granularity": "word", "songId": "t",
        "artist": "T", "si": 0, "li": 0, "sectionKind": "verse",
        "licenseTier": "train-ok", "views": 0, "maskPolicy": "word-v1", "seed": 0,
        "context": {"before": [], "maskedLine": "they beg for a ____!", "after": []},
        "target": {"text": "cent", "tokenIndex": 4, "tokenSpan": None,
                   "phones": ["S", "EH1", "N", "T"], "phonesSource": "lexicon",
                   "syllables": 1, "stress": "X"},
        "constraints": {"syllables": 1, "syllableTol": 0, "rhymeWith": None,
                        "rhymeStrictness": "slant", "lineSyllableTarget": None},
        "split": "dev",
    }
    for k, v in kw.items():
        if isinstance(v, dict) and k in base and isinstance(base[k], dict):
            base[k] = {**base[k], **v}
        else:
            base[k] = v
    return base


# ---- normalization + exact/topk ----
check("normalize: case + punctuation", metrics.normalize("Solid,") == "solid")
check("normalize: apostrophes collapse", metrics.normalize("don't") == metrics.normalize("dont"))
it = word_item()
row = metrics.score_item(it, ["Cent,"], PRON)
check("exact: normalized top-1 match", row["exact"] == 1, str(row["exact"]))
row2 = metrics.score_item(it, ["dime", "gold", "cent"], PRON)
check("exact misses when top-1 differs", row2["exact"] == 0)
check("topk catches a lower-ranked exact", row2["topk"] == 1)
row3 = metrics.score_item(it, ["dime", "gold"], PRON)
check("topk 0 when absent", row3["topk"] == 0)

# ---- apply_fill preserves punctuation ----
check("apply_fill: word blank + punctuation preserved",
      metrics.apply_fill(it, "cent") == "they beg for a cent!",
      repr(metrics.apply_fill(it, "cent")))
span_it = word_item(
    granularity="span",
    context={"maskedLine": "I was ____ ____ ____ rent, no debate"},
    target={"text": "counting up the", "tokenIndex": None, "tokenSpan": [2, 5],
            "phones": None, "phonesSource": "none", "syllables": 4, "stress": ""},
    constraints={"syllables": 4, "syllableTol": 1},
)
check("apply_fill: span blank-run replaced as a unit",
      metrics.apply_fill(span_it, "stacking all the") ==
      "I was stacking all the rent, no debate",
      repr(metrics.apply_fill(span_it, "stacking all the")))
line_it = word_item(
    granularity="line",
    context={"before": ["a", "b"], "maskedLine": None, "after": ["c"]},
    target={"text": "the whole truth line", "tokenIndex": None, "tokenSpan": None,
            "phones": None, "syllables": 4, "stress": ""},
    constraints={"syllables": None, "syllableTol": 1, "rhymeWith": "rain",
                 "lineSyllableTarget": 4},
)
check("apply_fill: line granularity returns the fill itself",
      metrics.apply_fill(line_it, "my candidate line") == "my candidate line")

# ---- syl_fit ----
check("syl_fit: exact syllable target passes",
      metrics.score_item(it, ["cent"], PRON)["syl_fit"] == 1)
check("syl_fit: 2-syllable word misses a 1-syllable slot (tol 0)",
      metrics.score_item(it, ["ledger"], PRON)["syl_fit"] == 0)
check("syl_fit: line grades against lineSyllableTarget +-tol",
      metrics.score_item(line_it, ["one two three four"], PRON)["syl_fit"] == 1
      and metrics.score_item(line_it, ["one"], PRON)["syl_fit"] == 0)

# ---- rhyme_fit: the load-bearing slant case ----
rh = word_item(granularity="rhyme",
               target={"text": "dove", "phones": [["D", "AH1", "V"]][0],
                       "phonesSource": "lexicon", "syllables": 1, "stress": "X"},
               constraints={"syllables": 1, "syllableTol": 0, "rhymeWith": "love",
                            "rhymeStrictness": "slant"})
r_perfect = metrics.score_item(rh, ["dove"], PRON)
r_slant = metrics.score_item(rh, ["move"], PRON)
r_none = metrics.score_item(rh, ["gold"], PRON)
check("rhyme_fit: perfect rhyme passes", r_perfect["rhyme_fit"] == 1)
check("rhyme_perfect: flags the perfect case", r_perfect["rhyme_perfect"] == 1)
check("rhyme_fit: love/move slant passes at slant strictness", r_slant["rhyme_fit"] == 1)
check("rhyme_perfect: slant is NOT perfect", r_slant["rhyme_perfect"] == 0)
check("rhyme_fit: non-rhyme fails", r_none["rhyme_fit"] == 0)
check("multi_depth reported for rhyme items", r_perfect["multi_depth"] == 1,
      str(r_perfect["multi_depth"]))

# ---- gradability exclusion ----
oov = metrics.score_item(rh, ["zzzqx"], PRON)
check("rhyme_fit: OOV candidate end-word -> None (excluded, not guessed)",
      oov["rhyme_fit"] is None, str(oov["rhyme_fit"]))
check("constrained_fit: AND of the applicable fits",
      r_perfect["constrained_fit"] == 1 and r_none["constrained_fit"] == 0
      and metrics.score_item(it, ["ledger"], PRON)["constrained_fit"] == 0)
check("constrained_fit: falls back to remaining fits when rhyme ungradable",
      oov["constrained_fit"] == oov["syl_fit"], f"{oov}")

# ---- line rhyme_fit via the filled line's end word ----
line_pass = metrics.score_item(line_it, ["walking through the chain"], PRON)
line_fail = metrics.score_item(line_it, ["walking through the gold"], PRON)
check("line rhyme_fit: end word of candidate line vs rhymeWith",
      line_pass["rhyme_fit"] == 1 and line_fail["rhyme_fit"] == 0,
      f"pass={line_pass['rhyme_fit']} fail={line_fail['rhyme_fit']}")
check("line items have no exact metric", line_pass["exact"] is None)

# ---- aggregation ----
rows = [metrics.score_item(it, ["cent"], PRON),
        metrics.score_item(it, ["dime"], PRON),
        r_perfect, oov]
agg = metrics.aggregate(rows)
check("aggregate: per-granularity means with None-skipping",
      agg["word"]["exact"] == 0.5 and agg["word"]["n"] == 2
      and agg["rhyme"]["rhyme_fit"] == 1.0 and agg["rhyme"]["n_rhyme_fit"] == 1,
      str(agg))

# ---- punctuation-robust equivalence + determinism ----
check("'Cent,' and 'cent' score identically (fills tokenized before pronouncing), 3x",
      all(metrics.score_item(it, ["cent"], PRON) == row for _ in range(3)))

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
