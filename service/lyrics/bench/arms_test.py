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


# ── fusion-rerank: phonology proposes, the LLM disposes ─────────────────────────
# Measured ceiling on 150 real items: the artist's word is in the LLM's own top-5
# 48.0% of the time and in the phonology menu 40.0%, but in EITHER 64.7% — against
# 37.3% actually picked. The two sources miss different words, so the union is
# worth +27 pts if something can rank it. The owner's ear said that ranking must
# be by MEANING: a perfect rhyme that ignores sense was rejected 71% of the time.
FUSION_CALLS = []


def fusion_chat(messages, **kw):
    FUSION_CALLS.append(json.dumps(messages))
    body = json.dumps(messages).lower()
    if "rank" in body or "makes sense" in body or "meaning" in body:
        # the rerank turn — put a menu word first to prove the union is used
        return {"ok": True, "content": json.dumps({"fills": ["train", "pain"]})}
    return {"ok": True, "content": json.dumps({"fills": ["pain", "chain"]})}


with tempfile.TemporaryDirectory() as td:
    r = arms.ARMS["fusion-rerank"](RHYME_ITEM, ctx(fusion_chat, td))
    out = [c["text"] for c in r["candidates"]]
    check("fusion: makes a generation call AND a rerank call",
          len(FUSION_CALLS) == 2, f"{len(FUSION_CALLS)} calls")
    check("fusion: the GENERATION call is byte-identical to llm-constrained's, "
          "so it is a cache hit and costs nothing extra",
          FUSION_CALLS[0] == json.dumps(
              arms._llm_messages(RHYME_ITEM, ctx(fusion_chat, td), constrained=True)),
          FUSION_CALLS[0][:120])
    rerank = FUSION_CALLS[1]
    check("fusion: the rerank prompt carries the LLM's own candidates",
          "chain" in rerank, rerank[-260:])
    check("fusion: the rerank prompt also carries phonology's candidates",
          any(w in rerank for w in ("pane", "train")), rerank[-260:])
    check("fusion: the rerank prompt asks for MEANING, and says rhyme is settled",
          ("meaning" in rerank.lower() or "sense" in rerank.lower())
          and "rhyme" in rerank.lower(), rerank[-300:])
    check("fusion: returns the reranked order", out[:2] == ["train", "pain"], str(out))
    check("fusion: reports what each source contributed",
          isinstance(r["meta"].get("nSemantic"), int)
          and isinstance(r["meta"].get("nMenu"), int)
          and isinstance(r["meta"].get("nPool"), int), str(r.get("meta")))

# The reranker must not invent: a word outside the pool is dropped and counted.
with tempfile.TemporaryDirectory() as td:
    def invents(messages, **kw):
        body = json.dumps(messages).lower()
        if "rank" in body or "meaning" in body:
            return {"ok": True, "content": json.dumps(
                {"fills": ["helicopter", "pain"]})}
        return {"ok": True, "content": json.dumps({"fills": ["pain"]})}
    r = arms.ARMS["fusion-rerank"](RHYME_ITEM, ctx(invents, td))
    out = [c["text"] for c in r["candidates"]]
    check("fusion: a reranked word that was never in the pool is dropped",
          "helicopter" not in out, str(out))
    check("fusion: invention is counted, not silently swallowed",
          r["meta"].get("invented") == 1, str(r.get("meta")))

# Degradation, both directions.
with tempfile.TemporaryDirectory() as td:
    def rerank_dies(messages, **kw):
        body = json.dumps(messages).lower()
        if "rank" in body or "meaning" in body:
            return {"ok": False, "error": "boom"}
        return {"ok": True, "content": json.dumps({"fills": ["pain", "chain"]})}
    r = arms.ARMS["fusion-rerank"](RHYME_ITEM, ctx(rerank_dies, td))
    check("fusion: rerank failure falls back to the generated order, not empty",
          [c["text"] for c in r["candidates"]][:2] == ["pain", "chain"], str(r))
    check("fusion: the fallback is recorded", r["meta"].get("reranked") is False,
          str(r.get("meta")))

with tempfile.TemporaryDirectory() as td:
    def gen_dies(messages, **kw):
        body = json.dumps(messages).lower()
        if "rank" in body or "meaning" in body:
            return {"ok": True, "content": json.dumps({"fills": ["train"]})}
        return {"ok": False, "error": "boom"}
    r = arms.ARMS["fusion-rerank"](RHYME_ITEM, ctx(gen_dies, td))
    check("fusion: generation failure still yields phonology candidates",
          [c["text"] for c in r["candidates"]][:1] == ["train"], str(r))

