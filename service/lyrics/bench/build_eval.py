"""Split assignment + eval-item building (FMS lyrics-bench I1).

Split rules (validity spine of the whole program):
  - golden = songs matching the owner's golden_spec (artist case/punct-insensitive,
    explicit (artist,title) pairs, or ownSources) — synthetic-source songs are
    NEVER golden regardless of match;
  - any non-golden song whose shingle containment vs the golden pool clears
    NEAR_DUP_THRESHOLD is QUARANTINED (covers/remixes/re-releases leak vector);
  - exact content dups collapse to one song ("dropped");
  - the rest split train/dev by sha256(salt|songId) — the salt lives only in the
    data dir, so split membership cannot be reconstructed from the repo. Manifests
    record sha256 of the salt, never the salt.

Unmatched golden_spec entries are reported loudly: a typo silently shrinking the
golden set is the failure mode.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Dict, List, Tuple

from lyrics.bench import dedup, mask

NEAR_DUP_THRESHOLD = 0.5
_NORM_RE = re.compile(r"[^a-z0-9 ]+")


def _norm(s: str) -> str:
    return _NORM_RE.sub("", (s or "").lower()).strip()


def _hash_frac(salt: str, song_id: str) -> float:
    h = hashlib.sha256(f"{salt}|{song_id}".encode("utf-8")).digest()
    return int.from_bytes(h[:8], "big") / 2 ** 64


def match_golden(songs: List[dict], spec: dict) -> Tuple[set, dict]:
    artists = {_norm(a) for a in spec.get("artists", [])}
    pairs = {(_norm(p.get("artist", "")), _norm(p.get("title", "")))
             for p in spec.get("songs", [])}
    own = {_norm(o) for o in spec.get("ownSources", [])}
    golden, seen_artists, seen_pairs, seen_own = set(), set(), set(), set()
    for s in songs:
        a, t = _norm(s.get("artist", "")), _norm(s.get("title", ""))
        if s.get("source") == "synthetic":
            continue
        if a in artists:
            golden.add(s["songId"])
            seen_artists.add(a)
        if (a, t) in pairs:
            golden.add(s["songId"])
            seen_pairs.add((a, t))
        if s.get("source") == "own" and _norm(s["songId"].split(":", 1)[-1]) in own:
            golden.add(s["songId"])
            seen_own.add(_norm(s["songId"].split(":", 1)[-1]))
    report = {
        "unmatchedArtists": sorted(a for a in artists - seen_artists),
        "unmatchedSongs": sorted(f"{a}|{t}" for a, t in pairs - seen_pairs),
        "unmatchedOwnSources": sorted(own - seen_own),
    }
    return golden, report


def assign_splits(songs: List[dict], golden_spec: dict, *, salt: str,
                  dev_frac: float = 0.1,
                  near_dup_threshold: float = NEAR_DUP_THRESHOLD) -> Tuple[Dict[str, str], dict]:
    golden_ids, unmatched = match_golden(songs, golden_spec)

    # Goldenness UNIONS over exact-content groups BEFORE dedup: a re-scrape of a
    # golden song under another id/artist string is the same lyrics, and letting
    # the golden-blind lex-first keep-rule win routed verbatim golden content
    # into train/dev while silently dropping the golden copy (review finding).
    by_hash: Dict[str, List[str]] = {}
    for s in songs:
        by_hash.setdefault(s.get("hash", ""), []).append(s["songId"])
    spec_matched = set(golden_ids)
    for ids in by_hash.values():
        if any(i in golden_ids for i in ids):
            golden_ids.update(ids)
    drops = set()
    for ids in by_hash.values():
        # Keep the spec-matched copy when the group is golden (interpretable
        # golden set), else the lexicographically-first id — deterministic.
        keep = sorted(ids, key=lambda i: (0 if i in spec_matched else 1, i))[0]
        drops.update(i for i in ids if i != keep)

    golden_songs = [s for s in songs if s["songId"] in golden_ids
                    and s["songId"] not in drops]
    pool = dedup.build_pool_index(golden_songs)

    splits: Dict[str, str] = {}
    quarantined: List[str] = []
    for s in songs:
        sid = s["songId"]
        if sid in drops:
            splits[sid] = "dropped"
        elif sid in golden_ids:
            splits[sid] = "golden"
        elif dedup.containment(dedup.shingles(s), pool) >= near_dup_threshold:
            splits[sid] = "quarantined"
            quarantined.append(sid)
        elif _hash_frac(salt, sid) < dev_frac:
            splits[sid] = "dev"
        else:
            splits[sid] = "train"

    counts: Dict[str, int] = {}
    for sp in splits.values():
        counts[sp] = counts.get(sp, 0) + 1
    report = {"quarantined": sorted(quarantined), "counts": counts, **unmatched}
    return splits, report


def build_items(songs: List[dict], splits: Dict[str, str], pron, *,
                golden_spec: dict, salt: str,
                freq: Dict[str, int] | None = None) -> Tuple[List[dict], dict]:
    """Mask every train/dev/golden song into eval items (split-tagged) + manifest."""
    usable = [s for s in songs if splits.get(s["songId"]) in ("train", "dev", "golden")]
    freq = freq if freq is not None else mask.build_freq_table(usable)
    items: List[dict] = []
    for s in usable:
        sp = splits[s["songId"]]
        for item in mask.items_for_song(s, pron, freq):
            item["split"] = sp
            items.append(item)
    counts: Dict[str, int] = {}
    for i in items:
        counts[i["split"]] = counts.get(i["split"], 0) + 1
    manifest = {
        "policyVersion": mask.POLICY_VERSION,
        "goldenSpecSha": hashlib.sha256(
            json.dumps(golden_spec, sort_keys=True).encode("utf-8")).hexdigest(),
        "saltSha": hashlib.sha256(salt.encode("utf-8")).hexdigest(),
        "counts": counts,
        "items": len(items),
        "songs": len(usable),
    }
    return items, manifest
