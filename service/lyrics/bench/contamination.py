#!/usr/bin/env python3
"""Contamination split: famous vs obscure (FMS WS1 / M5). Pure stdlib.

Famous songs are plausibly in every provider's and every base model's pretraining
data, so an absolute exact-match level may be part memorization and part writing.
Until this split exists, **cross-arm deltas under identical conditions are the
signal and absolute levels are not** (Amendment 1).

This is a sharper instrument than the existing `metrics.aggregate_by_fame`, which
buckets on Genius views alone. Views are a popularity proxy that says nothing
about WHEN a song entered the world — and the corpus has a much better signal
already recorded: provenance. The `genius-scrape` shard is a deliberate 2023+
pull of current material, which is the tail least likely to be memorized, while
the HF dump is chart-weighted and older.

So a song is OBSCURE when it is both recent AND low-view, and FAMOUS otherwise.
Requiring both keeps a 2024 chart smash out of the obscure bucket, which a
year-only rule would wrongly include.

Nothing here reads lyric text; it reads corpus metadata only.
"""
from __future__ import annotations

from typing import Dict, List, Optional

SPLIT_VERSION = "v1"

# Genius views. Reused from metrics.FAME_THRESHOLD so the two instruments cannot
# drift apart and quietly disagree about which songs are famous.
from lyrics.bench.metrics import FAME_THRESHOLD  # noqa: E402

# The scrape lane targets current material; anything from this year onward is the
# part of the corpus a 2024-2025-trained base model is least likely to have seen.
RECENT_YEAR = 2023


def song_index(songs: List[dict]) -> Dict[str, dict]:
    """songId -> the metadata the split needs. Never lyric text."""
    return {s["songId"]: {"views": int(s.get("views") or 0),
                          "year": int(s.get("year") or 0),
                          "source": s.get("source") or ""}
            for s in songs if s.get("songId")}


def split_of(meta: Optional[dict]) -> str:
    """'obscure' | 'famous' | 'unknown'.

    Unknown provenance is NEVER credited to `obscure`: that is the bucket where a
    clean result would be most flattering, so an unlabelled song must not land
    there by default. Same discipline as `aggregate_by_fame`, opposite direction —
    there, unknown views count as LOW fame because low-fame is the honest headline;
    here, unknown is called out rather than assigned.
    """
    if not meta:
        return "unknown"
    views, year = meta.get("views", 0), meta.get("year", 0)
    if not year:
        return "unknown"
    if year >= RECENT_YEAR and views < FAME_THRESHOLD:
        return "obscure"
    return "famous"


def annotate(rows: List[dict], index: Dict[str, dict]) -> List[dict]:
    """Stamp each scored row with its contamination split, in place."""
    for row in rows:
        row["contamination"] = split_of(index.get(row.get("songId")))
    return rows


def aggregate_by_contamination(rows: List[dict]) -> dict:
    """`metrics.aggregate` per split, plus the counts that make it readable.

    A delta between the buckets is the memorization estimate. A gain that exists
    ONLY in the famous bucket is recall, not writing — the same tripwire logic as
    `metricsByFame`, on a provenance-aware split.
    """
    from lyrics.bench.metrics import aggregate
    out = {}
    for name in ("obscure", "famous", "unknown"):
        sub = [r for r in rows if r.get("contamination") == name]
        out[name] = {"n": len(sub), **({} if not sub else aggregate(sub))}
    return {"version": SPLIT_VERSION, "recentYear": RECENT_YEAR,
            "fameThreshold": FAME_THRESHOLD, "splits": out}
