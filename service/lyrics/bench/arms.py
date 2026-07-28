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
    local: object = None                 # localgen.Worker (or an injected stand-in)
    local_cfg: object = None             # localgen.LocalConfig
    # Folded into the arm-result cache key by the runner (only when non-empty) and
    # echoed into the summary. Model id / revision / quant / mode live here rather
    # than in the arm NAME, so a model swap re-keys the cache without minting a
    # new scoreboard row.
    arm_config: Dict = field(default_factory=dict)

    def cached_chat(self, messages: List[dict], **kw) -> dict:
        payload = {"messages": messages, **{k: v for k, v in sorted(kw.items())}}
        if self.cache is None:
            return self.chat(messages, **kw)
        return self.cache.cached_call(payload, lambda: self.chat(messages, **kw))


# Granularities an arm will actually answer. Absent ⇒ all of them.
#
# This is not documentation: `metrics.score_item` scores an empty candidate list
# as exact=0/topk=0, so an arm that quietly declines an item PUBLISHES a zero it
# did not earn. `bench_cli` refuses a run whose drawn items include a granularity
# the arm declines, and the arm returns status="declined" rather than [].
ARM_GRANULARITIES: Dict[str, tuple] = {}


def register_granularities(name: str, granularities: tuple) -> None:
    ARM_GRANULARITIES[name] = tuple(granularities)


def _rhyme_menu(item: dict, ctx: ArmContext, max_n: int = 40,
                rank: str = "alpha") -> List[str]:
    """Real rhymes of the item's PARTNER word at the required syllable count.

    Derived from `constraints.rhymeWith` and nothing else — never from the held
    -out target. The menu is allowed to CONTAIN the true word (it is one of the
    partner's rhymes, and finding it there is the skill being measured); what
    would be a leak is the menu changing when the hidden answer changes, which
    `arms_test` pins directly.

    Shared by the floor and the prompt arm so the two cannot drift apart — the
    comparison between them is only meaningful if they see the same candidates.

    `rank` picks how the pool is TRUNCATED, which turned out to matter more than
    anything else about it:

      * `"alpha"` — the historical path, byte-for-byte: `rhyme_search` sorts
        (grade, syllables, alphabetical), caps at `max_n`, THEN the stopword
        filter runs. Every arm number on the board before 2026-07-27 was
        measured against this. Truth-in-pool coverage at 200: **40.0%** —
        an alphabetical cap keeps `booz`/`brack` and drops the word the writer
        used.
      * `"freq"` — same candidate set, ranked (grade, syllables, corpus
        frequency desc). The stopword/len filter runs BEFORE the cap — order
        matters here in a way it never did for alpha: stopwords are the most
        frequent words in any corpus, so filtering after a freq-ranked cap
        would let them consume cap slots and then vanish, silently shrinking
        the pool. Coverage at 200: **89.3%** (uncapped phonology roof: 99.3%).
        Requires `ctx.freq`; an empty table raises rather than quietly
        degrading to a differently-ordered pool.
    """
    con = item.get("constraints") or {}
    partner = con.get("rhymeWith")
    if not partner or ctx.pron is None:
        return []
    if rank not in ("alpha", "freq"):
        raise ValueError(f"unknown menu rank {rank!r}")
    if rank == "freq" and not ctx.freq:
        raise ValueError("rank='freq' needs a corpus frequency table in ctx.freq")
    syllables = con.get("syllables") if item.get("granularity") in ("word", "rhyme") \
        else None
    strictness = con.get("rhymeStrictness", "slant")
    # rhyme_search scans the whole lexicon, so it is the cost of a sweep, and
    # the floor and the prompt arm ask for the SAME menus over the same items.
    # The freq table participates in the freq-ranked result, so it joins the key.
    key = (id(ctx.pron), partner.lower(), strictness, syllables, max_n,
           rank, id(ctx.freq) if rank == "freq" else None)
    if key in _MENU_MEMO:
        return _MENU_MEMO[key]
    try:
        if rank == "freq":
            # Uncapped scan; filter, then cap — see the docstring for why the
            # order is load-bearing on this path.
            menu = ctx.pron.rhyme_search(partner, strictness, max_n=10 ** 9,
                                         syllables=syllables, freq=ctx.freq)
        else:
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
    if rank == "freq":
        out = out[:max_n]
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

