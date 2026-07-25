"""The 4 masking policies: word / rhyme / span / line (FMS lyrics-bench I1).

Pure stdlib + the phonology core (injected Pronouncer). No global RNG: every random
choice derives from sha256(POLICY_VERSION | songId | si | li | granularity), so the
same corpus + the same policy version produce byte-identical items forever. Bumping
POLICY_VERSION changes itemIds, so old runs can never silently mix with new items.

Filler/stopword exclusion below is an item-QUALITY decision (masking "yeah" or "the"
is a trivial item), not register sanitizing — profanity and slang are first-class
mask targets.
"""
from __future__ import annotations

import hashlib
import random
import re
from typing import Dict, List, Optional

POLICY_VERSION = "v1"

_WORD_RE = re.compile(r"[A-Za-z']+")
_BLANK = "____"

# Frozen local copy (pinned by the golden tests) of the stopword/filler union —
# deliberately NOT imported from style_corpus/flowspec so upstream edits can't
# silently drift item selection.
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

# Sections whose lines become mask targets. Choruses/hooks repeat (trivially
# guessable + dedup vector) and intros/outros are mostly ad-lib — verse flow is
# the register this benchmark measures.
_MASKABLE_KINDS = ("verse", "other")


def tokenize(text: str) -> List[str]:
    return [m.group(0) for m in _WORD_RE.finditer(text or "")]


def build_freq_table(songs: List[dict]) -> Dict[str, int]:
    """Document frequency (song count) per lowercased token — the POS-free
    'content-ness' proxy the word policy uses (low df ⇒ content word)."""
    df: Dict[str, int] = {}
    for song in songs:
        seen = set()
        for sec in song.get("sections", []):
            for line in sec.get("lines", []):
                for tok in tokenize(line):
                    seen.add(tok.lower())
        for tok in seen:
            df[tok] = df.get(tok, 0) + 1
    return df


def item_seed(song_id: str, si: int, li: int, granularity: str) -> int:
    key = f"{POLICY_VERSION}|{song_id}|{si}|{li}|{granularity}".encode("utf-8")
    return int.from_bytes(hashlib.sha256(key).digest()[:8], "big")


def _blank_out(line: str, token_indices: List[int]) -> str:
    """Replace the given token occurrences with blanks, preserving punctuation."""
    spans = [m.span() for m in _WORD_RE.finditer(line)]
    out, prev = [], 0
    for idx in sorted(token_indices):
        s, e = spans[idx]
        out.append(line[prev:s])
        out.append(_BLANK)
        prev = e
    out.append(line[prev:])
    return "".join(out)


def _eligible_word_indices(tokens: List[str]) -> List[int]:
    lowered = [t.lower() for t in tokens]
    return [i for i, t in enumerate(tokens[:-1])
            if len(t) >= 3 and t.lower() not in STOP_AND_FILLER
            # A duplicated token would stay visible elsewhere in the masked line,
            # making the item trivially guessable — require in-line uniqueness.
            and lowered.count(t.lower()) == 1]


def _phones_info(pron, word: str) -> dict:
    ph = pron.phones(word)
    return {
        "phones": list(ph) if ph else None,
        "phonesSource": "lexicon" if ph else "none",
        "syllables": pron.syllables(word),
        "stress": pron.stress(word),
    }


def _best_rhyme_partner(pron, target: str, partners: List[tuple]) -> Optional[str]:
    """partners = [(distance, word)]; best = perfect before slant, then nearest."""
    from phonology.core import rhyme_grade
    tp = pron.phones(target)
    if not tp:
        return None
    ranked = []
    for dist, word in partners:
        if word.lower() == target.lower():
            continue
        pp = pron.phones(word)
        if not pp:
            continue
        grade = rhyme_grade(tp, pp)
        if grade == "none":
            continue
        ranked.append((0 if grade == "perfect" else 1, dist, word))
    if not ranked:
        return None
    ranked.sort()
    return ranked[0][2]


def _ctx(lines: List[str], li: int, n_before: int, n_after: int) -> tuple:
    return lines[max(0, li - n_before):li], lines[li + 1:li + 1 + n_after]


def _base_item(song: dict, si: int, li: int, granularity: str) -> dict:
    sec = song["sections"][si]
    return {
        "itemId": f"{POLICY_VERSION}:{granularity}:{song['songId']}:s{si}:l{li}",
        "granularity": granularity,
        "songId": song["songId"], "artist": song.get("artist", ""),
        "si": si, "li": li, "sectionKind": sec["kind"],
        "licenseTier": song.get("licenseTier", "eval-only"),
        "views": song.get("views", 0),
        "maskPolicy": f"{granularity}-{POLICY_VERSION}",
        "seed": item_seed(song["songId"], si, li, granularity),
    }


