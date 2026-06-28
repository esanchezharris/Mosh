#!/usr/bin/env python3
"""Vocabulary palette (Bar IQ B) — the tagged word bank the rhyme tool + generation draw
from, so suggestions aren't limited to the formal dictionary.

"The data" is words + pronunciations + register tags — facts, not lyrics — so it's
copyright-clean. Passive-leaning: a bundled open SEED + auto-HARVEST from the §7 corpus (the
producer's own accepted lines) + the occasional manual add. Each entry stores its phones
(computed once at add time via the layered Pronouncer, so a slang word gets real g2p phones)
and a rhymeFamily, so palette rhyme search needs no model at query time and runs anywhere.

Backend-only management (the safety wall): stats() returns counts, never content. Stored as
JSONL alongside the §7 corpus under MOSH_LYRIC_CORPUS_DIR.
"""
from __future__ import annotations

import json
import os
import re
from typing import Callable, Dict, List, Optional

from phonology import core as phon
from lyrics.style_corpus import _content_tokens  # shared stopword-aware tokenizer

_WORD_RE = re.compile(r"[A-Za-z']+")
_REGISTERS = ("clean", "slang", "adlib", "profanity", "harvested")

# A small, license-clean open SEED — common rap vocabulary tagged by register (words are
# facts, not protected expression). Deliberately modest; the flywheel (harvest) + manual
# adds grow it. Profanity kept representative, not gratuitous — enough that clean-mode
# filtering is meaningful.
_SEED: List[tuple] = [
    # slang / imagery
    ("drip", "slang"), ("guap", "slang"), ("racks", "slang"), ("whip", "slang"),
    ("flexin", "slang"), ("finna", "slang"), ("trill", "slang"), ("plug", "slang"),
    ("lowkey", "slang"), ("vibe", "slang"), ("clout", "slang"), ("cap", "slang"),
    ("bands", "slang"), ("opps", "slang"), ("drip", "slang"), ("swerve", "slang"),
    ("stunt", "slang"), ("grind", "slang"), ("hustle", "slang"), ("bag", "slang"),
    # ad-libs
    ("yeah", "adlib"), ("skrrt", "adlib"), ("woah", "adlib"), ("uh", "adlib"),
    ("ayy", "adlib"), ("brr", "adlib"), ("gang", "adlib"),
    # profanity (representative — register-tagged so clean mode filters them)
    ("damn", "profanity"), ("hell", "profanity"), ("shit", "profanity"),
]


def default_palette_path() -> str:
    base = os.environ.get("MOSH_LYRIC_CORPUS_DIR") or os.path.join(
        os.path.expanduser("~"), "Library", "Mosh", "lyrics")
    return os.path.join(base, "vocab.jsonl")


def _clean(word: str) -> str:
    return re.sub(r"[^a-z']", "", (word or "").lower())


def _rhyme_family(phones: Optional[List[str]]) -> str:
    """A perfect-rhyme bucket key from the rime (stress-stripped). Two perfect-rhyming
    words share it; "" when there are no phones."""
    if not phones:
        return ""
    rime = phon.rime_phones(phones)
    return "_".join(re.sub(r"\d$", "", p) for p in rime)


def seed_words() -> List[tuple]:
    """The bundled open seed as deduped (word, register) pairs — the small generic set PLUS
    the rage/underground register pack (the Opium / Ken Carson / nettspend lane). First tag
    wins on a duplicate word. Words are facts (a glossary), never lyrics."""
    try:
        from lyrics.seeds_rage import RAGE_WORDS
    except Exception:  # noqa: BLE001
        RAGE_WORDS = []
    seen, out = set(), []
    for w, r in (_SEED + list(RAGE_WORDS)):
        cw = _clean(w)
        if cw and cw not in seen:
            seen.add(cw)
            out.append((cw, r))
    return out


