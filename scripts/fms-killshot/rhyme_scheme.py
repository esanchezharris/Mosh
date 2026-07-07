#!/usr/bin/env python3
"""Rhyme-scheme inference (FMS hybrid rewrite-and-sing, stage 3).

On a mumbled take of a NEW song we don't know the lyrics — but we can read the rhyme
SCHEME off the phrases that decoded clearly, then constrain each rewritten (mumble) line
to its slot in that scheme. This module answers "which lines are supposed to rhyme with
which," so the rewriter (service/lyrics/core.py) can rhyme a rewritten line to its clear
neighbour via a shared `rhymeGroup`.

Policy (v0, deterministic, stanza-scoped):
- Process lines in stanzas of up to 4.
- Within a stanza choose AABB (couplets — the default, most common in the owner's genre)
  or ABAB by whichever fits the CLEAR end-words: score a scheme +1 for each same-group
  clear pair that rhymes, -1 for each that clashes. ABAB only wins if it strictly beats
  AABB (couplets are the tie-break default).
- Mumble lines (no end-word) carry no evidence but still take their position's group, so a
  rewritten line rhymes to whatever clear line shares its group.
- Group labels are unique per stanza (A,B then C,D …) so rhymes never leak across stanzas.

Pure stdlib + the phonology core (cmudict/g2p when importable; heuristic fallback — a word
with no pronunciation simply never rhymes, it doesn't crash).
"""
from __future__ import annotations

from typing import List, Optional

from phonology import core as ph

STANZA = 4
_AABB = [(0, 1), (2, 3)]
_ABAB = [(0, 2), (1, 3)]

_pronouncer: Optional[ph.Pronouncer] = None


def _pron() -> ph.Pronouncer:
    global _pronouncer
    if _pronouncer is None:
        _pronouncer = ph.Pronouncer()
    return _pronouncer


def _end(line: dict) -> Optional[str]:
    w = line.get("endWord")
    return w if isinstance(w, str) and w.strip() else None


def _sub(scheme: str, pos: int) -> int:
    """Sub-group (0/1) of a position within its stanza."""
    return pos % 2 if scheme == "ABAB" else pos // 2


def _score(block: List[dict], pairs, strictness: str) -> int:
    """+1 for each same-group clear pair that rhymes, -1 for each that clashes."""
    s = 0
    for a, b in pairs:
        if a < len(block) and b < len(block):
            ea, eb = _end(block[a]), _end(block[b])
            if ea and eb:
                s += 1 if _pron().rhyme(ea, eb, strictness) else -1
    return s


def _choose(block: List[dict], strictness: str) -> str:
    """AABB (default) unless the clear end-words fit ABAB strictly better."""
    if len(block) < STANZA:
        return "AABB"                       # ABAB needs the full 4-line stanza
    return "ABAB" if _score(block, _ABAB, strictness) > _score(block, _AABB, strictness) else "AABB"


def infer_scheme(lines: List[dict], strictness: str = "slant") -> List[str]:
    """[{"endWord": str|None, "origin": ...}, ...] -> a rhyme-group label per line.

    endWord is the line's decoded final word (present for clear/partial lines, None for
    mumble). Labels are letters assigned in order of first appearance (A, B, C, …)."""
    ids: List[tuple] = []
    for start in range(0, len(lines), STANZA):
        block = lines[start:start + STANZA]
        scheme = _choose(block, strictness)
        stanza = start // STANZA
        for pos in range(len(block)):
            ids.append((stanza, _sub(scheme, pos)))
    # map (stanza, sub) ids -> A,B,C… in first-appearance order
    order: dict = {}
    for gid in ids:
        if gid not in order:
            order[gid] = chr(ord("A") + len(order))
    return [order[gid] for gid in ids]
