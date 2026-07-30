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


# Genius collab credits: "Future & Young Thug", "Drake, 21 Savage",
# "Artist feat. Other". Split BEFORE normalization (punctuation carries the
# structure); components are matched exactly, so "Nick Drake" never matches
# "Drake" — but "A & Drake" does. A collab song carries the golden artist's
# verses and must never reach train/dev.
_COLLAB_SPLIT = re.compile(r"\s*(?:&|,|\+|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bx\b)\s*",
                           re.IGNORECASE)


def _artist_components(artist: str) -> List[str]:
    parts = [_norm(p) for p in _COLLAB_SPLIT.split(artist or "")]
    return [p for p in parts if p]


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
        matched = artists & ({a} | set(_artist_components(s.get("artist", ""))))
        if matched:
            golden.add(s["songId"])
            seen_artists.update(matched)
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


# ── junk-text gate (owner catch, 2026-07-30) ────────────────────────────────────
# Scraped lyric pages carry two failure modes the rhyme benchmark cannot survive:
#   * TRANSCRIPTION HOLES — '???' where the transcriber could not hear the word.
#     A masked item built beside one asks the model to rhyme with a hole.
#   * NON-ENGLISH lyrics. The phonology engine is an English lexicon; a Turkish or
#     Spanish bar yields OOV phones, a meaningless rhyme partner and an
#     unguessable answer. Measured on the 26,097-song corpus: 102 songs (0.4%)
#     with '???', 152 (0.6%) with heavy non-ASCII.
# Both are QUARANTINED rather than dropped, so the count stays visible in the
# split report instead of quietly shrinking the corpus.
_QMARK_RUN = re.compile(r"\?{3,}")


def _song_text(song: dict) -> str:
    return "\n".join(l for sec in song.get("sections", []) or []
                      for l in (sec.get("lines") or []))


def is_junk_text(song: dict, *, non_ascii_max: float = 0.02) -> str:
    """'' when the song is usable, else a short reason code.

    `non_ascii_max` is a RATE, not a count: a long English song legitimately
    carries a few accented names or curly quotes, while a Turkish lyric is
    non-ASCII throughout. 2% over the whole song separates them without
    punishing 'Beyoncé'.
    """
    text = _song_text(song)
    # NO length rule here on purpose: short songs were never reported as a problem,
    # and a speculative min-length quarantined every fixture in build_eval_test.
    # Only the two DEFECTS the owner actually found are gated.
    if _QMARK_RUN.search(text):
        return "transcription-holes"
    non_ascii = sum(1 for c in text if ord(c) > 127)
    if non_ascii / max(1, len(text)) > non_ascii_max:
        return "non-english"
    return ""


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
    junk: Dict[str, int] = {}
    for s in songs:
        sid = s["songId"]
        if sid in drops:
            splits[sid] = "dropped"
        elif sid in golden_ids:
            splits[sid] = "golden"
        elif dedup.containment(dedup.shingles(s), pool) >= near_dup_threshold:
            splits[sid] = "quarantined"
            quarantined.append(sid)
        elif is_junk_text(s):
            # '???' transcription holes and non-English lyrics — see is_junk_text.
            # Quarantined (not dropped) so the reason stays countable in the report.
            splits[sid] = "quarantined"
            quarantined.append(sid)
            junk[is_junk_text(s)] = junk.get(is_junk_text(s), 0) + 1
        elif _hash_frac(salt, sid) < dev_frac:
            splits[sid] = "dev"
        else:
            splits[sid] = "train"

    counts: Dict[str, int] = {}
    for sp in splits.values():
        counts[sp] = counts.get(sp, 0) + 1
    report = {"quarantined": sorted(quarantined), "counts": counts,
              "junkText": junk, **unmatched}
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
