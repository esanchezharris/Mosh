"""Prompt-hash response cache (FMS lyrics-bench I1). Pure stdlib.

Key = sha256 of the canonical-JSON request payload. Values are full response
envelopes. Nothing is ever paid twice: arms and judges both route through
cached_call. MOSH_INFILL_CACHE_ONLY=1 turns any run into a bit-for-bit replay —
a miss raises CacheMiss instead of silently generating.
"""
from __future__ import annotations

import hashlib
import json
import os
from typing import Callable, Optional


class CacheMiss(RuntimeError):
    pass


def cache_key(payload: dict) -> str:
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


class Cache:
    def __init__(self, root: str):
        self.root = root
        self.stats = {"hits": 0, "misses": 0}

    def _path(self, key: str) -> str:
        return os.path.join(self.root, key[:2], key + ".json")

    def get(self, key: str) -> Optional[dict]:
        p = self._path(key)
        if not os.path.exists(p):
            return None
        with open(p, encoding="utf-8") as f:
            return json.load(f)

    def put(self, key: str, value: dict) -> None:
        p = self._path(key)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False, sort_keys=True)
        os.replace(tmp, p)

    def cached_call(self, payload: dict, fn: Callable[[], dict]) -> dict:
        key = cache_key(payload)
        hit = self.get(key)
        if hit is not None:
            self.stats["hits"] += 1
            return hit
        if os.environ.get("MOSH_INFILL_CACHE_ONLY") == "1":
            raise CacheMiss(f"cache-only replay missed key {key[:16]}…")
        self.stats["misses"] += 1
        value = fn()
        self.put(key, value)
        return value
