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


def _llm_arm(item: dict, ctx: ArmContext, constrained: bool) -> dict:
    prompt = _context_block(item)
    if constrained:
        prompt += "\n" + _constraint_block(item)
    messages = [{"role": "system", "content": _SYSTEM % ctx.k},
                {"role": "user", "content": prompt}]
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
        gap = {"index": idx, "seedText": item["context"]["maskedLine"],
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


def _extract_fill(item: dict, proposal_text: str) -> str:
    """Pull the fill back out of a full-line proposal by aligning the visible
    prefix/suffix tokens; fall back to the whole proposal when alignment fails."""
    if item["granularity"] == "line":
        return proposal_text
    masked_tokens = tokenize(item["context"]["maskedLine"])
    blanks = item["context"]["maskedLine"].count("____")
    first_blank = None
    for i, t in enumerate(masked_tokens):
        if re.fullmatch(r"_{2,}", t):
            first_blank = i
            break
    if first_blank is None:
        return proposal_text
    prop = tokenize(proposal_text)
    prefix = [t.lower() for t in masked_tokens[:first_blank]]
    suffix = [t.lower() for t in masked_tokens[first_blank + blanks:]]
    if ([t.lower() for t in prop[:len(prefix)]] == prefix
            and (not suffix or [t.lower() for t in prop[len(prop) - len(suffix):]] == suffix)):
        mid = prop[len(prefix):len(prop) - len(suffix)] if suffix else prop[len(prefix):]
        if mid:
            return " ".join(mid)
    return proposal_text


@register("product-llm", "v1")
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