def _prompt_rhyme_menu(item: dict, ctx: ArmContext, *, rank: str,
                       menu_n: int, show_n: int) -> dict:
    """`llm-constrained` plus the actual list of words that rhyme.

    The bet: most of the arm's failure at the rhyme slot is RECALL, not taste —
    the model cannot enumerate rhymes of an arbitrary word reliably, while the
    phonology engine can do it exactly and for free. Handing over the menu
    changes the model's job from remembering to choosing. The menu is capped and
    frequency-ordered so it reads as a palette rather than a wall.

    The (rank, menu_n, show_n) triple is what the registered variants disagree
    on, and the history matters: the original arm freq-sorts its palette but
    draws it from the ALPHA-truncated 40 — an alphabetically-chosen sliver whose
    truth-coverage is a fraction of the pool's. Its famous "+16.7 rhyme_perfect
    with exact flat" result was measured against a palette that rarely contained
    the answer. The fp variants hand the same prompt a palette that usually does.
    """
    menu = _rhyme_menu(item, ctx, max_n=menu_n, rank=rank)
    prompt = _context_block(item) + "\n" + _constraint_block(item)
    if menu:
        # For rank="freq" the menu is already frequency-ordered and this sort is
        # a stable no-op; for the original arm it is the historical byte-exact
        # palette construction. Do not "simplify" — the original's messages must
        # keep replaying its paid cache verbatim.
        ordered = sorted(menu, key=lambda w: (-ctx.freq.get(w, 0), w))[:show_n]
        prompt += ("\nWords that genuinely rhyme here (you may use one, or any "
                   "other word that rhymes as well): " + ", ".join(ordered))
    messages = [{"role": "system", "content": _SYSTEM % ctx.k},
                {"role": "user", "content": prompt}]
    resp = ctx.cached_chat(messages, max_tokens=300, temperature=0.9)
    return {"candidates": _dedupe_cap(_parse_fills(resp), ctx.k),
            "meta": {"provider": resp.get("provider"), "model": resp.get("model"),
                     "menu": menu}}


@register("prompt-rhyme-menu", "v1")
def arm_prompt_rhyme_menu(item: dict, ctx: ArmContext) -> dict:
    """The historical arm, byte-identical: alpha-truncated 40, top-24 shown."""
    return _prompt_rhyme_menu(item, ctx, rank="alpha", menu_n=40, show_n=24)


@register("prompt-rhyme-menu-fp", "v1")
def arm_prompt_rhyme_menu_fp(item: dict, ctx: ArmContext) -> dict:
    """The controlled twin: same prompt shape, same 40-word budget, palette
    drawn from the freq-ranked pool and shown in full. Isolates menu QUALITY
    at (nearly) fixed menu size."""
    return _prompt_rhyme_menu(item, ctx, rank="freq", menu_n=40, show_n=40)


@register("prompt-rhyme-menu-fp200", "v1")
def arm_prompt_rhyme_menu_fp200(item: dict, ctx: ArmContext) -> dict:
    """The coverage play: the full 200-word freq pool in the prompt — the same
    pool the local constrained arm scores, handed to the strongest available
    ranker. Ceiling = the pool's 90.7% coverage times whatever precision the
    model keeps at 200 options; the fp/fp200 pair traces that frontier."""
    return _prompt_rhyme_menu(item, ctx, rank="freq", menu_n=200, show_n=200)


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


MENU_KEEP = 40

_RERANK_SYSTEM = (
    "You are a skilled rap lyricist choosing the best word to finish a bar. "
    "Every option below ALREADY rhymes correctly — rhyme is settled, do not "
    "judge on it. Choose purely on MEANING: which word actually makes sense in "
    "this verse, sounds like something a real artist would say here, and lands "
    "an idea. Reply ONLY as JSON: {\"fills\": [\"...\", ...]} — up to %d of the "
    "given options, best first. Use ONLY words from the list. Slang and "
    "explicit language are normal here.")


# v2: the pool was built from the menu's top 12 by frequency, which threw away
# a chunk of the very ceiling the arm exists to reach — measured, truth-in-pool
# 57.3% at keep=12 vs 64.7% uncapped. keep=40 recovers 63.3% at a median pool of
# 44 options; 80 and uncapped buy under a point each for an unreadable list.
@register("fusion-rerank", "v2")
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

    menu = _rhyme_menu(item, ctx, max_n=200)
    ranked_menu = sorted(menu, key=lambda w: (-ctx.freq.get(w, 0), w))[:MENU_KEEP]

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


# ── WS1: local open-weights arms (we own the decoder) ────────────────────────────