def items_for_song(song: dict, pron, freq: Dict[str, int],
                   granularities=("word", "rhyme", "span", "line")) -> List[dict]:
    items: List[dict] = []
    for si, sec in enumerate(song.get("sections", [])):
        if sec["kind"] not in _MASKABLE_KINDS:
            continue
        lines = sec["lines"]
        for li, line in enumerate(lines):
            tokens = tokenize(line)
            if "word" in granularities:
                it = _word_item(song, si, li, line, tokens, lines, pron, freq)
                if it:
                    items.append(it)
            if "rhyme" in granularities:
                it = _rhyme_item(song, si, li, line, tokens, lines, pron)
                if it:
                    items.append(it)
            if "span" in granularities:
                it = _span_item(song, si, li, line, tokens, lines, pron)
                if it:
                    items.append(it)
            if "line" in granularities:
                it = _line_item(song, si, li, line, tokens, lines, pron)
                if it:
                    items.append(it)
    return items


def _word_item(song, si, li, line, tokens, lines, pron, freq) -> Optional[dict]:
    eligible = _eligible_word_indices(tokens)
    if not eligible:
        return None
    # Lowest-df tercile of the eligible tokens = the content-word pool.
    by_df = sorted(eligible, key=lambda i: (freq.get(tokens[i].lower(), 0), tokens[i].lower(), i))
    pool = by_df[:max(1, (len(by_df) + 2) // 3)]
    rng = random.Random(item_seed(song["songId"], si, li, "word"))
    idx = pool[rng.randrange(len(pool))]
    target = tokens[idx]
    before, after = _ctx(lines, li, 2, 1)
    item = _base_item(song, si, li, "word")
    info = _phones_info(pron, target)
    item["context"] = {"before": before, "maskedLine": _blank_out(line, [idx]),
                       "after": after}
    item["target"] = {"text": target, "tokenIndex": idx, "tokenSpan": None, **info}
    item["constraints"] = {"syllables": info["syllables"], "syllableTol": 0,
                           "rhymeWith": None, "rhymeStrictness": "slant",
                           "lineSyllableTarget": None}
    return item


def _rhyme_item(song, si, li, line, tokens, lines, pron) -> Optional[dict]:
    if not tokens:
        return None
    idx = len(tokens) - 1
    target = tokens[idx]
    partners = []
    for lj in range(max(0, li - 3), min(len(lines), li + 4)):
        if lj == li:
            continue
        other = tokenize(lines[lj])
        if other:
            partners.append((abs(lj - li), other[-1]))
    partner = _best_rhyme_partner(pron, target, partners)
    if not partner:
        return None
    before, after = _ctx(lines, li, 2, 1)
    item = _base_item(song, si, li, "rhyme")
    info = _phones_info(pron, target)
    item["context"] = {"before": before, "maskedLine": _blank_out(line, [idx]),
                       "after": after}
    item["target"] = {"text": target, "tokenIndex": idx, "tokenSpan": None, **info}
    item["constraints"] = {"syllables": info["syllables"], "syllableTol": 0,
                           "rhymeWith": partner, "rhymeStrictness": "slant",
                           "lineSyllableTarget": None}
    return item


def _span_item(song, si, li, line, tokens, lines, pron) -> Optional[dict]:
    n = len(tokens)
    if n < 4:
        return None
    eligible = set(_eligible_word_indices(tokens))
    if not eligible:
        return None
    # Enumerate every valid window (2-4 tokens, never touching the final token,
    # containing >=1 eligible token), then one seeded pick.
    windows = [(s, s + ln) for ln in (2, 3, 4) for s in range(0, n - ln)
               if set(range(s, s + ln)) & eligible]
    if not windows:
        return None
    rng = random.Random(item_seed(song["songId"], si, li, "span"))
    start, end = windows[rng.randrange(len(windows))]
    span_tokens = tokens[start:end]
    syl = sum(pron.syllables(t) for t in span_tokens)
    all_phoned = all(pron.phones(t) for t in span_tokens)
    before, after = _ctx(lines, li, 2, 1)
    item = _base_item(song, si, li, "span")
    item["context"] = {"before": before,
                       "maskedLine": _blank_out(line, list(range(start, end))),
                       "after": after}
    item["target"] = {"text": " ".join(span_tokens), "tokenIndex": None,
                      "tokenSpan": [start, end], "phones": None,
                      "phonesSource": "lexicon" if all_phoned else "none",
                      "syllables": syl, "stress": ""}
    item["constraints"] = {"syllables": syl, "syllableTol": 1, "rhymeWith": None,
                           "rhymeStrictness": "slant", "lineSyllableTarget": None}
    return item


def _line_item(song, si, li, line, tokens, lines, pron) -> Optional[dict]:
    before, after = _ctx(lines, li, 3, 2)
    if len(before) < 2 or len(after) < 1 or not tokens:
        return None
    syl_target = sum(pron.syllables(t) for t in tokens)
    partners = []
    for ctx_line in before + after:
        ct = tokenize(ctx_line)
        if ct:
            partners.append((1, ct[-1]))
    partner = _best_rhyme_partner(pron, tokens[-1], partners)
    item = _base_item(song, si, li, "line")
    item["context"] = {"before": before, "maskedLine": None, "after": after}
    item["target"] = {"text": line, "tokenIndex": None, "tokenSpan": None,
                      "phones": None, "syllables": syl_target, "stress": ""}
    item["constraints"] = {"syllables": None, "syllableTol": 1,
                           "rhymeWith": partner, "rhymeStrictness": "slant",
                           "lineSyllableTarget": syl_target}
    return item