class VocabPalette:
    """An opt-in, user-owned JSONL word bank. Entries: {word, register, tags, phones,
    rhymeFamily}. Exact-duplicate words are ignored on add."""

    def __init__(self, path: Optional[str] = None):
        self.path = path or default_palette_path()

    def entries(self, exclude_registers: Optional[List[str]] = None) -> List[dict]:
        ex = set(exclude_registers or [])
        out = []
        if os.path.isfile(self.path):
            try:
                with open(self.path, encoding="utf-8") as f:
                    for raw in f:
                        raw = raw.strip()
                        if not raw:
                            continue
                        e = json.loads(raw)
                        if e.get("register") not in ex:
                            out.append(e)
            except (OSError, json.JSONDecodeError):
                pass
        return out

    def _existing(self) -> set:
        return {e.get("word", "") for e in self.entries()}

    def add_words(self, words: List[str], register: str = "slang",
                  tags: Optional[List[str]] = None,
                  pronouncer: Optional[phon.Pronouncer] = None,
                  phones_map: Optional[Dict[str, Optional[List[str]]]] = None) -> int:
        """Append non-empty, non-duplicate words. Each gets phones + a rhymeFamily computed
        once: `phones_map` (pre-pronounced, e.g. via the phonology venv so slang gets real g2p
        phones) takes priority, else the `pronouncer`. Returns how many were new."""
        if register not in _REGISTERS:
            register = "slang"
        pm = {k.lower(): v for k, v in (phones_map or {}).items()}
        p = pronouncer if pronouncer is not None else phon.Pronouncer()
        existing = self._existing()
        fresh = []
        for w in words:
            cw = _clean(w)
            if not cw or cw in existing:
                continue
            existing.add(cw)
            phones = pm[cw] if cw in pm else p.phones(cw)
            fresh.append({"word": cw, "register": register, "tags": tags or [],
                          "phones": phones, "rhymeFamily": _rhyme_family(phones)})
        if fresh:
            os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as f:
                for e in fresh:
                    f.write(json.dumps(e, ensure_ascii=False) + "\n")
        return len(fresh)

    def harvest_from_corpus(self, lines: List[str],
                            pronouncer: Optional[phon.Pronouncer] = None,
                            phones_map: Optional[Dict[str, Optional[List[str]]]] = None) -> int:
        """Fold the CONTENT words of the producer's accepted lines into the palette (the
        flywheel). Stopwords dropped; tagged register='harvested'."""
        words: List[str] = []
        seen = set()
        for line in lines:
            for tok in _content_tokens(line if isinstance(line, str) else str(line)):
                if tok not in seen:
                    seen.add(tok)
                    words.append(tok)
        return self.add_words(words, register="harvested", pronouncer=pronouncer, phones_map=phones_map)

    def rhyme_search(self, query_phones: Optional[List[str]], strictness: str,
                     pronouncer: Optional[phon.Pronouncer] = None,
                     max_n: int = 50, exclude_registers: Optional[List[str]] = None) -> List[dict]:
        """Palette words whose rime rhymes with `query_phones`, ranked + capped. Deterministic:
        perfect before slant, fewer syllables first, then alphabetical. Self-matches (identical
        phones) are skipped so the query word doesn't rhyme with itself."""
        if not query_phones:
            return []
        rank = {"perfect": 0, "slant": 1}
        scored = []
        for e in self.entries(exclude_registers=exclude_registers):
            ph = e.get("phones")
            if not ph or ph == query_phones:
                continue
            grade = phon.rhyme_grade(query_phones, ph)
            if not phon._grade_passes(grade, strictness):
                continue
            scored.append((rank.get(grade, 2), phon.syllable_count_phones(ph), e["word"],
                           {"word": e["word"], "grade": grade,
                            "syllables": phon.syllable_count_phones(ph), "register": e.get("register", "")}))
        scored.sort(key=lambda t: (t[0], t[1], t[2]))
        return [t[3] for t in scored[:max_n]]

    def register_words(self, register: str) -> set:
        """The set of palette words tagged with `register` (e.g. 'profanity') — the registry
        clean mode uses to filter candidates wherever they appear (palette OR dictionary)."""
        return {e["word"] for e in self.entries() if e.get("register") == register}

    def stats(self) -> dict:
        """Counts only — never the content (the backend-only safety wall)."""
        rows = self.entries()
        regs: Dict[str, int] = {}
        for e in rows:
            regs[e.get("register", "")] = regs.get(e.get("register", ""), 0) + 1
        return {"ok": True, "words": len(rows), "registers": regs}


def load_palette(path: Optional[str] = None) -> VocabPalette:
    return VocabPalette(path)
