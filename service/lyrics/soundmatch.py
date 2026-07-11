"""soundmatch — does a written line ECHO the mumble's sound?

The count-only fit metric let an invented line unrelated to the take score 100%. This scores
the ASSONANCE instead: how closely a candidate's vowel backbone (stress-stripped ARPAbet
vowels, via the phonology core) matches the mumble fragment's. It's what lets us pick real
words that sound like what was mumbled, and show an honest "sounds like your take" number.

Pure + deterministic (difflib.SequenceMatcher over vowel sequences).
"""
from __future__ import annotations

import difflib
import re
from typing import List, Optional, Tuple

from phonology import core as ph

_pronouncer: Optional[ph.Pronouncer] = None


def _pron() -> ph.Pronouncer:
    global _pronouncer
    if _pronouncer is None:
        _pronouncer = ph.Pronouncer()
    return _pronouncer


def _clean(word: str) -> str:
    return re.sub(r"[^a-z']", "", word.lower())


def vowel_backbone(text: str, pron: Optional[ph.Pronouncer] = None) -> List[str]:
    """The stress-stripped vowel sequence of a line — its assonance skeleton. Gap tokens
    (`___`) and unpronounceable junk contribute nothing."""
    pron = pron or _pron()
    out: List[str] = []
    for w in str(text or "").split():
        c = _clean(w)
        if not c:
            continue
        out.extend(ph.vowels_of(pron.phones(c) or []))
    return out


def similarity(a_text: str, b_text: str, pron: Optional[ph.Pronouncer] = None) -> float:
    """0..1 — how much line `a` sounds like line `b` (vowel-sequence overlap). 1.0 when the
    backbones match; two empty backbones count as identical, one empty as no match."""
    pron = pron or _pron()
    va = vowel_backbone(a_text, pron)
    vb = vowel_backbone(b_text, pron)
    if not va and not vb:
        return 1.0
    if not va or not vb:
        return 0.0
    return difflib.SequenceMatcher(None, va, vb).ratio()


def rank(candidates: List[str], target: str, pron: Optional[ph.Pronouncer] = None) -> List[Tuple[str, float]]:
    """Rank candidate lines by how much they echo `target`, closest first. Stable: ties keep
    input order (Python's sort is stable; we sort by score only)."""
    pron = pron or _pron()
    scored = [(c, similarity(c, target, pron)) for c in candidates]
    scored.sort(key=lambda cs: cs[1], reverse=True)
    return scored
