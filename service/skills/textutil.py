#!/usr/bin/env python3
"""Shared, dependency-free text utilities for the skills miner and router.

Everything here is a pure function over strings (no I/O, no network, no ML) —
deterministic tokenization, a note-name -> MIDI parser, and a handful of
regex-based numeric extractors (dB, percent, fraction, bpm). `mine.py` uses
the tokenizer + IDF machinery to cluster corpus rows; `router.py` reuses the
SAME tokenizer (so retrieval scoring is consistent with how skills were
mined) plus the numeric/note extractors for slot-filling.
"""
from __future__ import annotations

import math
import re
from collections import Counter
from typing import Iterable, Sequence

# ── tokenization ──────────────────────────────────────────────────────────

# A short, hand-reviewed function-word list (articles, pronouns, prepositions,
# generic verbs). This is intentionally small: the real disambiguating power
# comes from IDF over the corpus itself (see `idf_table` / `derive_slot_nouns`
# below), not from a big hand-tuned stopword list.
STOPWORDS = frozenset(
    """
    a an the to of on in at for with and or but is are was were be been being
    this that these those it its it's i you he she we they me him her us them
    my your his our their as by from into onto up down over under around
    back off out again then than so if not no do does did done can could will
    would should may might just really quite bit little more most some any all
    each every please want i'd like lets let go get got make made put
    """.split()
)

# Matches unix-ish file paths (2+ "/segment" runs) so words inside them
# ("Users", "Music", "mosh-sft-assets") never leak into tokens.
_FILE_PATH_RE = re.compile(r"(?:/[\w.\-]+){2,}")


def strip_paths(text: str) -> str:
    return _FILE_PATH_RE.sub(" ", text)


def tokenize(text: str) -> list[str]:
    """Lowercase, drop file paths, split on non-letters, drop stopwords + short tokens."""
    cleaned = strip_paths(text).lower()
    toks = re.findall(r"[a-z][a-z']+", cleaned)
    return [t for t in toks if t not in STOPWORDS and len(t) > 2]


def idf_table(documents: Sequence[str]) -> dict[str, float]:
    """Smoothed IDF over a corpus of raw text documents, keyed by token.

    idf(t) = ln((N+1)/(df(t)+1)) + 1 — always positive, monotonically lower
    for tokens that recur across many documents (generic words), higher for
    rare/distinguishing ones. Used both to pick cluster anchors (mine.py) and
    to weight retrieval overlap (router.py); both sides recompute it from the
    same corpus so results are unaffected by import order.
    """
    n = len(documents)
    df: Counter[str] = Counter()
    for doc in documents:
        df.update(set(tokenize(doc)))
    return {t: math.log((n + 1) / (c + 1)) + 1 for t, c in df.items()}


def derive_slot_nouns(texts: Sequence[str], min_count: int = 2) -> set[str]:
    """Self-derive a blocklist of likely track/instrument-name nouns.

    Two purely mechanical signals, both computed from the corpus itself (no
    hardcoded instrument list):
      1. Words capitalized mid-sentence (proper nouns like "Bass", "Melody").
      2. Words recurring as "the X" or "X track" (lowercase references like
         "the hats", "the vocal").
    Used to keep incidental subject nouns from winning as cluster anchors
    over the verb that actually names the operation (see mine.py).
    """
    caps: set[str] = set()
    for text in texts:
        cleaned = strip_paths(text)
        words = re.findall(r"[A-Za-z][A-Za-z']*", cleaned)
        for i, w in enumerate(words):
            if i == 0:
                continue  # sentence-initial capitalization doesn't count
            if w[:1].isupper() and len(w) > 2:
                caps.add(w.lower())

    the_pattern: Counter[str] = Counter()
    for text in texts:
        cleaned = strip_paths(text).lower()
        for m in re.finditer(r"\bthe\s+([a-z]+)\b", cleaned):
            the_pattern[m.group(1)] += 1
        for m in re.finditer(r"\b([a-z]+)\s+track\b", cleaned):
            the_pattern[m.group(1)] += 1

    return caps | {w for w, c in the_pattern.items() if c >= min_count}


# ── note names -> MIDI ───────────────────────────────────────────────────

_PITCH_CLASS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
# Scientific pitch notation, C4 = 60 (matches the corpus: A1=33, C#2=37 ...).
NOTE_NAME_RE = re.compile(r"\b([A-G])(#|b)?(-?\d{1,2})\b")


def note_name_to_midi(letter: str, accidental: str | None, octave: str | int) -> int:
    semis = _PITCH_CLASS[letter.upper()]
    if accidental == "#":
        semis += 1
    elif accidental == "b":
        semis -= 1
    return (int(octave) + 1) * 12 + semis


def parse_note_names(text: str) -> list[int]:
    """Extract an ORDERED list of MIDI pitches from explicit note names in text.

    e.g. "A1, C#2, E2, A2" -> [33, 37, 40, 45]. Returns [] when no note names
    are present (the caller decides what a generated default should be).
    """
    cleaned = strip_paths(text)
    return [note_name_to_midi(*m) for m in NOTE_NAME_RE.findall(cleaned)]


# ── numeric / unit extractors ────────────────────────────────────────────

_DB_RE = re.compile(r"(-?\d+(?:\.\d+)?)\s*db\b", re.IGNORECASE)
_PERCENT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*%")
_FRACTION_RE = re.compile(r"\b(\d{1,2})\s*/\s*(\d{1,2})\b")
_BPM_RE = re.compile(r"(\d{2,3})\s*(?:bpm)\b", re.IGNORECASE)
_TRAILING_BPM_RE = re.compile(r"\bto\s+(\d{2,3})\b")
_NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?")
_TRACK_NUM_RE = re.compile(r"\btrack\s+(\d+)\b", re.IGNORECASE)
_NOTE_NUM_RE = re.compile(r"\bnote\s+(\d+)\b", re.IGNORECASE)
_PAD_NUM_RE = re.compile(r"\bpad\s+(\d+)\b", re.IGNORECASE)


def extract_db(text: str) -> float | None:
    m = _DB_RE.search(text)
    return float(m.group(1)) if m else None


def extract_percent(text: str) -> float | None:
    m = _PERCENT_RE.search(text)
    return float(m.group(1)) if m else None


def extract_fraction(text: str) -> tuple[int, int] | None:
    m = _FRACTION_RE.search(text)
    return (int(m.group(1)), int(m.group(2))) if m else None


def extract_bpm(text: str) -> float | None:
    m = _BPM_RE.search(text)
    if m:
        return float(m.group(1))
    # "slow it down to 80" (no explicit unit) — only used as a fallback by
    # callers that already know tempo is in play (e.g. after "tempo"/"bpm"/
    # "slow"/"speed" appears elsewhere in the text).
    m = _TRAILING_BPM_RE.search(text)
    return float(m.group(1)) if m else None


def extract_numbers(text: str) -> list[float]:
    cleaned = strip_paths(text)
    return [float(x) for x in _NUMBER_RE.findall(cleaned)]


def extract_track_number(text: str) -> str | None:
    m = _TRACK_NUM_RE.search(text)
    return m.group(1) if m else None


def extract_note_number(text: str) -> int | None:
    m = _NOTE_NUM_RE.search(text) or _PAD_NUM_RE.search(text)
    return int(m.group(1)) if m else None


def kebab(text: str) -> str:
    """snake_case / words / Anchor -> kebab-case."""
    text = text.strip().lower().replace("_", "-")
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return re.sub(r"-+", "-", text).strip("-")
