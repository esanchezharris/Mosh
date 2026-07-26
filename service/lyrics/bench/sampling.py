"""Balanced subsampling + run identity (FMS lyrics-bench I2). Pure stdlib.

`--limit N` over an itemId-sorted list returns ONE granularity, because itemIds
begin with the granularity and the alphabet decides. That bug was fixed inline
in `run`, then recurred verbatim in `judge` — so it lives here once, tested, and
both call sites use it.

`arm_of` reads the arm name from the run's own summary rather than parsing the
directory name: timestamps contain hyphens, so any split-based guess mangles
some arm eventually (it produced "31-54-llm-constrained" on the first try).
"""
from __future__ import annotations

import glob
import hashlib
import json
import os
from typing import Callable, List, Optional, Sequence


def _interleave(rows: List[dict], spread: Callable[[dict], str]) -> List[dict]:
    """Deal one row per spread-bucket per round (song A, song B, song C, song A…).

    Without this, taking a prefix of an itemId-sorted list lands entirely inside
    the lowest-sorting song — and since Genius ids run roughly chronological,
    that is also the OLDEST song. Calibration sitting 1 drew all 64 of its pairs
    from a single 2000-era track because of exactly this.
    """
    buckets: dict = {}
    for row in rows:
        buckets.setdefault(spread(row), []).append(row)
    # Bucket ORDER is hashed, not lexicographic: Genius ids run roughly
    # chronological, so visiting songs in id order would still front-load the
    # oldest material whenever songs outnumber the limit. Hashing is
    # deterministic (same corpus ⇒ same draw) but era-neutral.
    order = sorted(buckets, key=lambda name: hashlib.blake2b(
        name.encode("utf-8"), digest_size=8).digest())
    out: List[dict] = []
    depth = 0
    while len(out) < len(rows):
        for name in order:
            if depth < len(buckets[name]):
                out.append(buckets[name][depth])
        depth += 1
    return out


def balanced(rows: Sequence[dict], *, limit: int,
             key: Callable[[dict], str],
             spread: Optional[Callable[[dict], str]] = None,
             max_per_spread: int = 0) -> List[dict]:
    """Up to `limit` rows spread evenly over the groups `key` produces, and —
    when `spread` is given — dealt across those buckets (songs) rather than
    sliced out of one. limit <= 0 means no cap. Deterministic; output is
    itemId-sorted.

    `max_per_spread` caps how many rows any one bucket may contribute ACROSS all
    groups. Interleaving alone is not enough: every group walks the buckets in
    the same hashed order, so each one re-picks the same leading songs — a
    40-item draw over 99 eligible songs landed on 11 of them, near enough to the
    single-song collapse that voided calibration sitting 1. 0 = uncapped.
    """
    if limit <= 0 or limit >= len(rows):
        return sorted(rows, key=lambda r: r["itemId"])
    groups: dict = {}
    for row in sorted(rows, key=lambda r: r["itemId"]):
        groups.setdefault(key(row), []).append(row)
    if spread is not None:
        groups = {name: _interleave(rows_, spread) for name, rows_ in groups.items()}
    names = sorted(groups)
    picked: List[dict] = []
    cursor = {n: 0 for n in names}
    used: dict = {}
    while len(picked) < limit and any(cursor[n] < len(groups[n]) for n in names):
        progressed = False
        for n in names:
            if len(picked) >= limit:
                break
            # Walk past rows whose bucket is already at its cap.
            while cursor[n] < len(groups[n]):
                row = groups[n][cursor[n]]
                cursor[n] += 1
                bucket = spread(row) if (spread and max_per_spread) else None
                if bucket is not None and used.get(bucket, 0) >= max_per_spread:
                    continue
                if bucket is not None:
                    used[bucket] = used.get(bucket, 0) + 1
                picked.append(row)
                progressed = True
                break
        if not progressed:
            break
    return sorted(picked, key=lambda r: r["itemId"])


def arm_of(run_dir: str) -> str:
    """The arm that produced a run, from its summary. Never parsed from the
    directory name (timestamps contain hyphens)."""
    for path in sorted(glob.glob(os.path.join(run_dir, "summary-*.json"))):
        try:
            with open(path, encoding="utf-8") as f:
                name = (json.load(f).get("arm") or {}).get("name")
            if name:
                return name
        except Exception:  # noqa: BLE001 — a torn summary is just "unknown"
            continue
    return f"unknown({os.path.basename(run_dir)})"