# Same leak rule as the menu arm: the pool MAY contain the true word — finding it
# is the skill — but it must not CHANGE when the hidden answer changes.
with tempfile.TemporaryDirectory() as td:
    other = {**RHYME_ITEM, "target": {**RHYME_ITEM["target"], "text": "chain"}}
    p1 = arms.ARMS["fusion-rerank"](RHYME_ITEM, ctx(fusion_chat, td))["meta"]["pool"]
    p2 = arms.ARMS["fusion-rerank"](other, ctx(fusion_chat, td))["meta"]["pool"]
    check("fusion: the pool is IDENTICAL when the hidden answer changes",
          p1 == p2, f"{p1} vs {p2}")

with tempfile.TemporaryDirectory() as td:
    a = [c["text"] for c in arms.ARMS["fusion-rerank"](
        RHYME_ITEM, ctx(fusion_chat, td))["candidates"]]
    b = [c["text"] for c in arms.ARMS["fusion-rerank"](
        RHYME_ITEM, ctx(fusion_chat, td))["candidates"]]
    check("fusion: deterministic under the cache", a == b, f"{a} vs {b}")


# ── the freq-ranked pool (2026-07-27 truncation fix) ────────────────────────────
# Alphabetical truncation held 40.0% of true answers at cap 200; frequency
# truncation held 89.3% of the SAME candidate set. These guards pin the freq
# path's three load-bearing properties: ordering, filter-before-cap, and memo
# separation from the alpha path. The fixture makes alpha and freq orders
# genuinely differ — a fixture where they coincide could not catch a sabotage
# that ignores `rank`.


def _menu_item(target="pain", partner="rain"):
    return {"itemId": f"t:{target}", "granularity": "rhyme", "songId": "gs:1",
            "target": {"text": target},
            "context": {"before": [], "maskedLine": "____", "after": []},
            "constraints": {"syllables": 1, "rhymeWith": partner,
                            "rhymeStrictness": "slant"}}


_mctx = arms.ArmContext(pron=PRON, freq=FREQ, k=5)
_alpha = arms._rhyme_menu(_menu_item(), _mctx, max_n=10, rank="alpha")
_freqm = arms._rhyme_menu(_menu_item(), _mctx, max_n=10, rank="freq")
check("freq menu: same candidate set as alpha, different order",
      sorted(_alpha) == sorted(_freqm) and _alpha != _freqm,
      f"alpha={_alpha} freq={_freqm}")
check("freq menu: commonest first within a grade (train=90 leads)",
      _freqm and _freqm[0] == "train", str(_freqm))
check("menu memo separates the two ranks (same ctx, same partner, same cap)",
      arms._rhyme_menu(_menu_item(), _mctx, max_n=10, rank="alpha") == _alpha
      and arms._rhyme_menu(_menu_item(), _mctx, max_n=10, rank="freq") == _freqm,
      "a memo key without `rank` replays one ordering as the other")
# The memo must be BYPASSED here or this check is vacuous: a target-dependent
# mutation that runs before memoization gets replayed verbatim to the second
# call (same partner ⇒ same key ⇒ memo hit), so the two lists compare equal
# with a live leak in the code. Proven by sabotage: promote the target one slot
# pre-memo — with the memo warm this check passed; cleared, it goes red.
_mctx.menu_memo.clear()
_leak_a = arms._rhyme_menu(_menu_item(target="pain"), _mctx, max_n=10, rank="freq")
_mctx.menu_memo.clear()
_leak_b = arms._rhyme_menu(_menu_item(target="pane"), _mctx, max_n=10, rank="freq")
_mctx.menu_memo.clear()
_leak_c = arms._rhyme_menu(_menu_item(target="zzznotaword"), _mctx, max_n=10,
                           rank="freq")
check("freq menu: NO LEAK — cold menus identical as the hidden answer varies",
      _leak_a == _leak_b == _leak_c == _freqm,
      f"a={_leak_a} b={_leak_b} c={_leak_c} memoized={_freqm}")
_mctx.menu_memo.clear()          # cold, or this is a memo hit proving nothing
check("freq menu is deterministic across COLD calls",
      arms._rhyme_menu(_menu_item(), _mctx, max_n=10, rank="freq") == _freqm)

# Filter-before-cap: a stopword with a huge corpus count must not consume a cap
# slot. The injected lexicon deliberately pronounces the stopword 'when' into
# the rime family — with filter-after-cap the cap keeps [when, main], the filter
# then deletes 'when', and 'vain' is silently gone.
from phonology.core import Pronouncer  # noqa: E402
_stop_pron = Pronouncer(lexicon={
    "rain": [["R", "EY1", "N"]], "main": [["M", "EY1", "N"]],
    "vain": [["V", "EY1", "N"]], "when": [["W", "EY1", "N"]],
}, g2p=lambda w: None)
_stop_ctx = arms.ArmContext(pron=_stop_pron,
                            freq={"when": 1000, "main": 5, "vain": 3}, k=5)
