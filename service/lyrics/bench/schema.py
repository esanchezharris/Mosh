"""Eval-item schema validator (FMS lyrics-bench I1).

validate_item returns a list of problem strings — empty means valid. Structural
checks only (no song context needed); cross-corpus checks (split leakage, dedup)
live in build_eval.
"""
from __future__ import annotations

from typing import List

GRANULARITIES = ("word", "rhyme", "span", "line")
LICENSE_TIERS = ("eval-only", "train-ok")
_BLANK = "____"

_TOP_KEYS = ("itemId", "granularity", "songId", "artist", "si", "li", "sectionKind",
             "licenseTier", "views", "maskPolicy", "seed", "context", "target",
             "constraints")
_CTX_KEYS = ("before", "maskedLine", "after")
_TGT_KEYS = ("text", "tokenIndex", "tokenSpan", "syllables", "stress")
_CON_KEYS = ("syllables", "syllableTol", "rhymeWith", "rhymeStrictness",
             "lineSyllableTarget")


def validate_item(item: dict) -> List[str]:
    problems: List[str] = []
    for k in _TOP_KEYS:
        if k not in item:
            problems.append(f"missing key: {k}")
    if problems:
        return problems

    gran = item["granularity"]
    if gran not in GRANULARITIES:
        problems.append(f"unknown granularity: {gran!r}")
        return problems
    if item["licenseTier"] not in LICENSE_TIERS:
        problems.append(f"unknown licenseTier: {item['licenseTier']!r}")

    ctx, tgt, con = item["context"], item["target"], item["constraints"]
    for k in _CTX_KEYS:
        if k not in ctx:
            problems.append(f"context missing: {k}")
    for k in _TGT_KEYS:
        if k not in tgt:
            problems.append(f"target missing: {k}")
    for k in _CON_KEYS:
        if k not in con:
            problems.append(f"constraints missing: {k}")
    if problems:
        return problems

    if not isinstance(tgt["text"], str) or not tgt["text"]:
        problems.append("target.text empty")

    if gran == "line":
        if ctx["maskedLine"] is not None:
            problems.append("line item must have maskedLine=None")
        if len(ctx["before"]) < 2 or len(ctx["after"]) < 1:
            problems.append("line item context arity: need >=2 before / >=1 after")
        if not con["lineSyllableTarget"]:
            problems.append("line item needs lineSyllableTarget")
    else:
        if not isinstance(ctx["maskedLine"], str) or _BLANK not in ctx["maskedLine"]:
            problems.append("masked item must carry a blank in maskedLine")
        if tgt["text"] in (ctx["maskedLine"] or ""):
            problems.append("target text visible in maskedLine")

    if gran == "span":
        span = tgt["tokenSpan"]
        if (not isinstance(span, list) or len(span) != 2
                or not all(isinstance(x, int) for x in span) or span[0] >= span[1]):
            problems.append(f"bad tokenSpan: {span!r}")
        elif not 2 <= span[1] - span[0] <= 4:
            problems.append(f"span length out of range: {span!r}")
    elif gran in ("word", "rhyme"):
        if not isinstance(tgt["tokenIndex"], int) or tgt["tokenIndex"] < 0:
            problems.append(f"bad tokenIndex: {tgt['tokenIndex']!r}")

    if gran == "rhyme" and not con["rhymeWith"]:
        problems.append("rhyme item needs constraints.rhymeWith")

    if item["seed"] != _expected_seed(item):
        problems.append("seed does not match itemId derivation")
    return problems


def _expected_seed(item: dict) -> int:
    from lyrics.bench.mask import item_seed
    return item_seed(item["songId"], item["si"], item["li"], item["granularity"])
