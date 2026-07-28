"""The bench runner (FMS lyrics-bench I1). Pure stdlib + the bench modules.

run_arm drives one arm over an item list: propose (through the arm-result cache)
→ score with the deterministic metrics → results.jsonl + summary.json in an
append-only run directory. Summaries are timestamp-free by design so identical
runs compare equal; the run DIRECTORY name carries the wall-clock (CLI layer).

Determinism posture, stated honestly: deterministic arms reproduce bit-for-bit;
stochastic (API) arms are REPLAY-deterministic — the first run freezes their
samples in the cache, and every later run re-reads them (zero new calls),
which is what makes judge changes and rerank experiments free.
"""
from __future__ import annotations

import hashlib
import json
import os
from typing import List

from lyrics.bench import contamination, metrics
from lyrics.bench.arms import ARM_VERSIONS, ARMS, ArmContext


def _items_sha(items: List[dict]) -> str:
    h = hashlib.sha256()
    for i in items:
        h.update(i["itemId"].encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


def run_arm(arm_name: str, items: List[dict], ctx: ArmContext, *,
            out_dir: str, run_name: str = "", song_index: dict = None,
            canary: dict = None) -> dict:
    if arm_name not in ARMS:
        raise KeyError(f"unknown arm {arm_name!r}; known: {sorted(ARMS)}")
    arm, version = ARMS[arm_name], ARM_VERSIONS[arm_name]

    rows, empty = [], 0
    unusable: dict = {}
    results_path = os.path.join(out_dir, f"results-{run_name or arm_name}.jsonl")
    os.makedirs(out_dir, exist_ok=True)
    with open(results_path, "w", encoding="utf-8") as out:
        for item in items:
            # Content hash in the key: an eval rebuild (bigger corpus, new salt)
            # can re-mask the SAME itemId to a different target — itemId alone
            # would replay stale candidates against the new truth.
            content = json.dumps({k: item[k] for k in ("context", "target",
                                                       "constraints")},
                                 sort_keys=True, ensure_ascii=False)
            payload = {"armResult": arm_name, "version": version,
                       "itemId": item["itemId"], "k": ctx.k,
                       "productBackend": ctx.product_backend,
                       "itemSha": hashlib.sha256(content.encode("utf-8")).hexdigest()}
            # Local arms carry model id / revision / quant / mode / seed here.
            # Without it, swapping 4bit for 8bit replays the old candidates
            # byte-identically — the same ghost the rhyme-floor v1→v2 fix hit.
            #
            # Inserted only when NON-EMPTY, and that is load-bearing: cache_key
            # hashes the whole payload, so adding a key unconditionally re-keys
            # every existing arm and cold-misses every response already paid for
            # under the program's API ceiling.
            arm_config = getattr(ctx, "arm_config", None)
            if arm_config:
                payload["armConfig"] = arm_config
            if ctx.cache is not None:
                result = ctx.cache.cached_call(payload, lambda: arm(item, ctx))
            else:
                result = arm(item, ctx)
            cands = [c["text"] for c in result.get("candidates", [])]
            if not cands:
                empty += 1
            status = (result.get("meta") or {}).get("status")
            if status in ("unavailable", "declined", "no-pool"):
                unusable[status] = unusable.get(status, 0) + 1
            row = metrics.score_item(item, cands, ctx.pron)
            row["candidates"] = cands
            row["armMeta"] = result.get("meta", {})
            rows.append(row)
            out.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")

    # Famous songs are plausibly in every base model's pretraining data, so an
    # absolute exact level is part memorization. Until this split is read, only
    # cross-arm deltas under identical conditions are signal (Amendment 1).
    if song_index is not None:
        contamination.annotate(rows, song_index)

    summary = {
        "arm": {"name": arm_name, "version": version,
                "productBackend": ctx.product_backend, "k": ctx.k,
                # Which weights produced these numbers. A score that cannot name
                # them is not reproducible, it is just a number.
                "config": getattr(ctx, "arm_config", None) or {}},
        "items": len(items),
        "itemsSha": _items_sha(items),
        "emptyCandidates": empty,
        # A completed run whose backend was dead all along must not read as a
        # clean sweep of zeros — `unusable` is how that becomes visible.
        "unusableItems": unusable,
        "metrics": metrics.aggregate(rows),
        # The memorization tripwire: a gain that exists only in the high-fame
        # bucket is recall, not writing. Costs nothing — `views` is already on
        # every scored row.
        "metricsByFame": metrics.aggregate_by_fame(rows),
        "cache": dict(ctx.cache.stats) if ctx.cache is not None else None,
        "metricsByContamination": (contamination.aggregate_by_contamination(rows)
                                   if song_index is not None else None),
        # Recorded IN the summary, not just printed: a run whose canaries were
        # never checked must be distinguishable from one that passed them.
        "canaries": canary,
    }
    with open(os.path.join(out_dir, f"summary-{run_name or arm_name}.json"),
              "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, sort_keys=True, indent=1)
    return {"summary": summary, "rows": len(rows), "resultsPath": results_path}
