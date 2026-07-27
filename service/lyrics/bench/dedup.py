"""Duplicate detection (FMS lyrics-bench I1). Pure stdlib, deterministic.

Two scalable layers instead of all-pairs clustering (which would be O(n²) over a
six-figure corpus):
  1. EXACT dups collapse on the normalized-content hash (segment.make_song already
     hashes normalized lyrics, so re-scrapes with different debris collapse too).
  2. NEAR dups are detected by shingle CONTAINMENT against a small POOL — in
     practice the golden pool — via an inverted index. Covers/remixes/re-releases
     of a golden song get quarantined even when artist/title differ (the fixture
     remix is exactly this case).

Shingles are hashed 5-gram token windows over the flattened verse text
(blake2b-8, keyless — stable across processes, unlike builtin hash()).
"""
from __future__ import annotations

import hashlib
from typing import Dict, List, Set

from lyrics.bench.mask import tokenize

SHINGLE_N = 5


def _flat_tokens(song: dict) -> List[str]:
    toks: List[str] = []
    for sec in song.get("sections", []):
        for line in sec.get("lines", []):
            toks.extend(t.lower() for t in tokenize(line))
    return toks


def shingles(song: dict, n: int = SHINGLE_N) -> Set[int]:
    toks = _flat_tokens(song)
    out: Set[int] = set()
    for i in range(max(0, len(toks) - n + 1)):
        gram = " ".join(toks[i:i + n]).encode("utf-8")
        out.add(int.from_bytes(hashlib.blake2b(gram, digest_size=8).digest(), "big"))
    return out


def build_pool_index(pool_songs: List[dict]) -> dict:
    """{shingle -> [songId]}, plus per-song sizes — the containment target."""
    index: Dict[int, List[str]] = {}
    sizes: Dict[str, int] = {}
    for song in pool_songs:
        sh = shingles(song)
        sizes[song["songId"]] = len(sh)
        for h in sh:
            index.setdefault(h, []).append(song["songId"])
    return {"index": index, "sizes": sizes}


def containment(cand_shingles: Set[int], pool: dict) -> float:
    """Max containment of the candidate vs any single pool song:
    |cand ∩ pool_song| / min(|cand|, |pool_song|). 1.0 = one is inside the other."""
    if not cand_shingles or not pool["sizes"]:
        return 0.0
    counts: Dict[str, int] = {}
    index = pool["index"]
    for h in cand_shingles:
        for sid in index.get(h, ()):
            counts[sid] = counts.get(sid, 0) + 1
    best = 0.0
    for sid, shared in counts.items():
        denom = min(len(cand_shingles), pool["sizes"][sid])
        if denom:
            best = max(best, shared / denom)
    return best


def exact_dup_drops(songs: List[dict]) -> Set[str]:
    """songIds to drop so each content hash keeps exactly one song (the
    lexicographically-first songId — deterministic)."""
    by_hash: Dict[str, List[str]] = {}
    for s in songs:
        by_hash.setdefault(s.get("hash", ""), []).append(s["songId"])
    drops: Set[str] = set()
    for _, ids in by_hash.items():
        for sid in sorted(ids)[1:]:
            drops.add(sid)
    return drops