def _seed_sha(item: dict) -> str:
    """Content hash for per-item seeding — over `context` + `constraints` only.

    Deliberately NOT the runner's hash, which also covers `target`: an arm must
    stay blind to the held-out answer, and hashing it (even into a seed that never
    reaches the prompt) is a hole in that. Re-masking the same itemId changes the
    masked line anyway, so the seed still moves when the eval is rebuilt.
    """
    blob = json.dumps({k: item.get(k) for k in ("context", "constraints")},
                      sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _prefix_suffix(item: dict):
    """The bar up to the blank, and whatever follows it.

    Uses the shared blank regex — NEVER `tokenize()`, whose word pattern silently
    drops underscore tokens (the documented product-llm review blocker).
    """
    masked = item["context"]["maskedLine"]
    m = _BLANK_REGION.search(masked)
    if not m:
        return masked, ""
    return masked[:m.start()], masked[m.end():]


def _local_prompt(item: dict):
    """(instruction, assistant-prefill). The prefill makes the model CONTINUE a
    bar rather than answer a question about one — the shape a base-ish instruct
    model handles far better than a menu-in-prompt format."""
    con, gran = item["constraints"], item["granularity"]
    before = "\n".join(item["context"]["before"])
    bits = [f"You are finishing a bar. Continue it naturally."]
    if gran == "line":
        bits.append(f"Write one line of about {con['lineSyllableTarget']} syllables.")
    else:
        blanks = item["context"]["maskedLine"].count("____")
        bits.append(f"Fill in {blanks} word(s) totalling about "
                    f"{con.get('syllables')} syllable(s).")
    if con.get("rhymeWith"):
        bits.append(f'The last word must {con.get("rhymeStrictness", "slant")}-rhyme '
                    f'with "{con["rhymeWith"]}".')
    prefix, _suffix = _prefix_suffix(item)
    instruction = " ".join(bits) + ("\n\nPrevious bars:\n" + before if before else "")
    prefill = (before + "\n" if before else "") + (prefix if gran != "line" else "")
    return instruction, prefill


def _first_words(text: str, n: int) -> str:
    words = re.findall(r"[A-Za-z']+", text or "")
    return " ".join(words[:max(1, n)])


def _unavailable_arm(err: str, status: str = "unavailable") -> dict:
    """No candidates and a named reason. Never a fabricated fill, and never a
    fallback to another arm — that would launder its score into this arm's row."""
    return {"candidates": [], "meta": {"status": status, "error": err}}


@register("local-unconstrained", "v1")
def arm_local_unconstrained(item: dict, ctx: ArmContext) -> dict:
    """The local model with NO decoder constraint — M2's control.

    Not comparable to `llm-constrained`: that arm asks a hosted model for a JSON
    list of fills, this one continues a bar on local weights. The pair that
    isolates the constraint is this arm against `local-constrained-endword`.
    """
    from lyrics.bench import localgen
    if ctx.local is None:
        return _unavailable_arm("no local backend configured")
    cfg = ctx.local_cfg or getattr(ctx.local, "cfg", None) or localgen.LocalConfig()
    instruction, prefill = _local_prompt(item)
    seed = localgen.item_seed(item["itemId"], _seed_sha(item), cfg)
    out = localgen.generate(ctx.local, op="generate", prompt=instruction, cfg=cfg,
                            seed=seed, cache=ctx.cache,
                            extra_request={"prefill": prefill})
    if out.get("status") != "ok":
        return _unavailable_arm(out.get("error") or "local generation failed")
    text = (out.get("text") or "").strip().splitlines()[0] if out.get("text") else ""
    gran = item["granularity"]
    if gran == "line":
        fill = text
    else:
        blanks = max(1, item["context"]["maskedLine"].count("____"))
        fill = _first_words(text, blanks)
    return {"candidates": _dedupe_cap([fill], ctx.k),
            "meta": {"status": "ok", "seed": seed, "raw": text,
                     "logprobMean": out.get("logprobMean"),
                     "backend": out.get("backend")}}


def _local_constrained_endword(item: dict, ctx: ArmContext, *,
                               pool_rank: str) -> dict:
    """Tier-1: the terminal word can only be a phonology-valid one.

    Rhyme granularity ONLY. `word` and `span` items carry `rhymeWith: None`
    (mask.py:199,275) so there is no pool to constrain to, and `line` needs the
    genuine two-pass shape that is M3's problem. Declining is explicit — see
    ARM_GRANULARITIES for why silence would be worse than refusal.

    Note the decoding shape. The brief specified two passes (generate freely up to
    the final slot, then constrain it), but `mask._rhyme_item` sets the blank at
    `len(tokens)-1` — the blank IS the last word, so the prefix is fully supplied
    and pass 1 would be dead code on 100% of this slice. This is single-pass
    constrained decode over a fixed prefix.

    `pool_rank` is the ONLY difference between the two registered arms sharing
    this body: how the 200-word pool is truncated (see `_rhyme_menu`). The pool
    travels in the cache key via `poolSha`, so the two arms can never replay each
    other's picks even though everything else about their payloads matches.
    """
    from lyrics.bench import endword_trie, localgen
    if item.get("granularity") != "rhyme":
        return _unavailable_arm(f"granularity {item.get('granularity')!r} has no "
                                f"end-word pool", status="declined")
    if ctx.local is None:
        return _unavailable_arm("no local backend configured")

    pool = _rhyme_menu(item, ctx, max_n=200, rank=pool_rank)
    if not pool:
        return _unavailable_arm("no phonology-valid pool for this partner",
                                status="no-pool")

    cfg = ctx.local_cfg or getattr(ctx.local, "cfg", None) or localgen.LocalConfig()
    instruction, prefill = _local_prompt(item)
    seed = localgen.item_seed(item["itemId"], _seed_sha(item), cfg)
    out = localgen.generate(
        ctx.local, op="generate_endword", prompt=instruction, cfg=cfg, seed=seed,
        cache=ctx.cache, extra_request={"prefill": prefill, "pool": pool},
        # The pool is part of the ANSWER, so it must be part of the key: a
        # lexicon change moves rhyme_search's output and would otherwise replay
        # stale picks against a new menu.
        extra_key={"constraint": {"kind": "endword-trie",
                                  "trieVersion": endword_trie.TRIE_VERSION,
                                  "poolSha": endword_trie.pool_sha(pool),
                                  "poolSize": len(pool)}})
    if out.get("status") != "ok":
        return _unavailable_arm(out.get("error") or "local generation failed")

    words = [c["word"] for c in out.get("candidates") or []]
    off = [w for w in words if w not in pool]
    return {"candidates": _dedupe_cap(words, ctx.k),
            "meta": {"status": "ok", "seed": seed, "poolSize": len(pool),
                     # Zero by construction; reported so a broken mask is a NUMBER
                     # rather than silence. arms_test asserts it stays zero.
                     "offMenu": out.get("offMenu", 0) + len(off),
                     "trieTop1": out.get("trieTop1"),
                     "trieRankUnderExact": out.get("trieRankUnderExact"),
                     # Full teacher-forced ordering when the worker provides it
                     # (absent on responses cached before 2026-07-27). Lets the
                     # analysis read truth-rank-in-pool from run artifacts
                     # instead of capping every precision question at top-5.
                     "poolRanking": out.get("poolRanking"),
                     "unreachable": out.get("unreachable"),
                     "logprobMean": (out.get("candidates") or [{}])[0].get("logprobMean"),
                     "backend": out.get("backend")}}


@register("local-constrained-endword", "v1")
def arm_local_constrained_endword(item: dict, ctx: ArmContext) -> dict:
    """The original arm: alphabetically-truncated pool. See
    `_local_constrained_endword`. Kept byte-identical (same pool, same payloads,
    same cache keys) so its scoreboard row and paid cache stay comparable."""
    return _local_constrained_endword(item, ctx, pool_rank="alpha")


@register("local-constrained-endword-fp", "v1")
def arm_local_constrained_endword_fp(item: dict, ctx: ArmContext) -> dict:
    """The frequency-pool ablation: identical mechanism, identical model,
    identical cap — the pool is truncated by corpus frequency instead of the
    alphabet. Registered as its OWN arm rather than a v2 bump because the
    question is a side-by-side: coverage moved 40.0% → 89.3%; this measures
    what that buys in `exact` once a real model ranks the harder pool."""
    return _local_constrained_endword(item, ctx, pool_rank="freq")


@register("rhyme-floor-fp", "v1")
def arm_rhyme_floor_fp(item: dict, ctx: ArmContext) -> dict:
    """The no-model control for the freq pool: its top-k, verbatim.

    The freq-ranked menu is already ordered (grade, syllables, corpus frequency)
    — exactly the ranking `rhyme-floor` computes over the alpha menu — so the
    floor is the pool's head. If THIS arm approaches the constrained arm's
    exact, the model's ranking adds nothing over the pool's own ordering, and
    the win belongs to the pool fix rather than the decoder. Falls back to
    `freq-floor` on items with no partner, same as `rhyme-floor`."""
    menu = _rhyme_menu(item, ctx, max_n=200, rank="freq")
    if not menu:
        return arm_freq_floor(item, ctx)
    return {"candidates": _dedupe_cap(menu, ctx.k),
            "meta": {"menuSize": len(menu),
                     "perfect": len(_perfect_set(item, menu, ctx))}}


register_granularities("local-constrained-endword", ("rhyme",))
register_granularities("local-constrained-endword-fp", ("rhyme",))


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
