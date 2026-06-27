#!/usr/bin/env python3
"""Deterministic phonology core (Finish-My-Song §4) — the actual IP.

No LLM, no network, no audio. Pure functions over ARPAbet phone lists plus a
`Pronouncer` that looks pronunciations up in a lexicon (the real cmudict when the
optional `cmudict`/`pronouncing` package is importable, an injected dict in tests,
or nothing — in which case it degrades to a stdlib vowel-group heuristic).

ARPAbet convention: a phone is a VOWEL iff its last char is a stress digit
  0 = unstressed · 1 = primary stress · 2 = secondary stress
e.g. "table" -> ["T","EY1","B","AH0","L"]  (2 vowels -> 2 syllables, stress "Xx").

Rhyme is graded over the RIME (from the last stressed vowel to the end) and is
PHONEME-based, never spelling-based:
  perfect = same vowel + same coda      (cat/hat, flame/name)
  slant   = same vowel XOR same coda    (cat/bad assonance, love/move consonance)
  none    = neither                     (cat/dog)
'love'/'move' look like a rhyme on paper but are only a SLANT rhyme (AH-V vs UW-V).

This is the single source of truth: it runs in-process in the service for fast
`get_rhymes`, and in the dedicated phonology venv (via phonology_cli.py) for the
precise dictionary path. The UI does its own instant vowel-group estimate locally.
"""
from __future__ import annotations

import re
from typing import Callable, Dict, List, Mapping, Optional, Sequence

Phones = List[str]

# ── Phone-level primitives (dictionary-free, fully deterministic) ────────────────

_STRESS_RE = re.compile(r"\d$")
_VOWELS = "aeiouy"


def _is_vowel(phone: str) -> bool:
    """A phone is a vowel iff it carries a stress digit (ARPAbet convention)."""
    return bool(phone) and phone[-1].isdigit()


def syllable_count_phones(phones: Sequence[str]) -> int:
    """Syllable count = number of vowel phones."""
    return sum(1 for p in phones if _is_vowel(p))


def stress_contour_phones(phones: Sequence[str]) -> str:
    """Per-syllable contour: 'X' for primary/secondary (1/2), 'x' for unstressed (0)."""
    out = []
    for p in phones:
        if _is_vowel(p):
            out.append("X" if p[-1] in ("1", "2") else "x")
    return "".join(out)


def _strip_stress(phone: str) -> str:
    return _STRESS_RE.sub("", phone)


def rime_phones(phones: Sequence[str]) -> Phones:
    """The rhyming tail: from the last STRESSED vowel (else the last vowel) to the end."""
    seq = list(phones)
    idx = -1
    for i, p in enumerate(seq):
        if _is_vowel(p) and p[-1] in ("1", "2"):
            idx = i
    if idx < 0:
        for i, p in enumerate(seq):
            if _is_vowel(p):
                idx = i
    return seq[idx:] if idx >= 0 else []


def _split_rime(rime: Sequence[str]):
    """(vowel-without-stress, coda-tuple) for grading."""
    if not rime:
        return ("", ())
    return (_strip_stress(rime[0]), tuple(_strip_stress(p) for p in rime[1:]))


def rhyme_grade(a: Sequence[str], b: Sequence[str]) -> str:
    """'perfect' | 'slant' | 'none' over the rime (stress digit ignored)."""
    ra, rb = rime_phones(a), rime_phones(b)
    if not ra or not rb:
        return "none"
    va, ca = _split_rime(ra)
    vb, cb = _split_rime(rb)
    if va == vb and ca == cb:
        return "perfect"
    if va == vb or ca == cb:
        return "slant"
    return "none"


# ── Stdlib heuristic (used for OOV words and when no dictionary is present) ───────

def heuristic_syllables(word: str) -> int:
    """Vowel-group syllable estimate. Deterministic; reliable enough for a live meter."""
    w = re.sub(r"[^a-z]", "", word.lower())
    if not w:
        return 0
    count = 0
    prev_vowel = False
    for ch in w:
        is_v = ch in _VOWELS
        if is_v and not prev_vowel:
            count += 1
        prev_vowel = is_v
    # A silent trailing 'e' usually isn't its own syllable ("name") — but keep 'le'
    # ("table") which is.
    if w.endswith("e") and not w.endswith("le") and count > 1:
        count -= 1
    return max(1, count)


