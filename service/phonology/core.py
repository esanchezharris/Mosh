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
# An ARPAbet phone token: 1+ uppercase letters + an optional stress digit (e.g. "K", "EY1").
# Used to filter g2p output, which interleaves spaces/punctuation between phones.
_ARPABET_RE = re.compile(r"^[A-Z]+[0-2]?$")


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


# ── Rhyme CRAFT (Bar IQ C): multisyllabic depth + internal-rhyme detection ────────

def vowels_of(phones: Sequence[str]) -> List[str]:
    """The stress-stripped vowel sequence (the backbone of multisyllabic / assonant rhyme)."""
    return [_strip_stress(p) for p in phones if _is_vowel(p)]


def multisyllabic_depth(a: Sequence[str], b: Sequence[str]) -> int:
    """How many TRAILING syllables rhyme = the length of the longest common suffix of the two
    vowel sequences. depth 1 = a plain end-rhyme; depth >= 2 = a multisyllabic rhyme (what
    separates skilled bars from nursery rhymes). Deterministic + symmetric."""
    va, vb = vowels_of(a), vowels_of(b)
    depth = 0
    for x, y in zip(reversed(va), reversed(vb)):
        if x != y:
            break
        depth += 1
    return depth


def internal_rhyme_pairs(words_phones: Sequence, strictness: str = "slant") -> List[tuple]:
    """Rhyming word-index pairs WITHIN a line (a hallmark of skilled flow). Input: a sequence
    of (word, phones); output: sorted (i, j) pairs (i<j) whose rimes rhyme at `strictness`,
    excluding identical words. Deterministic."""
    out = []
    n = len(words_phones)
    for i in range(n):
        wi, pi = words_phones[i]
        if not pi:
            continue
        for j in range(i + 1, n):
            wj, pj = words_phones[j]
            if not pj or str(wi).lower() == str(wj).lower():
                continue
            if _grade_passes(rhyme_grade(pi, pj), strictness):
                out.append((i, j))
    return out


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
    """Word-level phonology over a LAYERED lexicon, first hit wins (Bar IQ A):

        1. user lexicon  — words the producer added/corrected (their ear overrides all)
        2. cmudict       — authoritative for standard English
        3. g2p           — grapheme→phoneme, pronounces ANYTHING (slang/coined/NSFW) → ARPAbet
        4. heuristic     — vowel-group fallback (only when phones can't be had at all)

    With g2p in the chain, `rhyme()` runs the real phoneme-based grade for almost any word
    instead of a spelling guess — so slang rhymes are graded correctly and the generation
    validator can verify them.

    `lexicon` = word(lower) → [pronunciation, …] (None loads cmudict if available).
    `user_lexicon` = word(lower) → a single phone list (overrides everything).
    `g2p` = callable(word) → phone list | None. None ⇒ lazily load g2p_en on first OOV
    (graceful: marks unavailable if it can't import — the heuristic then covers OOV). Pass a
    callable that returns None to disable the g2p layer."""

    def __init__(self, lexicon: Optional[Mapping[str, List[Phones]]] = None,
                 user_lexicon: Optional[Mapping[str, Phones]] = None,
                 g2p: Optional[Callable[[str], Optional[Phones]]] = None):
        self._lexicon: Mapping[str, List[Phones]] = (
            lexicon if lexicon is not None else _real_lexicon()
        )
        self._user: Dict[str, Phones] = {k.lower(): list(v) for k, v in (user_lexicon or {}).items()}
        self._g2p = g2p            # callable, or None ⇒ lazy-load g2p_en
        self._g2p_tried = g2p is not None
        self._g2p_cache: Dict[str, Optional[Phones]] = {}

    def _g2p_phones(self, word: str) -> Optional[Phones]:
        """Pronounce an OOV word via g2p (ARPAbet). Lazily loads g2p_en once; memoized
        per word (deterministic); never raises — degrades to None so the heuristic covers it."""
        if self._g2p is None and not self._g2p_tried:
            self._g2p_tried = True
            try:
                from g2p_en import G2p  # type: ignore
                self._g2p = G2p()
            except Exception:  # noqa: BLE001 (absent/broken g2p_en → heuristic-only)
                self._g2p = None
                return None
        if self._g2p is None:
            return None
        wl = word.lower()
        if wl in self._g2p_cache:
            cached = self._g2p_cache[wl]
            return list(cached) if cached else None
        try:
            raw = self._g2p(word) or []
            # g2p_en interleaves spaces/punctuation between phones — keep ARPAbet tokens only.
            phones = [p for p in raw if _ARPABET_RE.match(p)]
        except Exception:  # noqa: BLE001
            phones = []
        self._g2p_cache[wl] = phones or None
        return list(phones) if phones else None

    def phones(self, word: str) -> Optional[Phones]:
        wl = word.lower()
        if wl in self._user:
            return list(self._user[wl])
        prons = self._lexicon.get(wl)
        if prons:
            return list(prons[0])
        return self._g2p_phones(word)

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
    qphones = p.phones(word)
    return {
        "ok": True,
        "word": word,
        "strictness": strictness,
        "inDict": qphones is not None,
        "queryPhones": qphones,   # lets the caller merge palette rhymes without re-pronouncing
        "candidates": [{"word": w, "syllables": p.syllables(w),
                        "grade": rhyme_grade(qphones or [], p.phones(w) or [])}
                       for w in words],
    }
