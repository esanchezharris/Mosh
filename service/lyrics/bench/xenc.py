#!/usr/bin/env python3
"""Cross-encoder candidate scorer (FMS M6). Stdlib façade over a torch worker.

The M6 ranker shape from the spec: score `(context, candidate)` pairs
independently — pointwise, no list in any prompt, output is a scalar per
candidate. This module is the seam; `_xenc_worker.py` is the torch side.

Deliberately NOT routed through `torchjudge.score_pairs`: that seam's payload
carries the TRUTH-completed line for every pair, by design — its judges compare
candidates against the truth. A RANKER must never see the truth. This façade's
payload is truth-free by construction and `xenc_test` pins it at the payload
boundary (the tempting refactor to "reuse the existing seam" reintroduces the
leak, which is why this docstring exists).

Honesty rules inherited from `torchjudge`: absent torch → `unavailable`, scores
None, never a fabricated 0.0; provenance (interpreter, model id) travels with
the numbers and with every cached score.
"""
from __future__ import annotations

import hashlib
import json
import os
from typing import Callable, List, Optional, Sequence

from lyrics.bench import torchjudge

HERE = os.path.dirname(os.path.abspath(__file__))
_WORKER = os.path.join(HERE, "_xenc_worker.py")

XENC_MODEL = os.environ.get("LYRICS_BENCH_XENC_MODEL", "BAAI/bge-reranker-v2-m3")


def query_of(item: dict) -> str:
    """The bar with its blank still in it, plus the surrounding lines.

    The blank stays a blank: the query describes the SLOT, the passage is one
    way of filling it. No target text anywhere in this function's reach."""
    ctx = item.get("context") or {}
    lines = list(ctx.get("before") or []) + [ctx.get("maskedLine") or ""] \
        + list(ctx.get("after") or [])
    return "\n".join(l for l in lines if l)


def passage_of(item: dict, fill: str) -> str:
    from lyrics.bench.metrics import apply_fill
    if item.get("granularity") == "line":
        return fill
    return apply_fill(item, fill)


def _key(item: dict, fill: str, model: str) -> str:
    # TRUTH-FREE: keyed on the candidate-completed line and the model, never on
    # the target. (torchjudge's key includes the truth line; this one must not.)
    blob = json.dumps({"kind": "xenc", "model": model, "itemId": item["itemId"],
                       "query": query_of(item), "passage": passage_of(item, fill)},
                      sort_keys=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def score_candidates(item: dict, fills: Sequence[str], *, cache=None,
                     run_backend: Callable = torchjudge.run_backend,
                     python: Optional[str] = None,
                     model: str = "") -> dict:
    """Score each fill against the item's context. Higher = better fit."""
    model = model or XENC_MODEL
    scores: List[Optional[float]] = [None] * len(fills)
    todo: List[int] = []
    keys = [_key(item, f, model) for f in fills]
    hit_backends: List[str] = []
    if cache is not None:
        for i, key in enumerate(keys):
            hit = cache.get(key)
            if hit is not None and hit.get("score") is not None:
                scores[i] = hit["score"]
                cache.stats["hits"] += 1
                if hit.get("backend"):
                    hit_backends.append(json.dumps(hit["backend"], sort_keys=True))
            else:
                todo.append(i)
    else:
        todo = list(range(len(fills)))

    if not todo:
        distinct = sorted(set(hit_backends))
        recovered = (json.loads(distinct[0]) if len(distinct) == 1
                     else {"mixed": [json.loads(b) for b in distinct]})
        return {"status": "ok", "scores": scores, "backend": recovered,
                "error": None}

    py = python or torchjudge.resolve_python()
    if not py:
        return {"status": "unavailable", "scores": [None] * len(fills),
                "backend": None,
                "error": "no interpreter with torch+transformers found "
                         "(set LYRICS_BENCH_TORCH_PY)"}
    payload = {"kind": "xenc", "model": model,
               "pairs": [{"query": query_of(item),
                          "passage": passage_of(item, fills[i])} for i in todo]}
    out = run_backend(py, _WORKER, payload)
    if not out.get("ok"):
        return {"status": "unavailable", "scores": [None] * len(fills),
                "backend": None, "error": out.get("error") or "backend failed"}
    fresh = out.get("scores") or []
    if len(fresh) != len(todo):
        return {"status": "unavailable", "scores": [None] * len(fills),
                "backend": out.get("backend"),
                "error": f"backend returned {len(fresh)} scores for {len(todo)}"}
    for slot, value in zip(todo, fresh):
        scores[slot] = value
        if cache is not None:
            cache.stats["misses"] += 1
            cache.put(keys[slot], {"score": value, "backend": out.get("backend")})
    return {"status": "ok", "scores": scores, "backend": out.get("backend"),
            "error": None}
