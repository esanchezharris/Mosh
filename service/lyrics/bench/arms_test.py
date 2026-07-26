#!/usr/bin/env python3
"""Golden tests for the I3a rhyme-word arms (FMS lyrics-bench).

The program pivoted here because the LINE-level metrics are pegged — `exact` is
not even defined for a whole bar and `constrained_fit` reads 100 for the shipped
loop — while the RHYME word has a metric with real range (floor 0 → constrained
47 → oracle 100) that costs nothing to compute. These arms are the optimization
loop for that granularity.

What must hold, and why:
  * **the honest floor really rhymes.** `freq-floor` answers with a frequent word
    that usually does NOT rhyme, scores 0.0, and thereby flatters every LLM arm
    it is compared against. `rhyme-floor` is the baseline an arm has to beat to
    have shown anything.
  * **the menu is derived from the PARTNER, not the target.** A menu is allowed
    to contain the true word — it is one of the partner's rhymes, and finding it
    there is exactly the skill being measured. What is forbidden is the menu
    CHANGING when the answer changes, which would mean the answer leaked in.
  * **arms degrade to empty candidates rather than raising** — one arm throwing
    must not void a sweep.

Hermetic: injected chat, the shared fixture lexicon, no network.

Run:  python3 service/lyrics/bench/arms_test.py     (exit 0 = all pass)
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import arms, llm_cache  # noqa: E402
from lyrics.bench._testlex import make_pron  # noqa: E402
from phonology.core import rhyme_grade  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


PRON = make_pron()
# 'basket' is the most frequent and does NOT rhyme with 'rain' — it is what the
# non-rhyming freq-floor will answer, which is the comparison being made.
#
# 'mine' is a deliberately HIGH-frequency SLANT rhyme. Without it every frequent
# word in this fixture happened to be a perfect rhyme, so a frequency-only sort
# produced perfect-first by accident and the grade-ordering check below could
# not fail. It now can.
FREQ = {"basket": 500, "mine": 300, "train": 90, "chain": 70, "pane": 40,
        "pain": 12}


def rhymes_with(word: str, partner: str = "rain") -> bool:
    a, b = PRON.phones(word), PRON.phones(partner)
    return bool(a and b) and rhyme_grade(a, b) in ("perfect", "slant")


RHYME_ITEM = {
    "itemId": "v1:rhyme:t:001:s0:l3", "granularity": "rhyme", "songId": "t:001",
    "artist": "T", "views": 100, "split": "dev",
    "context": {"before": ["I been up since it was pourin' down rain",
                           "countin' every dollar in the cold"],
                "maskedLine": "and I carry all of it without the ____",
                "after": ["nobody handed nothin' to me"]},
    "target": {"text": "pain", "tokenIndex": 7, "tokenSpan": None,
               "phones": None, "syllables": 1, "stress": "1"},
    "constraints": {"syllables": 1, "syllableTol": 0, "rhymeWith": "rain",
                    "rhymeStrictness": "slant", "lineSyllableTarget": 12},
}


def ctx(chat=None, cache_dir=None, k=5):
    return arms.ArmContext(chat=chat, pron=PRON, freq=FREQ, k=k,
                           cache=llm_cache.Cache(cache_dir) if cache_dir else None,
                           product_backend="fake")


# ── rhyme-floor: the HONEST baseline ────────────────────────────────────────────
res = arms.ARMS["rhyme-floor"](RHYME_ITEM, ctx())
cands = [c["text"] for c in res["candidates"]]
check("rhyme-floor returns candidates at all", bool(cands), str(cands))
check("rhyme-floor: EVERY candidate actually rhymes with the partner",
      all(rhymes_with(c) for c in cands), str(cands))
check("rhyme-floor: respects the syllable constraint",
      all(PRON.syllables(c) == 1 for c in cands), str(cands))
check("rhyme-floor: never answers with the partner word itself",
      "rain" not in cands, str(cands))
# PERFECT rhymes first, then frequency inside each grade. Sorting the whole menu
# by frequency alone throws away the grade ordering rhyme_search already computed
# — measured on 400 real items, that cost the floor 15.5% rhyme_perfect against
# llm-constrained's 50%, i.e. it flattered the arm it exists to test.
_perfect = [c for c in cands
            if rhyme_grade(PRON.phones(c), PRON.phones("rain")) == "perfect"]
_slant = [c for c in cands if c not in _perfect]
check("rhyme-floor: perfect rhymes rank above slant ones",
      cands == _perfect + _slant, str([(c, rhyme_grade(PRON.phones(c),
                                                       PRON.phones("rain")))
                                       for c in cands]))
check("rhyme-floor: frequency orders within a grade, commonest first",
      _perfect == sorted(_perfect, key=lambda w: (-FREQ.get(w, 0), w))
      and _slant == sorted(_slant, key=lambda w: (-FREQ.get(w, 0), w)),
      str([(c, FREQ.get(c, 0)) for c in cands]))
check("rhyme-floor: caps at k", len(cands) <= 5, str(len(cands)))

# Spot-checking 400 real items showed the floor answering 'been', 'an', 'a',
# 'they', 'but', 'at' — function words that technically slant-rhyme and dominate
# any corpus frequency table. `freq-floor` has always filtered these; the rhyme
# floor did not, which made it weak for a silly reason and therefore flattering
# to every arm measured against it.
# A LOCAL lexicon: the shared fixture is frozen by the mask/schema goldens and
# must not be edited. 'they' is a real stopword that really rhymes with 'rain',
# which is precisely the case that was reaching the top of the real floor.
from phonology.core import Pronouncer  # noqa: E402
from lyrics.bench._testlex import LEX  # noqa: E402

STOP_PRON = Pronouncer(lexicon={**LEX, "they": [["DH", "EY1"]],
                                "way": [["W", "EY1"]]}, g2p=lambda w: None)
STOPWORD_FREQ = {"they": 9000, "way": 20, "train": 90, "chain": 70}
stop_ctx = arms.ArmContext(chat=None, pron=STOP_PRON, freq=STOPWORD_FREQ, k=5,
                           cache=None, product_backend="fake")
stop_cands = [c["text"] for c in
              arms.ARMS["rhyme-floor"](RHYME_ITEM, stop_ctx)["candidates"]]
check("rhyme-floor: never answers with a stopword, however frequent",
      not any(w in ("and", "but", "a", "an", "the", "they", "as", "at", "been")
              for w in stop_cands), str(stop_cands))
check("rhyme-floor: still answers something real once stopwords are excluded",
      bool(stop_cands)
      and all(rhyme_grade(STOP_PRON.phones(w), STOP_PRON.phones("rain"))
              in ("perfect", "slant") for w in stop_cands),
      str(stop_cands))
check("rhyme-floor: deterministic",
      [c["text"] for c in arms.ARMS["rhyme-floor"](RHYME_ITEM, ctx())["candidates"]]
      == cands)

# The gap that is the whole reason this arm exists.
freq_floor = arms.ARMS["freq-floor"](RHYME_ITEM, ctx())["candidates"][0]["text"]
check("rhyme-floor beats freq-floor, which does not rhyme at all",
      not rhymes_with(freq_floor) and rhymes_with(cands[0]),
      f"freq-floor={freq_floor!r} rhyme-floor={cands[0]!r}")

NO_PARTNER = {**RHYME_ITEM, "granularity": "word",
              "constraints": {**RHYME_ITEM["constraints"], "rhymeWith": None}}
check("rhyme-floor: no rhyme partner → falls back, never raises",
      isinstance(arms.ARMS["rhyme-floor"](NO_PARTNER, ctx())["candidates"], list))
OOV = {**RHYME_ITEM,
       "constraints": {**RHYME_ITEM["constraints"], "rhymeWith": "zzzqx"}}
check("rhyme-floor: unpronounceable partner → empty, not a crash",
      isinstance(arms.ARMS["rhyme-floor"](OOV, ctx())["candidates"], list))


# ── prompt-rhyme-menu ───────────────────────────────────────────────────────────
SEEN = []


def spy_chat(messages, **kw):
    SEEN.append(json.dumps(messages))
    return {"ok": True, "provider": "fake", "model": "spy",
            "content": json.dumps({"fills": ["pain", "train", "chain"]})}


with tempfile.TemporaryDirectory() as td:
    r = arms.ARMS["prompt-rhyme-menu"](RHYME_ITEM, ctx(spy_chat, td))
    blob = "\n".join(SEEN)
    menu = r["meta"].get("menu") or []
    check("prompt-rhyme-menu: records the menu it showed, for auditing",
          isinstance(menu, list) and len(menu) >= 3, str(menu))
    check("prompt-rhyme-menu: every menu word really rhymes with the partner",
          all(rhymes_with(w) for w in menu), str(menu))
    check("prompt-rhyme-menu: the menu reaches the prompt",
          all(w in blob for w in menu[:3]), blob[-260:])
    check("prompt-rhyme-menu: still carries the syllable + rhyme constraints",
          "syllable" in blob.lower() and "rhyme" in blob.lower())
    check("prompt-rhyme-menu: returns the model's fills",
          [c["text"] for c in r["candidates"]][:3] == ["pain", "train", "chain"],
          str(r["candidates"]))

# THE leak test: the menu comes from the partner, so changing the hidden answer
# must not change the menu by even one word. (A menu built from the target would
# look like a feature and quietly hand over the answer.)
SEEN.clear()
with tempfile.TemporaryDirectory() as td:
    other = {**RHYME_ITEM, "target": {**RHYME_ITEM["target"], "text": "chain"}}
    m1 = arms.ARMS["prompt-rhyme-menu"](RHYME_ITEM, ctx(spy_chat, td))["meta"]["menu"]
    m2 = arms.ARMS["prompt-rhyme-menu"](other, ctx(spy_chat, td))["meta"]["menu"]
    check("prompt-rhyme-menu: menu is IDENTICAL when the hidden answer changes",
          m1 == m2, f"{m1} vs {m2}")
    check("prompt-rhyme-menu: no prompt reveals the answer as the answer",
          not any(k in "\n".join(SEEN).lower()
                  for k in ("the answer is", "correct word", "target:")))

with tempfile.TemporaryDirectory() as td:
    r = arms.ARMS["prompt-rhyme-menu"](
        RHYME_ITEM, ctx(lambda m, **kw: {"ok": False, "error": "boom"}, td))
    check("prompt-rhyme-menu: provider error → empty candidates, no crash",
          r["candidates"] == [], str(r))


# ── nbest-rerank ────────────────────────────────────────────────────────────────
DRAWS = [["basket"], ["chain"], ["train"], ["pain"], ["basket"]]


def draw_chat(messages, **kw):
    idx = draw_chat.n % len(DRAWS)
    draw_chat.n += 1
    return {"ok": True, "provider": "fake", "model": "draw",
            "content": json.dumps({"fills": DRAWS[idx]})}


draw_chat.n = 0
with tempfile.TemporaryDirectory() as td:
    r = arms.ARMS["nbest-rerank"](RHYME_ITEM, ctx(draw_chat, td))
    out = [c["text"] for c in r["candidates"]]
    check("nbest-rerank: makes several independent draws", draw_chat.n >= 3,
          f"{draw_chat.n} calls")
    check("nbest-rerank: drops draws that fail the rhyme constraint",
          "basket" not in out, str(out))
    check("nbest-rerank: keeps the ones that pass", bool(out), str(out))
    check("nbest-rerank: no duplicates survive", len(out) == len(set(out)), str(out))
    check("nbest-rerank: reports drawn vs kept, so the gate's value is measurable",
          isinstance(r["meta"].get("kept"), int)
          and isinstance(r["meta"].get("drawn"), int)
          and r["meta"]["drawn"] > r["meta"]["kept"], str(r.get("meta")))

draw_chat.n = 0
with tempfile.TemporaryDirectory() as td:
    a = [c["text"] for c in arms.ARMS["nbest-rerank"](
        RHYME_ITEM, ctx(draw_chat, td))["candidates"]]
    draw_chat.n = 0
    b = [c["text"] for c in arms.ARMS["nbest-rerank"](
        RHYME_ITEM, ctx(draw_chat, td))["candidates"]]
    check("nbest-rerank: deterministic under the cache", a == b, f"{a} vs {b}")

draw_chat.n = 0
with tempfile.TemporaryDirectory() as td:
    r = arms.ARMS["nbest-rerank"](
        RHYME_ITEM, ctx(lambda m, **kw: {"ok": True, "content": "not json"}, td))
    check("nbest-rerank: unparseable draws → empty, never a fabricated candidate",
          r["candidates"] == [], str(r))


# ── registry hygiene ────────────────────────────────────────────────────────────
for name in ("rhyme-floor", "prompt-rhyme-menu", "nbest-rerank"):
    check(f"{name}: registered with a version",
          name in arms.ARMS and arms.ARM_VERSIONS.get(name),
          str(arms.ARM_VERSIONS.get(name)))

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
