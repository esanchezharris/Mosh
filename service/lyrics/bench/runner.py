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

from lyrics.bench import metrics
from lyrics.bench.arms import ARM_VERSIONS, ARMS, ArmContext


def _items_sha(items: List[dict]) -> str:
    h = hashlib.sha256()
    for i in items:
        h.update(i["itemId"].encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


def run_arm(arm_name: str, items: List[dict], ctx: ArmContext, *,
            out_dir: str, run_name: str = "") -> dict:
    if arm_name not in ARMS:
        raise KeyError(f"unknown arm {arm_name!r}; known: {sorted(ARMS)}")
    arm, version = ARMS[arm_name], ARM_VERSIONS[arm_name]

    rows, empty = [], 0
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
            if ctx.cache is not None:
                result = ctx.cache.cached_call(payload, lambda: arm(item, ctx))
            else:
                result = arm(item, ctx)
            cands = [c["text"] for c in result.get("candidates", [])]
            if not cands:
                empty += 1
            row = metrics.score_item(item, cands, ctx.pron)
            row["candidates"] = cands
            row["armMeta"] = result.get("meta", {})
            rows.append(row)
            out.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")

    summary = {
        "arm": {"name": arm_name, "version": version,
                "productBackend": ctx.product_backend, "k": ctx.k},
        "items": len(items),
        "itemsSha": _items_sha(items),
        "emptyCandidates": empty,
        "metrics": metrics.aggregate(rows),
        # The memorization tripwire: a gain that exists only in the high-fame
        # bucket is recall, not writing. Costs nothing — `views` is already on
        # every scored row.
        "metricsByFame": metrics.aggregate_by_fame(rows),
        "cache": dict(ctx.cache.stats) if ctx.cache is not None else None,
    }
    with open(os.path.join(out_dir, f"summary-{run_name or arm_name}.json"),
              "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, sort_keys=True, indent=1)
    return {"summary": summary, "rows": len(rows), "resultsPath": results_path}
