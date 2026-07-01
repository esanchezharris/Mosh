"""Research posture — true by construction, not asserted.

Discovery via yt-dlp search; media (when fetched) is a TRANSIENT, hash-recorded analysis
cache, not a retained/redistributed corpus; provenance + license travel on every row;
Creative-Common sources are weighted up where quality is comparable; everything local;
dedup by content_hash. (Pure-research posture per the owner; not legal advice.)
"""
from __future__ import annotations

import hashlib
from pathlib import Path

CACHE_DIRNAME = ".media-cache"  # transient analysis cache; safe to delete anytime
CC_RANK_BOOST = 0.12            # nudge CC up when otherwise-comparable


def map_license(raw: object) -> str:
    """Normalize a yt-dlp/Data-API license value → youtube | creativeCommon | unknown."""
    if not raw:
        return "unknown"
    s = str(raw).strip().lower()
    if "creative commons" in s or s in ("creativecommon", "cc"):
        return "creativeCommon"
    return "youtube"


def content_hash_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def content_hash_file(path: str | Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for blk in iter(lambda: f.read(chunk), b""):
            h.update(blk)
    return h.hexdigest()


def cc_rank_boost(license: str) -> float:
    """Additive score nudge for Creative-Common sources (preferred, not required)."""
    return CC_RANK_BOOST if license == "creativeCommon" else 0.0


def cache_dir(root: str | Path) -> Path:
    return Path(root) / CACHE_DIRNAME
