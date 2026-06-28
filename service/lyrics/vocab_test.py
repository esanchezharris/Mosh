#!/usr/bin/env python3
"""Golden tests for the vocabulary palette (Bar IQ B) — the tagged word bank the rhyme
tool + generation draw from, so suggestions aren't limited to the formal dictionary.

Passive-leaning: a bundled open SEED + auto-HARVEST from the §7 corpus (the producer's own
accepted lines) + the occasional manual add. "The data" is words + pronunciations + register
tags — facts, not lyrics — so it's copyright-clean.

Hermetic + deterministic: an INJECTED pronouncer (fixed lexicon, no g2p) gives stable phones;
the palette is pointed at a temp file. Run 3× → identical.

Run:  python3 service/lyrics/vocab_test.py     (exit 0 = all pass)
"""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from lyrics import vocab  # noqa: E402
from phonology import core as phon  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# A fixed lexicon so phones (and thus rhyme grading + rhymeFamily) are deterministic.
LEX = {
    "drip": [["D", "R", "IH1", "P"]],
    "whip": [["W", "IH1", "P"]],
    "flip": [["F", "L", "IH1", "P"]],
    "money": [["M", "AH1", "N", "IY0"]],
    "flame": [["F", "L", "EY1", "M"]],
}
P = phon.Pronouncer(lexicon=LEX, g2p=lambda w: None)  # no g2p → deterministic, dict-only


# ── 1. add_words: dedup, register + phones + rhymeFamily stored ───────────────────
with tempfile.TemporaryDirectory() as d:
    pal = vocab.VocabPalette(os.path.join(d, "vocab.jsonl"))
    n = pal.add_words(["drip", "Whip!", "drip"], register="slang", pronouncer=P)  # dup + punctuation
    check("add_words dedups + cleans (drip, whip = 2 added)", n == 2, str(n))
    entries = {e["word"]: e for e in pal.entries()}
    check("entry carries register", entries["drip"]["register"] == "slang")
    check("entry carries phones (from the pronouncer)", entries["drip"]["phones"] == ["D", "R", "IH1", "P"])
    check("entry carries a rhymeFamily", bool(entries["drip"].get("rhymeFamily")))
    check("rhyming words share a rhymeFamily (drip ~ whip)",
          entries["drip"]["rhymeFamily"] == entries["whip"]["rhymeFamily"], str(entries))
    check("persists to disk (a second reader sees them)",
          vocab.VocabPalette(os.path.join(d, "vocab.jsonl")).stats()["words"] == 2)

# ── 2. harvest_from_corpus: pulls CONTENT words from accepted lines ───────────────
with tempfile.TemporaryDirectory() as d:
    pal = vocab.VocabPalette(os.path.join(d, "vocab.jsonl"))
    added = pal.harvest_from_corpus(["the money on the flame", "i flip the whip"], pronouncer=P)
    words = {e["word"] for e in pal.entries()}
    check("harvest extracts content words (money, flame, flip, whip)",
          {"money", "flame", "flip", "whip"} <= words, str(sorted(words)))
    check("harvest drops stopwords (the, on, i)", not ({"the", "on", "i"} & words), str(sorted(words)))
    check("harvested words tagged register=harvested", all(e["register"] == "harvested" for e in pal.entries()))

# ── 3. rhyme_search over the palette finds slang candidates ───────────────────────
with tempfile.TemporaryDirectory() as d:
    pal = vocab.VocabPalette(os.path.join(d, "vocab.jsonl"))
    pal.add_words(["drip", "whip", "flip", "money"], register="slang", pronouncer=P)
    qp = P.phones("flame")  # query a word NOT in the palette
    none_match = pal.rhyme_search(P.phones("flame"), "slant", P)
    check("flame finds no palette rhyme (none share its rime)", none_match == [], str(none_match))
    hits = pal.rhyme_search(P.phones("drip"), "perfect", P)
    hit_words = [h["word"] for h in hits]
    check("drip's palette rhymes = whip, flip (perfect), excludes itself + money",
          set(hit_words) == {"whip", "flip"}, str(hit_words))
    check("palette rhyme hits carry register", all("register" in h for h in hits))
    check("rhyme_search deterministic", pal.rhyme_search(P.phones("drip"), "perfect", P) == hits)

# ── 4. register filter (clean mode excludes profanity-tagged words) ───────────────
with tempfile.TemporaryDirectory() as d:
    pal = vocab.VocabPalette(os.path.join(d, "vocab.jsonl"))
    pal.add_words(["drip"], register="slang", pronouncer=P)
    pal.add_words(["money"], register="profanity", pronouncer=P)  # pretend-tagged for the test
    clean = {e["word"] for e in pal.entries(exclude_registers=["profanity"])}
    check("clean mode excludes profanity-tagged words", clean == {"drip"}, str(sorted(clean)))
    check("default (raw) includes everything", {e["word"] for e in pal.entries()} == {"drip", "money"})

# ── 5. the open seed (generic + rage/underground register pack) ───────────────────
seed = vocab.seed_words()
seed_words_set = {w for w, _ in seed}
check("seed is substantial (generic + rage register pack)", len(seed) >= 120, str(len(seed)))
check("seed is deduped", len(seed_words_set) == len(seed))
check("seed entries are (word, register) with a known register",
      all(isinstance(w, str) and r in ("slang", "adlib", "profanity") for w, r in seed), str(seed[:3]))
seed_regs = {r for _, r in seed}
check("seed covers all three registers (slang/adlib/profanity)",
      {"slang", "adlib", "profanity"} <= seed_regs, str(sorted(seed_regs)))
check("rage register vocabulary present (e.g. rage, geeked, opps)",
      {"rage", "geeked", "opps"} <= seed_words_set, str(sorted(seed_words_set)[:8]))

# ── 6. stats are counts only (the backend-only safety wall) ───────────────────────
with tempfile.TemporaryDirectory() as d:
    pal = vocab.VocabPalette(os.path.join(d, "vocab.jsonl"))
    pal.add_words(["drip", "whip"], register="slang", pronouncer=P)
    st = pal.stats()
    check("stats reports word count", st["words"] == 2)
    check("stats reports registers, not content", "registers" in st and "words" in st and "entries" not in st)

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failure(s)")
sys.exit(len(fails))
