#!/usr/bin/env python3
"""Golden tests for the verse rhyme planner (FMS WS1 / M3).

Hermetic: system python3, injected `_testlex` lexicon, no LLM, no network.

The load-bearing test is **seed agreement with `core._group_anchors`**. The
planner and the generation loop must never disagree about which word anchors a
group; if they do, the planner proposes rhymes for one target while the validator
enforces another, and every bar fails for a reason neither component reports.
That is why the planner calls `_group_anchors` rather than re-deriving it, and why
this asserts the two agree on a sheet built to make them disagree if it didn't.

Run:  python3 service/lyrics/planner_test.py     (exit 0 = all pass)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from lyrics import core as product_core  # noqa: E402
from lyrics import planner  # noqa: E402
from lyrics.bench._testlex import make_pron  # noqa: E402

PRON = make_pron()
product_core._P = PRON

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# Group A is anchored by a FINALIZED line ending in "mind"; group B has no fixed
# end word at all, so its seed has to be inferred.
SPEC = {
    "grid": "1/16", "rhymeStrictness": "slant", "explicit": "allow",
    "topic": "comeback", "mood": "aggressive",
    "lines": [
        {"index": 0, "text": "i came up with it heavy on my mind", "locked": True,
         "rhymeGroup": "A"},
        {"index": 1, "seedText": "____", "syllableTarget": 10, "syllableTol": 1,
         "rhymeGroup": "A"},
        {"index": 2, "seedText": "i keep the ____", "syllableTarget": 9,
         "syllableTol": 1, "rhymeGroup": "B"},
        {"index": 3, "seedText": "____", "syllableTarget": 9, "syllableTol": 1,
         "rhymeGroup": "B"},
        {"index": 4, "seedText": "____", "syllableTarget": 8, "syllableTol": 1},
    ],
}

FREQ = {"grind": 900, "blind": 300, "lined": 40, "sign": 500, "shine": 700,
        "line": 1200, "mine": 800, "climb": 250, "rain": 400, "train": 200,
        "chain": 260, "pane": 12, "gold": 640, "cold": 610}

plan = planner.plan_anchors(SPEC, freq=FREQ, pronouncer=PRON)

# ---- 1. shape ----
check("plan: ok and versioned", plan["ok"] and plan["v"] == 1)
check("plan: one entry per rhyme group", sorted(plan["groups"]) == ["A", "B"],
      str(sorted(plan["groups"])))
check("plan: ungrouped lines are listed, not silently dropped",
      plan["ungrouped"] == [4], str(plan["ungrouped"]))

# ---- 2. seed agreement with the generation loop (the one that matters) ----
by_index = sorted(SPEC["lines"], key=lambda l: int(l["index"]))
loop_anchors = product_core._group_anchors(by_index)
check("seed: group A uses the SAME anchor the loop pre-scans",
      plan["groups"]["A"]["seed"] == loop_anchors.get("A") == "mind",
      f'planner={plan["groups"]["A"]["seed"]!r} loop={loop_anchors.get("A")!r}')
check("seed: group A is marked fixed (a finalized line anchors it)",
      plan["groups"]["A"]["fixed"] is True)
check("seed: group B has no fixed anchor and says so",
      plan["groups"]["B"]["fixed"] is False)
check("seed: group B still infers a seed to rhyme against",
      bool(plan["groups"]["B"]["seed"]), str(plan["groups"]["B"]["seed"]))
# Fixture adequacy: the two groups genuinely differ, so the agreement check above
# is distinguishing fixed from inferred rather than passing on a uniform sheet.
check("seed fixture: the sheet really has one fixed and one unfixed group",
      "A" in loop_anchors and "B" not in loop_anchors, str(loop_anchors))

# ---- 3. every candidate actually rhymes with its seed ----
a = plan["groups"]["A"]
check("candidates: group A is non-empty", len(a["candidates"]) >= 3,
      str(len(a["candidates"])))
check("candidates: every one rhymes with the seed at the group's strictness",
      all(PRON.rhyme(c["word"], a["seed"], a["strictness"]) for c in a["candidates"]),
      str([c["word"] for c in a["candidates"]]))
check("candidates: the seed never proposes itself",
      all(c["word"].lower() != a["seed"].lower() for c in a["candidates"]))

# ---- 4. stopwords and short tokens are filtered ----
# `_testlex` contains no stopwords and no sub-3-char words, so asserting over it
# alone is vacuous — it passed a sabotage that deleted the filter outright. This
# uses a lexicon seeded with BOTH kinds of junk that genuinely rhyme with the
# anchor, so the filter has something real to remove.
from lyrics.bench.mask import STOP_AND_FILLER  # noqa: E402
from lyrics.bench._testlex import LEX  # noqa: E402
from phonology.core import Pronouncer  # noqa: E402

_JUNK_LEX = dict(LEX)
_JUNK_LEX["nd"] = [["N", "AY1", "N", "D"]]          # sub-3-char, rhymes with mind
_a_stop = next(w for w in ("been", "in", "and", "the", "but") if w in STOP_AND_FILLER)
_JUNK_LEX[_a_stop] = [["B", "AY1", "N", "D"]]        # a real stopword, made to rhyme
_junk_pron = Pronouncer(lexicon=_JUNK_LEX, g2p=lambda w: None)

# Fixture adequacy: both junk words really are in the raw rhyme set, so the
# filter is removing something rather than finding nothing.
_raw_junk = _junk_pron.rhyme_search("mind", "slant", max_n=200)
check("filter fixture: the raw rhyme set DOES contain a stopword and a short token",
      _a_stop in _raw_junk and "nd" in _raw_junk,
      f"stop={_a_stop in _raw_junk} short={'nd' in _raw_junk}")

_junk_plan = planner.plan_anchors(SPEC, freq=FREQ, pronouncer=_junk_pron)
_junk_words = [c["word"] for g in _junk_plan["groups"].values() for c in g["candidates"]]
check("filter: neither the stopword nor the sub-3-char token is proposed",
      _a_stop not in _junk_words and "nd" not in _junk_words, str(_junk_words))

allw = [c["word"] for g in plan["groups"].values() for c in g["candidates"]]
check("filter: the clean lexicon likewise proposes no stopword or short token",
      all(len(w) >= 3 and w.lower() not in STOP_AND_FILLER for w in allw), str(allw))

# ---- 5. syllable budget: an anchor that cannot END the shortest bar is dropped --
TIGHT = {"grid": "1/16", "rhymeStrictness": "slant",
         "lines": [
             {"index": 0, "text": "the whole thing was designed for the grind",
              "locked": True, "rhymeGroup": "A"},
             # 3 syllables of seed against a 4-syllable target ⇒ 1 syllable left.
             {"index": 1, "seedText": "i keep the ____", "syllableTarget": 4,
              "syllableTol": 0, "rhymeGroup": "A"},
         ]}
tight = planner.plan_anchors(TIGHT, freq=FREQ, pronouncer=PRON)
tw = tight["groups"]["A"]["candidates"]
check("budget: every candidate fits the tightest line's remaining syllables",
      all(c["syllables"] <= 1 for c in tw), str([(c["word"], c["syllables"]) for c in tw]))
# Fixture adequacy: multi-syllable rhymes of "grind" DO exist in the lexicon, so
# the filter is removing something real rather than finding nothing to remove.
_all_rhymes = PRON.rhyme_search("grind", "slant", max_n=200)
check("budget fixture: the lexicon does offer >1-syllable rhymes to filter out",
      any(PRON.syllables(w) > 1 for w in _all_rhymes),
      str([(w, PRON.syllables(w)) for w in _all_rhymes if PRON.syllables(w) > 1][:4]))

# ---- 6. determinism ----
check("determinism: two calls give byte-identical plans",
      planner.plan_anchors(SPEC, freq=FREQ, pronouncer=PRON) == plan)
check("determinism: a fresh Pronouncer gives the same plan",
      planner.plan_anchors(SPEC, freq=FREQ, pronouncer=make_pron()) == plan)

# ---- 7. frequency is a plausibility term, not a maximand ----
# The honest invariant is BOUNDED CONTRIBUTION, not "frequency never wins". A
# first attempt at this asserted a 10^6 spike could not reach the top, which was
# vacuous twice over: the spiked word was not even a candidate for that group,
# and had it been, log-frequency WOULD have carried it. What must hold is that
# the whole realistic frequency range is worth less than one depth step — so a
# deeper rhyme always outranks a merely commoner one. A raw maximand breaks this
# instantly, which is how the floor ended up answering 'been / an / a'.
DEPTH_STEP = planner.DEPTH_WEIGHT
_freq_span = min(planner.FREQ_WEIGHT * math.log1p(10 ** 6), planner.FREQ_CAP)
check("ranking: the ENTIRE frequency range is worth less than one depth step",
      _freq_span < DEPTH_STEP, f"span={_freq_span:.2f} depth step={DEPTH_STEP}")
# ...and a 1000x frequency advantage is worth less than a grade+depth step, so a
# common slant rhyme cannot displace a rare perfect multisyllabic one.
_ratio_gain = (min(planner.FREQ_WEIGHT * math.log1p(1000 * 500), planner.FREQ_CAP)
               - min(planner.FREQ_WEIGHT * math.log1p(500), planner.FREQ_CAP))
check("ranking: a 1000x frequency advantage cannot buy a depth step",
      _ratio_gain < DEPTH_STEP, f"gain={_ratio_gain:.2f}")
# Behavioural: boosting a word already in the set must not reorder past a deeper
# candidate. With equal depths it MAY reorder — that is allowed and asserted, so
# the test distinguishes "bounded" from "ignored".
# BEHAVIOURAL, and the only version of this that catches a formula change: the
# assertions above read planner's constants, so a sabotage replacing the whole
# scoring expression leaves them green. `_testlex` cannot express this — every
# rhyme of a one-syllable anchor has depth 1 — so this uses a two-syllable anchor
# where one candidate genuinely rhymes two syllables deep and the other one.
_DEPTH_LEX = {
    "combine": [["K", "AH0", "M", "B", "AY1", "N"]],   # anchor, 2 syllables
    "align":   [["AH0", "L", "AY1", "N"]],             # depth 2 (AH0 + AY1 N)
    "design":  [["D", "IH0", "Z", "AY1", "N"]],        # depth 1 (AY1 N only)
}
_depth_pron = Pronouncer(lexicon=_DEPTH_LEX, g2p=lambda w: None)
_DEPTH_SPEC = {"grid": "1/16", "rhymeStrictness": "slant", "lines": [
    {"index": 0, "text": "everything about it was combine", "locked": True,
     "rhymeGroup": "A"},
    {"index": 1, "seedText": "____", "syllableTarget": 8, "syllableTol": 2,
     "rhymeGroup": "A"}]}
_dp = planner.plan_anchors(_DEPTH_SPEC, freq={"design": 500_000, "align": 0},
                           pronouncer=_depth_pron)
_dc = {c["word"]: c for c in _dp["groups"]["A"]["candidates"]}
_dorder = [c["word"] for c in _dp["groups"]["A"]["candidates"]]
check("ranking fixture: the two candidates really differ in rhyme depth",
      _dc.get("align", {}).get("depth", 0) > _dc.get("design", {}).get("depth", 9),
      str([(w, _dc[w]["depth"], _dc[w]["freq"]) for w in _dorder]))
check("ranking: a 500,000x commoner SHALLOWER rhyme does not outrank the deeper one",
      _dorder and _dorder[0] == "align", str(_dorder))

_boosted = dict(FREQ)
_boosted["lined"] = FREQ["grind"] * 1000
_bp = planner.plan_anchors(SPEC, freq=_boosted, pronouncer=PRON)
_b_top = [c["word"] for c in _bp["groups"]["A"]["candidates"]]
_by_word = {c["word"]: c for c in _bp["groups"]["A"]["candidates"]}
check("ranking: frequency is not ignored either (a boost does move a peer up)",
      "lined" in _b_top, str(_b_top))
check("ranking: but never past a candidate with strictly greater depth",
      all(_by_word["lined"]["depth"] >= c["depth"]
          for c in _bp["groups"]["A"]["candidates"][:_b_top.index("lined")]),
      str([(c["word"], c["depth"]) for c in _bp["groups"]["A"]["candidates"]]))
check("ranking: scores are ordered descending and ties break alphabetically",
      all(a["candidates"][i]["score"] >= a["candidates"][i + 1]["score"]
          for i in range(len(a["candidates"]) - 1)))

# ---- 8. rime-family diversity: not eight spellings of one sound ----
fams = {}
for c in a["candidates"]:
    ph = PRON.phones(c["word"])
    fams.setdefault(planner._rime_family(ph), []).append(c["word"])
check("diversity: no rime family contributes more than the cap",
      all(len(v) <= planner._MAX_PER_FAMILY for v in fams.values()),
      str({k: v for k, v in fams.items() if len(v) > planner._MAX_PER_FAMILY}))
check("diversity fixture: the raw rhyme list DOES over-represent one family",
      max(len(v) for v in fams.values()) >= 1 and len(_all_rhymes) > len(a["candidates"]),
      f"raw={len(_all_rhymes)} planned={len(a['candidates'])}")

# ---- 9. degenerate specs ----
check("empty: a spec with no rhyme groups plans nothing and does not crash",
      planner.plan_anchors({"lines": [{"index": 0, "seedText": "____"}]},
                           pronouncer=PRON)["groups"] == {})
unknown = planner.plan_anchors(
    {"rhymeStrictness": "slant",
     "lines": [{"index": 0, "text": "ends on zzqx", "locked": True, "rhymeGroup": "A"},
               {"index": 1, "seedText": "____", "syllableTarget": 8, "rhymeGroup": "A"}]},
    pronouncer=PRON)
check("unknown seed: an unpronounceable anchor yields no candidates, not a crash",
      unknown["groups"]["A"]["candidates"] == [],
      str(unknown["groups"]["A"]["candidates"])[:80])

# ── the third state: a planned anchor is a fixed END WORD, not a rhyme target ────
#
# The failure this section exists to prevent: writing the anchor into seedText/text
# makes `_fixed_end_word` return it, `_group_anchors` adopt it as the GROUP anchor,
# and `must_rhyme` go False for EVERY OTHER LINE in that group — the phonology gate
# silently becoming a no-op across the whole verse. `rhymeAnchor` is a separate
# field precisely so `_group_anchors` never sees it.

PLANNED = {
    "grid": "1/16", "rhymeStrictness": "slant",
    "lines": [
        {"index": 0, "text": "i came up with it heavy on my mind", "locked": True,
         "rhymeGroup": "A"},
        {"index": 1, "seedText": "____", "syllableTarget": 10, "syllableTol": 1,
         "rhymeGroup": "A", "rhymeAnchor": "grind"},
        {"index": 2, "seedText": "____", "syllableTarget": 10, "syllableTol": 1,
         "rhymeGroup": "A"},
    ],
}
_by = sorted(PLANNED["lines"], key=lambda l: int(l["index"]))
_anchors = product_core._group_anchors(_by)

check("third state: the planned anchor is readable",
      product_core._planned_end_word(PLANNED["lines"][1]) == "grind")
check("third state: it is NOT a fixed end word",
      product_core._fixed_end_word(PLANNED["lines"][1]) is None)
check("third state: the GROUP anchor is unaffected by it",
      _anchors.get("A") == "mind", str(_anchors))

_line = PLANNED["lines"][1]
_ok = product_core._evaluate("i had to get it out here on the grind", _line, PLANNED,
                             "mind", 10, 1, "slant")
_bad = product_core._evaluate("i had to get it out here on the line", _line, PLANNED,
                              "mind", 10, 1, "slant")
check("endWordOk: landing on the planned word passes",
      _ok["endWordOk"] and _ok["passes"], str(_ok))
check("endWordOk: a DIFFERENT word that still rhymes with the group FAILS",
      (not _bad["endWordOk"]) and (not _bad["passes"]),
      f'end={_bad["endWord"]!r} endWordOk={_bad["endWordOk"]} passes={_bad["passes"]}')
# Fixture adequacy: the rejected word genuinely rhymes with the group anchor, so
# the check is distinguishing "lands on the anchor" from "rhymes with the group"
# rather than passing because the candidate was bad anyway.
check("endWordOk fixture: the rejected word DOES rhyme with the group anchor",
      product_core.rhymes("line", "mind", "slant") and _bad["syllableOk"],
      "the rejection must be about the anchor, not syllables or rhyme")

# The group-wide nullification, asserted directly.
_sibling = PLANNED["lines"][2]           # same group, NO planned anchor
_sib_bad = product_core._evaluate("nothing here rhymes with the anchor at all today",
                                  _sibling, PLANNED, "mind", 10, 1, "slant")
check("no nullification: a sibling line in the same group KEEPS its rhyme gate",
      not _sib_bad["rhymeOk"] and not _sib_bad["passes"],
      f'rhymeOk={_sib_bad["rhymeOk"]} end={_sib_bad["endWord"]!r}')

# Precedence: producer-fixed beats planned.
_fixed_line = {"index": 9, "seedText": "____ gold", "syllableTarget": 8,
               "rhymeGroup": "A", "rhymeAnchor": "grind"}
_msgs = product_core._build_messages(_fixed_line, PLANNED, "mind", 8, 1, "slant", None)
_usr = _msgs[1]["content"]
check("precedence: a producer-fixed end word wins over the planned one",
      'END on the word "gold"' in _usr and "grind" not in _usr, _usr[:150])
_msgs2 = product_core._build_messages(_line, PLANNED, "mind", 10, 1, "slant", None)
check("precedence: with no fixed word, the prompt names the PLANNED word",
      'END on the word "grind"' in _msgs2[1]["content"], _msgs2[1]["content"][:150])
_plain = {"index": 8, "seedText": "____", "syllableTarget": 8, "rhymeGroup": "A"}
_msgs3 = product_core._build_messages(_plain, PLANNED, "mind", 8, 1, "slant", None)
check("precedence: with neither, the prompt falls back to the group rhyme target",
      'rhyme with "mind"' in _msgs3[1]["content"], _msgs3[1]["content"][:150])

# The re-prompt loop must say WHICH word was expected, or the retry is blind.
check("retry: the failure reason names the planned word and what came instead",
      "grind" in product_core._failure_reason(_bad, 10, 1, "mind", "slant", "grind")
      and "line" in product_core._failure_reason(_bad, 10, 1, "mind", "slant", "grind"),
      product_core._failure_reason(_bad, 10, 1, "mind", "slant", "grind"))

# Analysis must agree with the loop, or the visualizer marks a bar green that the
# gate rejects — the divergence _analyze_line's own docstring warns about.
_an = product_core._analyze_line({**_line, "text": "i had to get it out here on the line"},
                                 PLANNED, "mind")
check("analysis: a wrong end word is NOT marked passing (agrees with _evaluate)",
      not _an["passes"], str({k: _an.get(k) for k in ("passes", "endWordOk", "endWord")}))

# ---- 10. the candidate UNIVERSE is freq-truncated (2026-07-28 pool fix) ----
# plan_anchors drew its universe as rhyme_search's alpha-truncated 200 and then
# re-ranked — but a re-rank cannot recover words the truncation already dropped.
# The fixture's rime family is LARGER than the internal 200-cap (228 words; a
# small family makes cap semantics invisible): 225 alphabetically-early junk
# words that pass the stop/len filters, plus 3 common words late in the alphabet
# that only survive the cap under frequency ranking. All are perfect same-family
# rhymes at depth 1, so the fix — not scoring — decides who is even considered.
import tempfile  # noqa: E402

_CAP_JUNK = sorted("aab" + c1 + c2 for c1 in "abcdefghijklmno"
                   for c2 in "abcdefghijklmno")               # 225 words
_CAP_LEX = {"mind": [["M", "AY1", "N", "D"]],
            "signed": [["S", "AY1", "N", "D"]],
            "twined": [["T", "W", "AY1", "N", "D"]],
            "wined": [["W", "AY1", "N", "D"]]}
_CAP_LEX.update({j: [["B", "AY1", "N", "D"]] for j in _CAP_JUNK})
_CAP_FREQ = {"signed": 900, "twined": 800, "wined": 700}
_cap_pron = Pronouncer(lexicon=_CAP_LEX, g2p=lambda w: None)
_CAP_SPEC = {"grid": "1/16", "rhymeStrictness": "slant", "lines": [
    {"index": 0, "text": "i came up with it heavy on my mind", "locked": True,
     "rhymeGroup": "A"},
    {"index": 1, "seedText": "____", "syllableTarget": 10, "syllableTol": 1,
     "rhymeGroup": "A"}]}

# Fixture adequacy: the alpha-truncated 200 really does lose every common word —
# the failure mode this section exists to catch, exhibited, not assumed.
_alpha200 = _cap_pron.rhyme_search("mind", "slant", max_n=200)
check("universe fixture: the alpha 200-cap holds ONLY junk (family 228 > cap)",
      len(_alpha200) == 200 and not {"signed", "twined", "wined"} & set(_alpha200),
      f"kept {sum(w in _alpha200 for w in _CAP_JUNK)} junk")

_cap_plan = planner.plan_anchors(_CAP_SPEC, freq=_CAP_FREQ, pronouncer=_cap_pron)
_cap_words = [c["word"] for c in _cap_plan["groups"]["A"]["candidates"]]
check("universe: common words survive the 200-cap and junk does not",
      _cap_words == ["signed", "twined"], str(_cap_words[:4]))

# freq=None must load the PRODUCT table (env-overridden here), so the planner is
# fixed for real callers, not only for tests that hand it a table.
with tempfile.TemporaryDirectory() as _td:
    _tab = os.path.join(_td, "ranks.txt")
    with open(_tab, "w", encoding="utf-8") as _f:
        _f.write("signed\ntwined\nwined\n")
    os.environ["MOSH_FREQ_TABLE"] = _tab
    try:
        _defplan = planner.plan_anchors(_CAP_SPEC, pronouncer=_cap_pron)
        _defwords = [c["word"] for c in _defplan["groups"]["A"]["candidates"]]
        check("universe: freq=None loads the product frequency table",
              _defwords == ["signed", "twined"], str(_defwords[:4]))
    finally:
        del os.environ["MOSH_FREQ_TABLE"]

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
