#!/usr/bin/env python
"""Latency bench for a local OpenAI-compatible serve of the Moshi brain.

Replays real rendered brain prompts (evalSft --dump output: {id, messages})
against a served model and reports end-to-end wall-clock per completion.
Methodology mirrors the recorded local baseline (CURRENT_STATUS §B8: 30
generations, full system prompt, median per-generation) with eval-parity
payloads: temperature 0, response_format json_object, max_tokens 2500,
chat_template_kwargs.enable_thinking=false.

Request #1 is reported separately as COLD (no server prompt cache); the
remaining requests measure steady-state serving, where mlx_lm.server reuses
the KV cache for the shared static prompt prefix — the shape a real Moshi
session sees after its first turn.

Usage:
  python bench_serve_latency.py --prompts evalA.prompts.jsonl \
      [--base http://127.0.0.1:8080/v1] [--model default_model] [--n 30] \
      [--max-tokens 2500] [--tag NAME] [--out results.json]

Prompt selection is the same deterministic djb2-hash order evalSft --n uses,
so runs are reproducible and family-mixed.
"""
from __future__ import annotations

import argparse
import json
import statistics
import time
import urllib.request
from pathlib import Path


def djb2(s: str) -> int:
    x = 5381
    for ch in s:
        x = ((x << 5) + x + ord(ch)) & 0xFFFFFFFF
    return x


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompts", required=True)
    ap.add_argument("--base", default="http://127.0.0.1:8080/v1")
    ap.add_argument("--model", default="default_model")
    ap.add_argument("--n", type=int, default=30)
    ap.add_argument("--max-tokens", type=int, default=2500)
    ap.add_argument("--tag", default="bench")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    rows = [json.loads(l) for l in Path(args.prompts).read_text().splitlines() if l.strip()]
    rows.sort(key=lambda r: djb2(r["id"]))
    rows = rows[: args.n]

    results = []
    for i, row in enumerate(rows):
        payload = {
            "model": args.model,
            "messages": row["messages"],
            "response_format": {"type": "json_object"},
            "max_tokens": args.max_tokens,
            "temperature": 0,
            "chat_template_kwargs": {"enable_thinking": False},
        }
        req = urllib.request.Request(
            f"{args.base}/chat/completions",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "Authorization": "Bearer local"},
        )
        t0 = time.monotonic()
        with urllib.request.urlopen(req, timeout=300) as r:
            body = json.loads(r.read())
        dt = time.monotonic() - t0
        usage = body.get("usage", {})
        content = body.get("choices", [{}])[0].get("message", {}).get("content", "")
        ok = True
        try:
            json.loads(content)
        except Exception:
            ok = False
        results.append(
            {
                "id": row["id"],
                "seconds": round(dt, 3),
                "prompt_tokens": usage.get("prompt_tokens"),
                "completion_tokens": usage.get("completion_tokens"),
                "json_ok": ok,
            }
        )
        print(
            f"[{i+1}/{len(rows)}] {row['id']}: {dt:.2f}s "
            f"(prompt={usage.get('prompt_tokens')}, gen={usage.get('completion_tokens')}, json_ok={ok})",
            flush=True,
        )

    cold = results[0]["seconds"]
    warm = sorted(r["seconds"] for r in results[1:])
    summary = {
        "tag": args.tag,
        "model": args.model,
        "base": args.base,
        "n": len(results),
        "cold_first_request_s": cold,
        "warm_median_s": round(statistics.median(warm), 3),
        "warm_p25_s": round(warm[len(warm) // 4], 3),
        "warm_p75_s": round(warm[(3 * len(warm)) // 4], 3),
        "warm_min_s": warm[0],
        "warm_max_s": warm[-1],
        "median_all_s": round(statistics.median([r["seconds"] for r in results]), 3),
        "json_ok": sum(r["json_ok"] for r in results),
        "mean_completion_tokens": round(
            statistics.mean(r["completion_tokens"] for r in results if r["completion_tokens"] is not None), 1
        ),
        "per_request": results,
    }
    print(json.dumps({k: v for k, v in summary.items() if k != "per_request"}, indent=2))
    if args.out:
        Path(args.out).write_text(json.dumps(summary, indent=2) + "\n")
        print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