check("freq menu: stopword filter runs BEFORE the cap",
      arms._rhyme_menu(_menu_item(), _stop_ctx, max_n=2, rank="freq")
      == ["main", "vain"],
      str(arms._rhyme_menu(_menu_item(), _stop_ctx, max_n=2, rank="freq")))

_bad = arms.ArmContext(pron=PRON, freq={}, k=5)
try:
    arms._rhyme_menu(_menu_item(), _bad, max_n=10, rank="freq")
    check("freq menu: empty freq table raises rather than silently degrading",
          False, "no exception")
except ValueError:
    check("freq menu: empty freq table raises rather than silently degrading",
          True)
try:
    arms._rhyme_menu(_menu_item(), _mctx, max_n=10, rank="wat")
    check("freq menu: unknown rank raises", False, "no exception")
except ValueError:
    check("freq menu: unknown rank raises", True)
# Config errors must fire even when the item has NO partner — the no-partner
# early return used to swallow them (2026-07-28 review).
try:
    arms._rhyme_menu(_nopartner_item := {**_menu_item(),
                     "constraints": {"rhymeWith": None}}, _mctx,
                     max_n=10, rank="wat")
    check("rank validation fires before the no-partner early return",
          False, "no exception")
except ValueError:
    check("rank validation fires before the no-partner early return", True)

# The ALPHA path's historical semantics, pinned as a golden: rhyme_search sorts
# alphabetically, CAPS, and only then does the stopword filter run — so a
# stopword inside the cap window consumes a slot and the menu comes back SHORT.
# This is deliberately NOT "fixed": every pre-2026-07-27 board number was
# measured against exactly this construction, and its paid cache must keep
# replaying byte-for-byte. Before this golden, flipping alpha to
# filter-before-cap passed every suite ("byte-identical" was only proven by an
# out-of-band cache replay).
_alpha_pron = Pronouncer(lexicon={
    "rain": [["R", "EY1", "N"]], "been": [["B", "EY1", "N"]],   # stopword, sorts first
    "main": [["M", "EY1", "N"]], "vain": [["V", "EY1", "N"]],
}, g2p=lambda w: None)
_alpha_ctx = arms.ArmContext(pron=_alpha_pron, freq={"main": 5, "vain": 3}, k=5)
check("alpha menu GOLDEN: cap first, then filter — stopword eats a cap slot",
      arms._rhyme_menu(_menu_item(), _alpha_ctx, max_n=2, rank="alpha")
      == ["main"],
      str(arms._rhyme_menu(_menu_item(), _alpha_ctx, max_n=2, rank="alpha")))

# prompt-rhyme-menu-fp / -fp200: same prompt shape as the historical arm, freq
# palette. The fixture must show the DIFFERENCE, so assert order + size in the
# actual prompt bytes the spy recorded — a sabotage routing fp through the alpha
# menu, or re-imposing the historical [:24] cut, changes both.
SEEN.clear()
with tempfile.TemporaryDirectory() as td:
    r_fp = arms.ARMS["prompt-rhyme-menu-fp"](_menu_item(), ctx(spy_chat, td))
    fp_blob = SEEN[-1]
    fp_menu = r_fp["meta"].get("menu") or []
    check("prompt-menu-fp: menu is the freq-ranked pool (commonest first)",
          fp_menu[:1] == ["train"] and sorted(fp_menu) == sorted(
              arms._rhyme_menu(_menu_item(), _mctx, max_n=40, rank="freq")),
          str(fp_menu[:5]))
    check("prompt-menu-fp: the WHOLE menu reaches the prompt (no [:24] cut)",
          all(f" {w}" in fp_blob or f'"{w}' in fp_blob or w in fp_blob
              for w in fp_menu),
          fp_blob[-200:])
    check("prompt-menu-fp: prompt lists words in freq order",
          fp_blob.find("train") < fp_blob.find("pane") or "train" not in fp_blob,
          "train (freq 90) must precede pane (freq 40) in the palette")
SEEN.clear()
with tempfile.TemporaryDirectory() as td:
    r_200 = arms.ARMS["prompt-rhyme-menu-fp200"](_menu_item(), ctx(spy_chat, td))
    m200 = r_200["meta"].get("menu") or []
    check("prompt-menu-fp200: draws from the 200 cap",
          sorted(m200) == sorted(
              arms._rhyme_menu(_menu_item(), _mctx, max_n=200, rank="freq")),
          f"n={len(m200)}")