def _heuristic_rhyme(w1: str, w2: str) -> bool:
    """Crude spelling-tail fallback for two OOV words (shared last >=2 letters)."""
    a = re.sub(r"[^a-z]", "", w1.lower())
    b = re.sub(r"[^a-z]", "", w2.lower())
    if not a or not b or a == b:
        return a == b and bool(a)
    n = min(len(a), len(b), 3)
    return n >= 2 and a[-n:] == b[-n:]


def _grade_passes(grade: str, strictness: str) -> bool:
    if strictness == "perfect":
        return grade == "perfect"
    # "slant" (default) and anything else accept perfect+slant.
    return grade in ("perfect", "slant")


# ── The real cmudict lexicon (optional dependency, lazily loaded + cached) ────────

_REAL_LEXICON: Optional[Dict[str, List[Phones]]] = None
_REAL_TRIED = False


def _real_lexicon() -> Dict[str, List[Phones]]:
    """cmudict as {word: [pronunciation, ...]} or {} if the package is unavailable."""
    global _REAL_LEXICON, _REAL_TRIED
    if _REAL_TRIED:
        return _REAL_LEXICON or {}
    _REAL_TRIED = True
    try:
        import cmudict  # type: ignore
        _REAL_LEXICON = {w: [list(p) for p in prons] for w, prons in cmudict.dict().items()}
    except Exception:  # noqa: BLE001  (package absent / load failure -> heuristic only)
        _REAL_LEXICON = {}
    return _REAL_LEXICON


class Pronouncer:
    """Word-level phonology over a lexicon, with a heuristic fallback for OOV words.

    `lexicon` is a mapping word(lowercase) -> list of pronunciations (each a phone
    list). None loads the real cmudict if available (else an empty lexicon)."""

    def __init__(self, lexicon: Optional[Mapping[str, List[Phones]]] = None):
        self._lexicon: Mapping[str, List[Phones]] = (
            lexicon if lexicon is not None else _real_lexicon()
        )

    def phones(self, word: str) -> Optional[Phones]:
        prons = self._lexicon.get(word.lower())
        return list(prons[0]) if prons else None

    def syllables(self, word: str) -> int:
        ph = self.phones(word)
        return syllable_count_phones(ph) if ph else heuristic_syllables(word)

    def stress(self, word: str) -> str:
        ph = self.phones(word)
        return stress_contour_phones(ph) if ph else ""

    def rhyme(self, w1: str, w2: str, strictness: str = "slant") -> bool:
        p1, p2 = self.phones(w1), self.phones(w2)
        if p1 and p2:
            grade = rhyme_grade(p1, p2)
        else:
            grade = "slant" if _heuristic_rhyme(w1, w2) else "none"
        return _grade_passes(grade, strictness)

    def rhyme_search(self, word: str, strictness: str = "slant",
                     max_n: int = 50, syllables: Optional[int] = None) -> List[str]:
        """Words from the lexicon whose rime rhymes with `word`, ranked + capped.

        Deterministic ranking: perfect before slant, then FEWER syllables first
        (short natural rhymes like 'hat' before 'aristocrat'), then alphabetical.
        Excludes the query word. `syllables`, when given, filters to that count."""
        target = self.phones(word)
        if not target:
            return []
        wl = word.lower()
        rank = {"perfect": 0, "slant": 1}
        scored = []
        for cand, prons in self._lexicon.items():
            if cand == wl or not prons:
                continue
            cp = prons[0]
            grade = rhyme_grade(target, cp)
            if not _grade_passes(grade, strictness):
                continue
            n_syl = syllable_count_phones(cp)
            if syllables is not None and n_syl != syllables:
                continue
            scored.append((rank.get(grade, 2), n_syl, cand))
        scored.sort()
        return [w for _, _, w in scored[:max_n]]


# ── A small convenience the service + CLI share ──────────────────────────────────

def get_rhymes(word: str, strictness: str = "slant", max_n: int = 50,
               syllables: Optional[int] = None,
               pronouncer: Optional[Pronouncer] = None) -> dict:
    """Ranked rhyme result envelope. Used by the service /get_rhymes and the CLI."""
    p = pronouncer or Pronouncer()
    words = p.rhyme_search(word, strictness=strictness, max_n=max_n, syllables=syllables)
    return {
        "ok": True,
        "word": word,
        "strictness": strictness,
        "inDict": p.phones(word) is not None,
        "candidates": [{"word": w, "syllables": p.syllables(w),
                        "grade": rhyme_grade(p.phones(word) or [], p.phones(w) or [])}
                       for w in words],
    }
