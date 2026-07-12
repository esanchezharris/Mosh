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


# ── v2: GRADED mouth-space similarity (the mouth-shape round, 2026-07-12) ──────────────
# Exact-symbol vowel matching can't hear that "bit" nearly echoes "beat" while "bot" does
# not. Vowels live in a mouth space — tongue height, backness, lip rounding — so grade by
# distance in it. Onsets (the consonant that shapes the syllable's attack) are graded by
# place of articulation: B~P (both lips) is close, B~K is not.

_VOWEL_SPACE = {
    # ARPAbet vowel -> (height 0=open..1=close, backness 0=front..1=back, rounded)
    "IY": (1.00, 0.00, 0), "IH": (0.80, 0.15, 0), "EH": (0.50, 0.20, 0), "AE": (0.20, 0.25, 0),
    "AA": (0.00, 0.80, 0), "AO": (0.15, 0.95, 1), "UH": (0.80, 0.85, 1), "UW": (1.00, 1.00, 1),
    "AH": (0.40, 0.55, 0), "ER": (0.55, 0.50, 0),
    # diphthongs sit at their start point; the glide adds a mismatch penalty below
    "EY": (0.60, 0.10, 0), "AY": (0.10, 0.40, 0), "OY": (0.30, 0.90, 1),
    "AW": (0.10, 0.60, 0), "OW": (0.45, 0.90, 1),
}
_GLIDE = {"EY": "Y", "AY": "Y", "OY": "Y", "AW": "W", "OW": "W"}
_MAX_VDIST = 1.6   # normalization: farther than this reads as "different mouth"

_ONSET_CLASS = {
    "B": "lips", "P": "lips", "M": "lips", "W": "lips",
    "F": "labdent", "V": "labdent",
    "TH": "dental", "DH": "dental",
    "T": "alveolar", "D": "alveolar", "N": "alveolar", "S": "alveolar",
    "Z": "alveolar", "L": "alveolar", "R": "alveolar",
    "SH": "post", "ZH": "post", "CH": "post", "JH": "post", "Y": "post",
    "K": "velar", "G": "velar", "NG": "velar",
    "HH": "glottal",
}


def _strip(phone: str) -> str:
    return re.sub(r"\d", "", str(phone or "")).upper()


def vowel_similarity(a: str, b: str) -> float:
    """0..1 — how close two ARPAbet vowels are in mouth space (stress digits ignored)."""
    a, b = _strip(a), _strip(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    ca, cb = _VOWEL_SPACE.get(a), _VOWEL_SPACE.get(b)
    if ca is None or cb is None:
        return 0.0
    d2 = (ca[0] - cb[0]) ** 2 + (ca[1] - cb[1]) ** 2 + 0.1 * (ca[2] - cb[2]) ** 2
    d = d2 ** 0.5
    if _GLIDE.get(a) != _GLIDE.get(b):
        d += 0.15
    return max(0.0, 1.0 - d / _MAX_VDIST)


def onset_similarity(a: Optional[str], b: Optional[str]) -> float:
    """0..1 — attack-consonant closeness by place of articulation. A missing onset on
    either side is neutral-ish (0.5): a bare vowel neither matches nor fights an attack."""
    a, b = (_strip(a) if a else None), (_strip(b) if b else None)
    if a == b:
        return 1.0
    if a is None or b is None:
        return 0.5
    if _ONSET_CLASS.get(a) and _ONSET_CLASS.get(a) == _ONSET_CLASS.get(b):
        return 0.7
    return 0.2


def syllable_sounds(word: str, pron: Optional[ph.Pronouncer] = None) -> List[dict]:
    """A word's per-syllable mouth profile: [{"vowel": "AO", "onset": "W"}, ...] in order.
    An OOV word (no phones from the lexicon/g2p) still OCCUPIES its syllables as
    unmatchable placeholders ({"vowel": None, "onset": None} × heuristic count) — silently
    dropping it let a slang-heavy line vanish most of its sequence and grade only on its
    dictionary words (adversarial-review confirmed exploit). Empty/junk input yields []."""
    pron = pron or _pron()
    c = _clean(word)
    if not c:
        return []
    phones = pron.phones(c)
    if not phones:
        return [{"vowel": None, "onset": None}] * max(1, pron.syllables(c) or 1)
    out = []
    for group in ph.syllabify_phones(phones):
        vowel, onset = None, None
        for p in group:
            if re.search(r"\d$", p):
                vowel = _strip(p)
                break
            onset = _strip(p) if onset is None else onset
        if vowel:
            out.append({"vowel": vowel, "onset": onset})
    return out


def text_sounds(text: str, pron: Optional[ph.Pronouncer] = None) -> List[dict]:
    """Ordered syllable sounds of a whole line (gap tokens contribute nothing)."""
    pron = pron or _pron()
    out: List[dict] = []
    for w in str(text or "").split():
        out.extend(syllable_sounds(w, pron))
    return out


# Any two vowels score ~0.45 by accident in a small mouth space; subtracting that base
# keeps chance proximity from inflating scores (calibrated on the Used2 back half:
# sound-alike lines >=0.68, mouth-blind lines <=0.36 after sharpening).
_PAIR_BASE = 0.45


def _pair_score(a: dict, b: dict) -> float:
    s = 0.7 * vowel_similarity(a.get("vowel"), b.get("vowel")) \
        + 0.3 * onset_similarity(a.get("onset"), b.get("onset"))
    return max(0.0, (s - _PAIR_BASE) / (1.0 - _PAIR_BASE))


_WINDOW_SLACK = 2   # extra syllables of local wiggle inside each alignment window


def _dp_align(a: List[dict], b: List[dict]) -> float:
    prev = [0.0] * (len(b) + 1)
    for i in range(1, len(a) + 1):
        cur = [0.0] * (len(b) + 1)
        for j in range(1, len(b) + 1):
            cur[j] = max(prev[j - 1] + _pair_score(a[i - 1], b[j - 1]), prev[j], cur[j - 1])
        prev = cur
    return prev[len(b)]


def sound_sequence_similarity(a: List[dict], b: List[dict]) -> float:
    """0..1 — best LOCALIZED monotonic alignment of two syllable-sound sequences,
    normalized by the shorter length. The shorter sequence must echo a contiguous
    STRETCH of the longer one (a sliding window of shorter+slack syllables): Whisper
    hears the take's full activity while the line's count is fixed by the slot grid, so
    a line legitimately echoes a stretch of the movie — but a global free-gap alignment
    let long mouth-blind lines cherry-pick in-order matches across their whole length
    (adversarial-review confirmed: unrelated lines cleared the hard floor, and padding a
    line monotonically RAISED its score). Deterministic."""
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    n, win = len(short), min(len(long_), len(short) + _WINDOW_SLACK)
    best = 0.0
    for w0 in range(0, len(long_) - win + 1):
        best = max(best, _dp_align(short, long_[w0:w0 + win]))
    return best / n


def mouth_similarity(text: str, targets: List[dict], pron: Optional[ph.Pronouncer] = None) -> float:
    """0..1 — how much a candidate line's mouth movie matches the take's heard sounds.
    Empty targets are neutral (1.0): no evidence means no constraint."""
    if not targets:
        return 1.0
    return sound_sequence_similarity(text_sounds(text, pron), list(targets))
