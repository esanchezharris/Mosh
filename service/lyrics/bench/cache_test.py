#!/usr/bin/env python3
"""Golden tests for the prompt-hash response cache (FMS lyrics-bench I1).

The cache is what makes LLM runs REPLAY-deterministic: every provider response is
stored by request hash, re-scoring never re-generates, and MOSH_INFILL_CACHE_ONLY=1
turns a run into a bit-for-bit replay (miss ⇒ hard error, never a silent call).

Run:  python3 service/lyrics/bench/cache_test.py     (exit 0 = all pass)
"""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import llm_cache  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# ---- key stability ----
k1 = llm_cache.cache_key({"b": 2, "a": [1, {"y": 0, "x": 9}]})
k2 = llm_cache.cache_key({"a": [1, {"x": 9, "y": 0}], "b": 2})
check("cache_key: dict-order independent", k1 == k2, f"{k1[:12]} vs {k2[:12]}")
check("cache_key: value-sensitive",
      llm_cache.cache_key({"a": 1}) != llm_cache.cache_key({"a": 2}))

with tempfile.TemporaryDirectory() as td:
    cache = llm_cache.Cache(td)
    calls = {"n": 0}

    def fn():
        calls["n"] += 1
        return {"ok": True, "content": "hello", "n": calls["n"]}

    payload = {"messages": [{"role": "user", "content": "hi"}], "temperature": 0}
    r1 = cache.cached_call(payload, fn)
    r2 = cache.cached_call(payload, fn)
    check("cached_call: fn invoked once, hit served from disk",
          calls["n"] == 1 and r1 == r2, f"calls={calls['n']}")
    check("stats: 1 miss then 1 hit", cache.stats == {"hits": 1, "misses": 1},
          str(cache.stats))

    fresh = llm_cache.Cache(td)  # same dir, new instance → still a hit
    r3 = fresh.cached_call(payload, fn)
    check("persistence: new instance over same dir hits", calls["n"] == 1 and r3 == r1)

    # ---- CACHE_ONLY replay mode ----
    os.environ["MOSH_INFILL_CACHE_ONLY"] = "1"
    try:
        hit_ok = fresh.cached_call(payload, fn) == r1
        try:
            fresh.cached_call({"messages": "never seen"}, fn)
            raised = False
        except llm_cache.CacheMiss:
            raised = True
        check("CACHE_ONLY: hits still served", hit_ok)
        check("CACHE_ONLY: miss raises CacheMiss instead of calling", raised
              and calls["n"] == 1)
    finally:
        del os.environ["MOSH_INFILL_CACHE_ONLY"]

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
