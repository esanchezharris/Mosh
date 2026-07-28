#!/usr/bin/env python3
"""Product-side word-frequency table + the frequency-ranked rhyme truncation.

`Pronouncer.rhyme_search` sorts (grade, syllables, alphabetical) and truncates at
`max_n` AFTER the sort, so a cap kept the alphabetically-early slice of a big
rime family — `booz`/`brack`-class CMUdict entries survived while the word a
writer would use fell off the end. The FMS lyrics bench measured it (PROGRAM.md,
2026-07-28): truth-in-pool coverage at cap 200 was 40.0% alphabetical vs 89.3%
with a corpus-frequency tiebreak on the SAME candidate set. This module is the
product port of that finding:

  * `load_freq()` — a vendored general-English rank table (data/en_word_ranks.txt,
    provenance in data/README.md). The bench's table is derived from the owner's
    lyrics corpus and never ships; this one exists on every user machine.
    `MOSH_FREQ_TABLE` points elsewhere (e.g. the owner's corpus table).
  * `ranked_rhymes()` — the proven pipeline shape (bench `arms._rhyme_menu`
    rank="freq"): UNCAPPED scan with the freq tiebreak, stopword/len>=3 filter
    BEFORE the cap, then cap. The filter order is load-bearing: stopwords are the
    most frequent words in any corpus, so filtering after a freq-ranked cap lets
    them consume cap slots and then vanish, silently shrinking the pool.

Missing/empty table ⇒ byte-identical historical alpha behaviour (product
discipline: degrade, don't crash — unlike the bench, whose arms must raise
rather than silently answer from a differently-ordered pool).

Stdlib only, like the rest of the phonology package.
"""
from __future__ import annotations

import os
from typing import Dict, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PATH = os.path.join(HERE, "data", "en_word_ranks.txt")

# FROZEN product copy of the bench's stopword/filler union (lyrics/bench/mask.py),
# drift-pinned by equality test in phonology_freq_test.py. A frozen copy means a
# bench-side edit cannot silently change shipped /get_rhymes output — divergence
# reds the test and becomes a conscious decision. The list itself is a bench
# FINDING: raw frequency ranking answers 'been / an / a / they / but' (read off
# 400 real floor picks) — no writer ends a bar there.
STOP_AND_FILLER = frozenset({
    # stopwords
    "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "at", "for",
    "with", "is", "are", "was", "were", "be", "been", "am", "i", "im", "i'm",
    "you", "he", "she", "it", "we", "they", "my", "your", "his", "her", "its",
    "our", "their", "me", "him", "them", "us", "this", "that", "these", "those",
    "as", "so", "if", "then", "than", "too", "very", "just", "not", "no", "yes",
    "do", "does", "did", "done", "have", "has", "had", "will", "would", "can",
    "could", "should", "shall", "may", "might", "must", "up", "out", "down",
    "when", "what", "who", "how", "why", "where", "which", "while", "there",
    "here", "all", "any", "some", "one", "two", "get", "got", "gon", "gonna",
    "wanna", "into", "onto", "from", "till", "until", "'em", "em",
    # fillers / ad-libs
    "yeah", "yea", "uh", "uhh", "huh", "ay", "ayy", "aye", "ooh", "oh", "woah",
    "whoa", "la", "na", "da", "brr", "skrt", "skrrt", "grr", "ha", "hey", "yo",
    "okay", "ok", "mm", "mmm", "like",
})

_CACHE: Dict[str, Dict[str, int]] = {}


def load_freq(path: Optional[str] = None) -> Dict[str, int]:
    """The rank table as {word: N-i} — higher = more frequent, absent = 0.

    Values are synthetic ranks, not corpus counts (only the ORDER is meaningful;
    see data/README.md). Cached per resolved path. Missing/unreadable file loads
    as {} so every consumer degrades to the historical alpha path.
    """
    resolved = path or os.environ.get("MOSH_FREQ_TABLE") or DEFAULT_PATH
    if resolved in _CACHE:
        return _CACHE[resolved]
    words: List[str] = []
    seen = set()
    try:
        with open(resolved, "r", encoding="utf-8") as f:
            for line in f:
                w = line.strip().lower()
                if w and w not in seen:
                    seen.add(w)
                    words.append(w)
    except OSError:
        words = []
    table = {w: len(words) - i for i, w in enumerate(words)}
    _CACHE[resolved] = table
    return table


def ranked_rhymes(pron, word: str, strictness: str = "slant", max_n: int = 50,
                  syllables: Optional[int] = None,
                  freq: Optional[Dict[str, int]] = None) -> List[str]:
    """Rhyme candidates truncated by frequency rank, not alphabet.

    `freq=None` loads the product table; an EMPTY table (missing file, or an
    explicit {}) returns the plain capped alpha search byte-identically — the
    exact pre-2026-07-28 behaviour, no filter. With a table: uncapped scan with
    the freq tiebreak (grade and syllables still dominate — rhyme_search owns
    that ordering), stopword/len>=3 filter, THEN the cap.
    """
    table = load_freq() if freq is None else freq
    if not table:
        return pron.rhyme_search(word, strictness, max_n=max_n, syllables=syllables)
    menu = pron.rhyme_search(word, strictness, max_n=10 ** 9,
                             syllables=syllables, freq=table)
    kept = [w for w in menu if len(w) >= 3 and w.lower() not in STOP_AND_FILLER]
    return kept[:max_n]
