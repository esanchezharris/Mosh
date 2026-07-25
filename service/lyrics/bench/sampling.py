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
import json
import os
from typing import Callable, List, Sequence


def balanced(rows: Sequence[dict], *, limit: int,
             key: Callable[[dict], str]) -> List[dict]:
    """Up to `limit` rows spread evenly over the groups `key` produces.
    limit <= 0 means no cap. Deterministic; output is itemId-sorted."""
    if limit <= 0 or limit >= len(rows):
        return sorted(rows, key=lambda r: r["itemId"])
    groups: dict = {}
    for row in sorted(rows, key=lambda r: r["itemId"]):
        groups.setdefault(key(row), []).append(row)
    names = sorted(groups)
    picked: List[dict] = []
    cursor = {n: 0 for n in names}
    while len(picked) < limit and any(cursor[n] < len(groups[n]) for n in names):
        for n in names:
            if len(picked) >= limit:
                break
            if cursor[n] < len(groups[n]):
                picked.append(groups[n][cursor[n]])
                cursor[n] += 1
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