# Fixture adequacy: the testlex rime family has ~11 words, so a re-imposed
# historical [:24] palette cut — or fp200 quietly narrowing to the 40 pool —
# would be INVISIBLE above. This synthetic 45-word family makes both cuts bite.
_big_lex = {"rain": [["R", "EY1", "N"]]}
_big_freq = {}
for _i in range(45):
    _w = f"zane{_i:02d}"
    _big_lex[_w] = [["Z", "EY1", "N"]]
    _big_freq[_w] = 1000 - _i          # strictly descending ⇒ deterministic order
def _big_spy(messages, **kw):
    SEEN.append(json.dumps(messages))
    return {"ok": True, "provider": "fake", "model": "spy",
            "content": json.dumps({"fills": ["zane00"]})}


_big_ctx = arms.ArmContext(chat=_big_spy,
                           pron=Pronouncer(lexicon=_big_lex, g2p=lambda w: None),
                           freq=_big_freq, k=5)


SEEN.clear()
_r40 = arms._prompt_rhyme_menu(_menu_item(), _big_ctx, rank="freq",
                               menu_n=40, show_n=40)
check("prompt-menu-fp on a 45-word family: exactly 40 drawn, ALL 40 in prompt",
      len(_r40["meta"]["menu"]) == 40
      and all(w in SEEN[-1] for w in _r40["meta"]["menu"])
      and "zane39" in SEEN[-1] and "zane40" not in SEEN[-1],
      f"menu n={len(_r40['meta']['menu'])}")
SEEN.clear()
_r200 = arms._prompt_rhyme_menu(_menu_item(), _big_ctx, rank="freq",
                                menu_n=200, show_n=200)
check("prompt-menu-fp200 on a 45-word family: all 45 drawn and shown",
      len(_r200["meta"]["menu"]) == 45 and "zane44" in SEEN[-1],
      f"menu n={len(_r200['meta']['menu'])}")
# Through the REGISTERED wrappers, asserting prompt CONTENT — the direct-helper
# calls above cannot catch a wrapper that quietly changes show_n (the menu meta
# stays 40 while the palette in the prompt shrinks).
SEEN.clear()
_w40 = arms.ARMS["prompt-rhyme-menu-fp"](_menu_item(), _big_ctx)
check("fp wrapper on the big family: 40 drawn AND word #40 is in the prompt",
      len(_w40["meta"]["menu"]) == 40 and "zane39" in SEEN[-1]
      and "zane40" not in SEEN[-1],
      f"menu n={len(_w40['meta']['menu'])}, zane39 in prompt: "
      f"{'zane39' in SEEN[-1]}")
SEEN.clear()
_w200 = arms.ARMS["prompt-rhyme-menu-fp200"](_menu_item(), _big_ctx)
check("fp200 wrapper on the big family: 45 drawn AND word #45 is in the prompt",
      len(_w200["meta"]["menu"]) == 45 and "zane44" in SEEN[-1])

# rhyme-floor-fp: the no-model control is the freq pool's head, verbatim.
# The floor uses the arm-standard 200 cap, not the 10 cap the ordering checks
# used above — compare against the menu it actually draws from.
_floor_menu = arms._rhyme_menu(_menu_item(), _mctx, max_n=200, rank="freq")
_fp = arms.ARMS["rhyme-floor-fp"](_menu_item(), _mctx)
_fp_words = [c["text"] for c in _fp["candidates"]]
check("rhyme-floor-fp: candidates are the freq menu's top-k",
      _fp_words == _floor_menu[:5], f"{_fp_words} vs {_floor_menu[:5]}")
check("rhyme-floor-fp: meta reports menuSize + perfect count",
      _fp["meta"].get("menuSize") == len(_floor_menu)
      and isinstance(_fp["meta"].get("perfect"), int), str(_fp["meta"]))
_nopart = _menu_item()
_nopart["constraints"]["rhymeWith"] = None
check("rhyme-floor-fp: falls back to freq-floor when there is no partner",
      [c["text"] for c in arms.ARMS["rhyme-floor-fp"](_nopart, _mctx)["candidates"]]
      == [c["text"] for c in arms.ARMS["freq-floor"](_nopart, _mctx)["candidates"]])


# ── registry hygiene ────────────────────────────────────────────────────────────
for name in ("rhyme-floor", "prompt-rhyme-menu", "nbest-rerank",
             "fusion-rerank", "rhyme-floor-fp", "local-constrained-endword-fp"):
    check(f"{name}: registered with a version",
          name in arms.ARMS and arms.ARM_VERSIONS.get(name),
          str(arms.ARM_VERSIONS.get(name)))

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
