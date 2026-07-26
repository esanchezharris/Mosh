"""The arm registry + built-in arms (FMS lyrics-bench I1).

An arm is `fn(item, ctx) -> {"candidates": [{"text": ...}, ...], "meta": {...}}`.
Bracket discipline (kill-shot style): `oracle` is the ceiling AND the judge-sanity
probe; `freq-floor` is the floor — a metric that doesn't separate them is broken.
`llm-zeroshot` / `llm-constrained` are the first real baselines; `product-llm`
wraps the SHIPPED lyrics.core loop so every future arm is measured against the
product as it exists today.

Blindness rule: no arm prompt may contain the held-out answer — pinned by
runner_test's spy-chat check.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

from lyrics.bench.mask import STOP_AND_FILLER, tokenize

ARM_VERSIONS: Dict[str, str] = {}
ARMS: Dict[str, Callable] = {}


def register(name: str, version: str):
    def deco(fn):
        ARMS[name] = fn
        ARM_VERSIONS[name] = version
        return fn
    return deco


@dataclass
class ArmContext:
    chat: Optional[Callable] = None      # brain_client.chat_json-shaped callable
    pron: object = None
    freq: Dict[str, int] = field(default_factory=dict)
    k: int = 5
    cache: object = None                 # llm_cache.Cache
    product_backend: str = "llm"         # "fake" pins hermetic runs

    def cached_chat(self, messages: List[dict], **kw) -> dict:
        payload = {"messages": messages, **{k: v for k, v in sorted(kw.items())}}
        if self.cache is None:
            return self.chat(messages, **kw)
        return self.cache.cached_call(payload, lambda: self.chat(messages, **kw))


def _rhyme_menu(item: dict, ctx: ArmContext, max_n: int = 40) -> List[str]:
    """Real rhymes of the item's PARTNER word at the required syllable count.

    Derived from `constraints.rhymeWith` and nothing else — never from the held
    -out target. The menu is allowed to CONTAIN the true word (it is one of the
    partner's rhymes, and finding it there is the skill being measured); what
    would be a leak is the menu changing when the hidden answer changes, which
    `arms_test` pins directly.

    Shared by the floor and the prompt arm so the two cannot drift apart — the
    comparison between them is only meaningful if they see the same candidates.
    """
    con = item.get("constraints") or {}
    partner = con.get("rhymeWith")
    if not partner or ctx.pron is None:
        return []
    syllables = con.get("syllables") if item.get("granularity") in ("word", "rhyme") \
        else None
    strictness = con.get("rhymeStrictness", "slant")
    # rhyme_search scans the whole lexicon, so it is the cost of a sweep, and
    # the floor and the prompt arm ask for the SAME menus over the same items.
    key = (id(ctx.pron), partner.lower(), strictness, syllables, max_n)
    if key in _MENU_MEMO:
        return _MENU_MEMO[key]
    try:
        menu = ctx.pron.rhyme_search(partner, strictness, max_n=max_n,
                                     syllables=syllables)
    except Exception:  # noqa: BLE001 — a lexicon miss is an empty menu, not a crash
        menu = []
    # Function words dominate any corpus frequency table and many of them
    # technically slant-rhyme, so an unfiltered menu ranked by frequency answers
    # 'been', 'an', 'a', 'they', 'but' — found by reading 400 real floor picks.
    # No writer ends a bar there, and a floor that weak flatters every arm it is
    # compared against. `freq-floor` has always applied this filter.
    out = [w for w in menu if w and len(w) >= 3 and w.lower() not in STOP_AND_FILLER]
    _MENU_MEMO[key] = out
    return out


_MENU_MEMO: Dict[tuple, List[str]] = {}


def _dedupe_cap(fills: List[str], k: int) -> List[dict]:
    seen, out = set(), []
    for f in fills:
        f = (f or "").strip()
        key = f.lower()
        if f and key not in seen:
            seen.add(key)
            out.append({"text": f})
        if len(out) >= k:
            break
    return out


# ── brackets ─────────────────────────────────────────────────────────────────────

@register("oracle", "v1")
def arm_oracle(item: dict, ctx: ArmContext) -> dict:
    return {"candidates": [{"text": item["target"]["text"]}], "meta": {}}


@register("freq-floor", "v1")
def arm_freq_floor(item: dict, ctx: ArmContext) -> dict:
    common = [w for w, _ in sorted(ctx.freq.items(), key=lambda kv: (-kv[1], kv[0]))
              if len(w) >= 3 and w not in STOP_AND_FILLER]
    word = common[0] if common else "money"
    gran = item["granularity"]
    if gran == "line":
        text = item["context"]["before"][-1]     # repeat-a-context-line floor
    elif gran == "span":
        n = item["target"]["tokenSpan"][1] - item["target"]["tokenSpan"][0]
        text = " ".join([word] * n)
    else:
        text = word
    return {"candidates": [{"text": text}], "meta": {"word": word}}


# v2: stopwords excluded from the menu (v1 answered "been"/"an"/"a" —
# frequent function words that technically slant-rhyme) and PERFECT
# rhymes ranked above slant ones. A behaviour change without a version
# bump is invisible: the runner keys its cache on (arm, version, item),
# so v1 results replayed and the first "fixed" run was byte-identical.
@register("rhyme-floor", "v2")
def arm_rhyme_floor(item: dict, ctx: ArmContext) -> dict:
    """The HONEST floor for rhyme items: real rhymes of the partner, commonest
    first. Zero API.

    `freq-floor` answers with a frequent word that usually does not rhyme at
    all — it scores 0.0 on rhyme items, which silently flatters every LLM arm
    compared against it. The question an arm actually has to answer is not "can
    you rhyme" (phonology can, for free) but "can you pick a BETTER rhyme than
    the obvious one", and that needs this baseline to be visible.
    """
    menu = _rhyme_menu(item, ctx, max_n=200)
    if not menu:
        return arm_freq_floor(item, ctx)          # no partner → the old floor
    # `rhyme_search` already returns PERFECT rhymes before slant ones. Sorting
    # the whole menu by frequency throws that ordering away — measured on 400
    # real items it cost the floor 15.5% rhyme_perfect against llm-constrained's
    # 50%, i.e. it quietly flattered the very arms this floor exists to test. A
    # floor should be as strong as free phonology can make it.
    order = {w: i for i, w in enumerate(menu)}
    grade = _perfect_set(item, menu, ctx)
    ranked = sorted(menu, key=lambda w: (0 if w in grade else 1,
                                         -ctx.freq.get(w, 0), order[w]))
    return {"candidates": _dedupe_cap(ranked, ctx.k),
            "meta": {"menuSize": len(menu), "perfect": len(grade)}}


def _perfect_set(item: dict, menu: List[str], ctx: ArmContext) -> set:
    from phonology.core import rhyme_grade
    partner = (item.get("constraints") or {}).get("rhymeWith") or ""
    pp = ctx.pron.phones(partner) if partner else None
    if not pp:
        return set()
    return {w for w in menu
            if (ctx.pron.phones(w) and rhyme_grade(ctx.pron.phones(w), pp)
                == "perfect")}


# ── LLM prompt arms ──────────────────────────────────────────────────────────────

_SYSTEM = ("You are a skilled rap lyricist helping finish a verse. "
           "Reply ONLY with JSON: {\"fills\": [\"...\", ...]} — up to %d options, "
           "best first. Authentic register: slang and explicit language are fine.")


def _context_block(item: dict) -> str:
    parts = []
    if item["context"]["before"]:
        parts.append("\n".join(item["context"]["before"]))
    if item["granularity"] == "line":
        parts.append("[write the missing line here]")
    else:
        parts.append(f'Line with a gap: "{item["context"]["maskedLine"]}"')
    if item["context"]["after"]:
        parts.append("\n".join(item["context"]["after"]))
    return "\n".join(parts)


def _constraint_block(item: dict) -> str:
    con, gran = item["constraints"], item["granularity"]
    bits = []
    if gran == "line":
        bits.append(f"Write exactly one line of about {con['lineSyllableTarget']} "
                    f"syllables (±{con['syllableTol']}).")
    else:
        n_tokens = (con.get("syllables"), con.get("syllableTol"))
        blanks = item["context"]["maskedLine"].count("____")
        bits.append(f"The fill replaces {blanks} word(s) and must total "
                    f"{n_tokens[0]} syllable(s) (±{n_tokens[1]}).")
    if con.get("rhymeWith"):
        bits.append(f'It must {con.get("rhymeStrictness", "slant")}-rhyme with '
                    f'"{con["rhymeWith"]}".')
    return " ".join(bits)


def _parse_fills(resp: dict) -> List[str]:
    if not resp.get("ok"):
        return []
    content = resp.get("content") or ""
    try:
        data = json.loads(content)
    except Exception:  # noqa: BLE001 — salvage a fills array inside prose
        m = re.search(r"\{.*\}", content, re.S)
        if not m:
            return []
        try:
            data = json.loads(m.group(0))
        except Exception:  # noqa: BLE001
            return []
    fills = data.get("fills") if isinstance(data, dict) else None
    return [f for f in fills if isinstance(f, str)] if isinstance(fills, list) else []


def _llm_messages(item: dict, ctx: ArmContext, constrained: bool) -> List[dict]:
    """The generation turn, factored out so `fusion-rerank` can issue the exact
    same call `llm-constrained` does — byte-identical messages mean the response
    cache HITS and the fusion's generation half costs nothing extra."""
    prompt = _context_block(item)
    if constrained:
        prompt += "\n" + _constraint_block(item)
    return [{"role": "system", "content": _SYSTEM % ctx.k},
            {"role": "user", "content": prompt}]


def _llm_arm(item: dict, ctx: ArmContext, constrained: bool) -> dict:
    messages = _llm_messages(item, ctx, constrained)
    resp = ctx.cached_chat(messages, max_tokens=300, temperature=0.9)
    fills = _parse_fills(resp)
    return {"candidates": _dedupe_cap(fills, ctx.k),
            "meta": {"provider": resp.get("provider"), "model": resp.get("model")}}


@register("llm-zeroshot", "v1")
def arm_llm_zeroshot(item: dict, ctx: ArmContext) -> dict:
    return _llm_arm(item, ctx, constrained=False)


@register("llm-constrained", "v1")
def arm_llm_constrained(item: dict, ctx: ArmContext) -> dict:
    return _llm_arm(item, ctx, constrained=True)


# ── I3a: the rhyme-word optimization arms ────────────────────────────────────────

@register("prompt-rhyme-menu", "v1")
def arm_prompt_rhyme_menu(item: dict, ctx: ArmContext) -> dict:
    """`llm-constrained` plus the actual list of words that rhyme.

    The bet: most of the arm's failure at the rhyme slot is RECALL, not taste —
    the model cannot enumerate rhymes of an arbitrary word reliably, while the
    phonology engine can do it exactly and for free. Handing over the menu
    changes the model's job from remembering to choosing. The menu is capped and
    frequency-ordered so it reads as a palette rather than a wall.
    """
    menu = _rhyme_menu(item, ctx, max_n=40)
    prompt = _context_block(item) + "\n" + _constraint_block(item)
    if menu:
        ordered = sorted(menu, key=lambda w: (-ctx.freq.get(w, 0), w))[:24]
        prompt += ("\nWords that genuinely rhyme here (you may use one, or any "
                   "other word that rhymes as well): " + ", ".join(ordered))
    messages = [{"role": "system", "content": _SYSTEM % ctx.k},
                {"role": "user", "content": prompt}]
    resp = ctx.cached_chat(messages, max_tokens=300, temperature=0.9)
    return {"candidates": _dedupe_cap(_parse_fills(resp), ctx.k),
            "meta": {"provider": resp.get("provider"), "model": resp.get("model"),
                     "menu": menu}}


NBEST_DRAWS = 5


def _passes_constraints(item: dict, fill: str, ctx: ArmContext) -> bool:
    """The same deterministic checks the scoreboard grades on — reused as a hard
    gate so the arm cannot be rewarded for a candidate the metric will reject."""
    from lyrics.bench.metrics import score_item
    row = score_item(item, [fill], ctx.pron)
    fits = [row[k] for k in ("syl_fit", "rhyme_fit") if row.get(k) is not None]
    return bool(fits) and all(fits)


@register("nbest-rerank", "v1")
def arm_nbest_rerank(item: dict, ctx: ArmContext) -> dict:
    """N independent draws, hard-gated by the validator, then ranked.

    Reports `drawn` and `kept` so the gate's contribution is measured rather
    than assumed: if kept ≈ drawn the validator is buying nothing here, and the
    extra draws are the only thing working.
    """
    seen: List[str] = []
    drawn = 0
    for i in range(NBEST_DRAWS):
        prompt = _context_block(item) + "\n" + _constraint_block(item)
        messages = [{"role": "system", "content": _SYSTEM % ctx.k},
                    {"role": "user", "content": prompt},
                    # Vary the cache key per draw; without this every "independent"
                    # draw would be one cached response wearing five hats.
                    {"role": "system", "content": f"draw {i + 1}"}]
        resp = ctx.cached_chat(messages, max_tokens=300, temperature=1.0)
        for fill in _parse_fills(resp):
            drawn += 1
            if fill not in seen:
                seen.append(fill)
    kept = [f for f in seen if _passes_constraints(item, f, ctx)]
    ranked = sorted(kept, key=lambda f: (-_depth_of(item, f, ctx), seen.index(f)))
    return {"candidates": _dedupe_cap(ranked, ctx.k),
            "meta": {"drawn": drawn, "kept": len(kept)}}


_RERANK_SYSTEM = (
    "You are a skilled rap lyricist choosing the best word to finish a bar. "
    "Every option below ALREADY rhymes correctly — rhyme is settled, do not "
    "judge on it. Choose purely on MEANING: which word actually makes sense in "
    "this verse, sounds like something a real artist would say here, and lands "
    "an idea. Reply ONLY as JSON: {\"fills\": [\"...\", ...]} — up to %d of the "
    "given options, best first. Use ONLY words from the list. Slang and "
    "explicit language are normal here.")


@register("fusion-rerank", "v1")
def arm_fusion_rerank(item: dict, ctx: ArmContext) -> dict:
    """Phonology proposes, the LLM disposes — ranked on MEANING.

    Measured ceiling on 150 real dev items: the artist's word sits in the LLM's
    own top-5 48.0% of the time and in the phonology menu 40.0%, but in EITHER
    **64.7%**, against 37.3% actually picked. The two sources miss *different*
    words, so the union is worth +27 points if anything can rank it.

    Ranking on MEANING rather than rhyme is not a guess: the owner's sitting
    rated a perfect rhyme that ignores sense as not working 71% of the time,
    while the artist's real word read as keepable 86% of the time. So the
    reranker is told rhyme is already settled.

    Why this is not `prompt-rhyme-menu` again: that arm put the menu in the
    GENERATION prompt, which anchored the model onto dictionary rhymes and moved
    `rhyme_perfect` +16.7 pts without moving `exact`. Here generation stays
    unanchored — the identical call `llm-constrained` makes, so it is a cache
    hit — and the menu only widens the pool that a second pass ranks.
    """
    gen = _llm_arm(item, ctx, constrained=True)
    semantic = [c["text"] for c in gen.get("candidates", [])]

    menu = _rhyme_menu(item, ctx, max_n=40)
    ranked_menu = sorted(menu, key=lambda w: (-ctx.freq.get(w, 0), w))[:12]

    # Order the pool by hash, not by source. Listing the model's own guesses
    # first would invite it to simply re-pick them, which is the anchoring that
    # sank the menu arm — in reverse.
    pool: List[str] = []
    seen = set()
    for word in sorted(semantic + ranked_menu,
                       key=lambda w: hashlib.blake2b(w.lower().encode("utf-8"),
                                                     digest_size=8).digest()):
        if word and word.lower() not in seen:
            seen.add(word.lower())
            pool.append(word)
    meta = {"nSemantic": len(semantic), "nMenu": len(ranked_menu),
            "nPool": len(pool), "pool": pool, "reranked": False, "invented": 0}
    if not pool:
        return {"candidates": [], "meta": meta}

    body = (_context_block(item) + "\n" + _constraint_block(item)
            + "\n\nOptions (all of these already rhyme): " + ", ".join(pool)
            + "\nRank them by MEANING in this verse.")
    messages = [{"role": "system", "content": _RERANK_SYSTEM % ctx.k},
                {"role": "user", "content": body}]
    resp = ctx.cached_chat(messages, max_tokens=200, temperature=0.0)
    picks = _parse_fills(resp)

    lowered = {w.lower(): w for w in pool}
    kept, invented = [], 0
    for p in picks:
        key = (p or "").strip().lower()
        if key in lowered:
            kept.append(lowered[key])
        elif key:
            invented += 1          # a word that was never on offer: not a rerank
    meta["invented"] = invented
    if not kept:
        # Reranker unusable — fall back to the generation order, which is what
        # llm-constrained would have returned. Degrading to the pool's hash
        # order would be worse than the arm we already have.
        return {"candidates": _dedupe_cap(semantic or pool, ctx.k), "meta": meta}
    meta["reranked"] = True
    return {"candidates": _dedupe_cap(kept, ctx.k), "meta": meta}


def _depth_of(item: dict, fill: str, ctx: ArmContext) -> int:
    """Multisyllabic rhyme depth — the tie-break that prefers a SKILLED rhyme
    over the first merely-valid one, and the same axis the scoreboard watches to
    catch an arm drifting toward blandness."""
    from lyrics.bench.metrics import _rhyme_metrics
    return _rhyme_metrics(item, fill, ctx.pron).get("multi_depth") or 0


# ── the shipped product loop as an arm ───────────────────────────────────────────

def _product_spec(item: dict, ctx: ArmContext) -> dict:
    """Rebuild a LineSpec sheet around the masked item: context lines land as
    finalized (anchor-bearing) lines; the masked line is the one gap. When the
    rhyme partner is not among the visible lines, a minimal finalized line ending
    in the partner word carries the group anchor — the same information every
    other arm receives via constraints.rhymeWith."""
    con, gran = item["constraints"], item["granularity"]
    lines, idx = [], 0
    partner = con.get("rhymeWith")
    partner_visible = False

    def ends_with_partner(line: str) -> bool:
        toks = tokenize(line)
        return bool(partner and toks and toks[-1].lower() == partner.lower())

    for line in item["context"]["before"]:
        entry = {"index": idx, "text": line, "locked": True}
        if ends_with_partner(line):
            entry["rhymeGroup"] = "A"
            partner_visible = True
        lines.append(entry)
        idx += 1

    if gran == "line":
        target = con["lineSyllableTarget"]
        gap = {"index": idx, "seedText": "", "syllableTarget": target,
               "syllableTol": con["syllableTol"]}
    else:
        visible = sum(ctx.pron.syllables(t)
                      for t in tokenize(item["context"]["maskedLine"]))
        target = visible + (con.get("syllables") or 0)
        # core._tokens splits on whitespace and only treats a PURE "_{2,}" token
        # as a gap — strip glued punctuation ("____," would become a locked word,
        # and at line end the group's fixed rhyme anchor).
        seed = " ".join("____" if re.search(r"_{2,}", t) else t
                        for t in item["context"]["maskedLine"].split())
        gap = {"index": idx, "seedText": seed,
               "syllableTarget": target, "syllableTol": con["syllableTol"]}
    if partner:
        gap["rhymeGroup"] = "A"
    gap_index = idx
    lines.append(gap)
    idx += 1

    for line in item["context"]["after"]:
        entry = {"index": idx, "text": line, "locked": True}
        if not partner_visible and ends_with_partner(line):
            entry["rhymeGroup"] = "A"
            partner_visible = True
        lines.append(entry)
        idx += 1

    if partner and not partner_visible:
        lines.append({"index": idx, "text": partner, "locked": True,
                      "rhymeGroup": "A"})

    return {"grid": "1/16", "explicit": "allow",
            "rhymeStrictness": con.get("rhymeStrictness", "slant"),
            "lines": lines, "_gapIndex": gap_index}


# The whole blank region, punctuation-tolerant: "____", "____ ____ ____", and
# "____, ____" all match as ONE run. NEVER locate blanks via tokenize() — its
# word regex ([A-Za-z']+) silently drops underscore tokens (review blocker).
_BLANK_REGION = re.compile(r"_{2,}(?:[^\w]+_{2,})*")


def _extract_fill(item: dict, proposal_text: str) -> str:
    """Pull the fill back out of a full-line proposal by aligning the visible
    prefix/suffix tokens around the blank region; fall back to the whole
    proposal when alignment fails (scored as-is — honestly, not charitably)."""
    if item["granularity"] == "line":
        return proposal_text
    masked = item["context"]["maskedLine"]
    m = _BLANK_REGION.search(masked)
    if not m:
        return proposal_text
    prefix = [t.lower() for t in tokenize(masked[:m.start()])]
    suffix = [t.lower() for t in tokenize(masked[m.end():])]
    prop = tokenize(proposal_text)
    lowered = [t.lower() for t in prop]
    if (lowered[:len(prefix)] == prefix
            and (not suffix or lowered[len(lowered) - len(suffix):] == suffix)):
        mid = prop[len(prefix):len(prop) - len(suffix)] if suffix else prop[len(prefix):]
        if mid:
            return " ".join(mid)
    return proposal_text


@register("product-llm", "v2")  # v2: blank-region extraction + seed normalization
def arm_product(item: dict, ctx: ArmContext) -> dict:
    from lyrics import core as product_core
    spec = _product_spec(item, ctx)
    gap_index = spec.pop("_gapIndex")
    res = product_core.fill_gap(spec, gap_index, backend=ctx.product_backend)
    fills: List[str] = []
    for entry in res.get("lines", []):
        if entry["index"] != gap_index:
            continue
        for p in entry.get("proposals", []):
            fills.append(_extract_fill(item, p.get("text", "")))
    return {"candidates": _dedupe_cap(fills, ctx.k),
            "meta": {"backend": res.get("backend")}}
