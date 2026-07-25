"""Single source of truth for the lyrics-bench data root (FMS lyrics-bench I1).

Everything heavy — raw HF pulls, the normalized corpus, eval items, LLM response
cache, run outputs, calibration pages, adapters, and the owner's golden_spec.json —
lives OUTSIDE git under this root. Never under ~/Documents (iCloud evicts contents).
"""
from __future__ import annotations

import os


def data_root() -> str:
    return os.environ.get("MOSH_LYRICS_BENCH_DIR") or os.path.expanduser(
        "~/Library/Mosh/lyrics-bench")


def subdir(*parts: str) -> str:
    p = os.path.join(data_root(), *parts)
    os.makedirs(p, exist_ok=True)
    return p
