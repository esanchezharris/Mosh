"""Deterministic, stdlib-only prompt-concision rewriter (05 §6).

A verbose generative prompt ("please can you make me a really very dark, gritty,
dark techno loop, thanks!") carries a lot of conversational filler that adds no
conditioning signal to the model — and, because the prompt is part of the cache
fingerprint (05 §5), trivial wording noise (extra "please", repeated words,
loose whitespace) needlessly fragments the cache. This module folds such a prompt
down to its load-bearing descriptors while preserving meaning and first-seen
casing.

Design constraints (AL-004):
  • Pure Python, stdlib only — no numpy, no MLX, no network, no adapters/colors/sa3.
  • Fully deterministic: same input -> byte-identical output. No randomness, no
    time, no locale-sensitive ops, no dict-ordering reliance.
  • Standalone: it NEVER touches the MoshOps command surface. It's a helper a
    caller may opt into; nothing here mutates engine state or emits events.
  • Never lengthens a prompt; idempotent (rewrite(rewrite(x)) == rewrite(x)).

The transform is intentionally conservative — it removes filler/politeness,
collapses redundant intensifiers, de-duplicates comma- and space-separated
descriptors case-insensitively (keeping the first occurrence verbatim), and
normalizes whitespace/punctuation. It does NOT paraphrase, translate, or invent
new words, so it can never change the musical intent.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# ── Filler / politeness phrases stripped wholesale (longest first so multi-word
#    phrases win over their sub-phrases). Matched case-insensitively on word
#    boundaries. Order within a length tier is irrelevant to the output. ────────
_FILLER_PHRASES = (
    "can you please make me",
    "can you please make",
    "can you make me",
    "can you make",
    "could you make me",
    "could you make",
    "i would like",
    "i'd like",
    "i want it to be",
    "i want it to",
    "i want",
    "i need",
    "please can you",
    "thanks so much",
    "thank you so much",
    "thank you",
    "thanks",
    "please",
    "kind of",
    "sort of",
    "a bit of a",
    "like a",
    "you know",
)

# Redundant intensifier stacks -> at most one intensifier. "really very" / "very
# really" / "so very" all collapse. We drop the leading intensifier, keeping the
# one closest to the adjective it modifies.
_INTENSIFIERS = ("really", "very", "so", "super", "quite", "extremely")


def _strip_phrases(text: str) -> str:
    out = text
    for phrase in _FILLER_PHRASES:
        # \b around the phrase; allow internal flexible whitespace.
        pat = r"\b" + r"\s+".join(re.escape(w) for w in phrase.split()) + r"\b"
        out = re.sub(pat, " ", out, flags=re.IGNORECASE)
    return out


def _collapse_intensifiers(text: str) -> str:
    alts = "|".join(re.escape(w) for w in _INTENSIFIERS)
    # Two or more adjacent intensifiers -> keep only the last one in the run.
    pat = re.compile(r"\b(?:(?:" + alts + r")\s+){1,}(" + alts + r")\b", re.IGNORECASE)
    return pat.sub(r"\1", text)


def _normalize_punct_ws(text: str) -> str:
    # Trim trailing exclamation/period runs and stray quoting noise, collapse
    # repeated commas, then collapse whitespace.
    out = text.replace("!", " ").replace(";", ",")
    out = re.sub(r"\s*,\s*(?:,\s*)+", ", ", out)   # ", ,"  / ",,," -> ", "
    out = re.sub(r"\s+", " ", out).strip()
    out = re.sub(r"\s*,\s*", ", ", out)            # canonical ", " around commas
    out = out.strip().strip(",").strip()           # drop leading/trailing commas
    return out


def _dedupe_descriptors(text: str) -> str:
    """De-duplicate comma-separated segments AND repeated words inside a segment,
    case-insensitively, keeping the first occurrence verbatim. Order preserved."""
    segments = [s.strip() for s in text.split(",")]
    kept_segments: list[str] = []
    seen_segments: set[str] = set()
    for seg in segments:
        if not seg:
            continue
        # Drop intra-segment repeated words ("deep ... deep techno" within a seg).
        words = seg.split(" ")
        kept_words: list[str] = []
        seen_words: set[str] = set()
        for w in words:
            key = w.lower()
            stripped = re.sub(r"[^\w]", "", key)
            if stripped and stripped in seen_words:
                continue
            if stripped:
                seen_words.add(stripped)
            kept_words.append(w)
        seg = " ".join(kept_words).strip()
        if not seg:
            continue
        seg_key = seg.lower()
        if seg_key in seen_segments:
            continue
        seen_segments.add(seg_key)
        kept_segments.append(seg)
    return ", ".join(kept_segments)


@dataclass(frozen=True)
class ConciseResult:
    """Outcome of a concision pass. Immutable + JSON-friendly via as_dict()."""
    original: str
    rewritten: str
    chars_before: int
    chars_after: int
    words_before: int
    words_after: int
    reduction: float          # fraction of characters removed, in [0, 1]

    def as_dict(self) -> dict:
        return {
            "original": self.original,
            "rewritten": self.rewritten,
            "chars_before": self.chars_before,
            "chars_after": self.chars_after,
            "words_before": self.words_before,
            "words_after": self.words_after,
            "reduction": self.reduction,
        }


def _word_count(text: str) -> int:
    return len(text.split())


def rewrite(prompt: str) -> ConciseResult:
    """Concise-rewrite a generative prompt deterministically.

    Returns a ConciseResult. Never lengthens the prompt: if the transform would
    somehow produce more characters than it consumed (it shouldn't), the original
    is returned unchanged. Raises TypeError on non-string input.
    """
    if not isinstance(prompt, str):
        raise TypeError("prompt must be a str")

    original = prompt
    chars_before = len(original)
    words_before = _word_count(original)

    text = original
    text = _strip_phrases(text)
    text = _collapse_intensifiers(text)
    text = _normalize_punct_ws(text)
    text = _dedupe_descriptors(text)
    rewritten = text.strip()

    # Safety net: never emit something longer than the input.
    if len(rewritten) > chars_before:
        rewritten = original.strip()

    chars_after = len(rewritten)
    words_after = _word_count(rewritten)
    reduction = 0.0 if chars_before == 0 else (chars_before - chars_after) / chars_before
    if reduction < 0.0:
        reduction = 0.0

    return ConciseResult(
        original=original,
        rewritten=rewritten,
        chars_before=chars_before,
        chars_after=chars_after,
        words_before=words_before,
        words_after=words_after,
        reduction=round(reduction, 6),
    )


__all__ = ["rewrite", "ConciseResult"]
