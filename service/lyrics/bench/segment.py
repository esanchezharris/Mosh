"""Genius-style lyric text → normalized song record (FMS lyrics-bench I1).

Pure stdlib, deterministic. Sections are load-bearing downstream: whole-line masking
needs same-section context, and choruses (which repeat) are a dedup/triviality vector.

Deliberate non-goal: NO register/profanity filtering of any kind — the raw register is
the point of the corpus. The only line drops are non-lyric artifacts (scrape debris,
stage directions) documented below.
"""
from __future__ import annotations

import hashlib
import re
from typing import Dict, List

# [Verse 1: Some Artist] / [Chorus] / [Hook] — bracket header on its own line.
_HEADER_RE = re.compile(r"^\[([^\]]{1,80})\]$")
# Genius scrape debris glued to the final line: optional "You might also like",
# optional view-count digits, then "Embed".
_EMBED_RE = re.compile(r"(?:You might also like)?\d*Embed$")
_WS_RE = re.compile(r"\s+")
# A line that is ONLY a *stage direction* (fully wrapped in asterisks).
_STAGE_RE = re.compile(r"^\*[^*]+\*$")

_KINDS = ("intro", "verse", "chorus", "hook", "bridge", "outro")

_QUOTE_MAP = str.maketrans({
    "‘": "'", "’": "'", "“": '"', "”": '"',
    "–": "-", "—": "-", " ": " ",
})


def _kind_of(label: str) -> str:
    head = label.split(":", 1)[0].strip().lower()
    first = head.split(" ", 1)[0] if head else ""
    return first if first in _KINDS else "other"


def _clean_line(line: str) -> str:
    line = line.translate(_QUOTE_MAP)
    line = _EMBED_RE.sub("", line)
    line = _WS_RE.sub(" ", line).strip()
    return line


def parse_sections(raw_text: str) -> List[Dict]:
    """Split raw lyric text into [{kind, label, lines[]}] sections.

    Headered songs split on bracket headers; headerless songs split on blank lines
    (default kind "verse"). Empty sections are dropped.
    """
    sections: List[Dict] = []
    cur: Dict = {"kind": "verse", "label": "", "lines": []}
    saw_header = False

    def flush():
        if cur["lines"]:
            sections.append({"kind": cur["kind"], "label": cur["label"],
                             "lines": list(cur["lines"])})
        cur["lines"] = []

    for raw_line in (raw_text or "").splitlines():
        stripped = raw_line.strip()
        m = _HEADER_RE.match(stripped)
        if m:
            flush()
            saw_header = True
            label = _WS_RE.sub(" ", m.group(1).translate(_QUOTE_MAP)).strip()
            cur["kind"] = _kind_of(label)
            cur["label"] = label
            continue
        if not stripped:
            if not saw_header:
                flush()
                cur["kind"], cur["label"] = "verse", ""
            continue
        line = _clean_line(stripped)
        if not line:
            continue
        if line == "You might also like" or _STAGE_RE.match(line):
            continue
        cur["lines"].append(line)
    flush()
    return sections


def make_song(*, song_id: str, source: str, artist: str, title: str, genre: str,
              views: int, license_tier: str, raw_text: str) -> Dict:
    """Build the normalized song record. `hash` covers the normalized content only,
    so re-scrapes with different debris but identical lyrics hash the same."""
    sections = parse_sections(raw_text)
    h = hashlib.sha1()
    for s in sections:
        h.update(s["kind"].encode("utf-8"))
        for ln in s["lines"]:
            h.update(b"\n")
            h.update(ln.encode("utf-8"))
        h.update(b"\n--\n")
    return {
        "songId": song_id, "source": source, "artist": artist, "title": title,
        "genre": genre, "views": int(views), "licenseTier": license_tier,
        "sections": sections, "hash": "sha1:" + h.hexdigest(),
    }
