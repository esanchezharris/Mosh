#!/usr/bin/env python3
"""Style-RAG corpus + retrieval (Finish-My-Song §7) — the "sounds like me" flywheel.

The producer's OWN lyric lines accumulate in an opt-in corpus (JSONL on disk, keyed by
MOSH_LYRIC_CORPUS_DIR). At generation time the loop RETRIEVES the most relevant exemplars
and injects them into the prompt as a voice reference, with a near-verbatim NOVELTY guard so
the model is steered by *style*, not by parroting a line.

Corpus management is backend-only (a safety wall): the corpus is user-owned content,
managed by the service, never dumped wholesale through the agent surface — `stats()` returns
counts, not text. Retrieval + the guard are pure, deterministic, stdlib-only — a lexical
relevance scorer. A real embedding backend is a parked upgrade behind the `retrieve` seam
(the same real→fake posture as stable_audio3 → fake).
"""
from __future__ import annotations

import json
import os
import re
from typing import Dict, List, Optional

_WORD_RE = re.compile(r"[A-Za-z']+")
# Very common words carry no "voice" signal — exclude from relevance + n-gram matching.
_STOP = {"the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "at", "for", "with",
         "i", "me", "my", "you", "your", "it", "is", "so", "as", "that", "this", "be", "am"}


def _tokens(text: str) -> List[str]:
    return [w.lower() for w in _WORD_RE.findall(text or "")]


def _content_tokens(text: str) -> List[str]:
    return [w for w in _tokens(text) if w not in _STOP]


def _ngrams(tokens: List[str], n: int) -> set:
    return {tuple(tokens[i:i + n]) for i in range(len(tokens) - n + 1)} if len(tokens) >= n else set()


# ── retrieval (deterministic lexical relevance) ───────────────────────────────────

def retrieve(corpus: List[dict], query: str, k: int = 3) -> List[str]:
    """The top-k corpus lines most relevant to `query`, ranked by content-word overlap.

    Deterministic: ties break by MORE overlap, then alphabetical. Lines with zero
    content-word overlap are dropped (an irrelevant exemplar is worse than none)."""
    q = set(_content_tokens(query))
    if not q:
        return []
    scored = []
    for entry in corpus:
        text = entry.get("text", "") if isinstance(entry, dict) else str(entry)
        overlap = len(q & set(_content_tokens(text)))
        if overlap > 0:
            scored.append((-overlap, text))
    scored.sort()
    out, seen = [], set()
    for _, text in scored:
        if text not in seen:
            seen.add(text)
            out.append(text)
        if len(out) >= k:
            break
    return out


# ── near-verbatim novelty guard (anti-parrot) ─────────────────────────────────────

def near_verbatim(candidate: str, corpus: List[dict], threshold: float = 0.6) -> Optional[str]:
    """The corpus line `candidate` near-duplicates (so it should NOT be surfaced — the
    bias is style, not copying), else None. Word-trigram Jaccard, with a content-token
    Jaccard fallback for short lines. Deterministic."""
    cand_tok = _tokens(candidate)
    cand_3 = _ngrams(cand_tok, 3)
    cand_set = set(_content_tokens(candidate))
    if not cand_set:
        return None
    for entry in corpus:
        text = entry.get("text", "") if isinstance(entry, dict) else str(entry)
        line_3 = _ngrams(_tokens(text), 3)
        if cand_3 and line_3:
            inter = len(cand_3 & line_3)
            union = len(cand_3 | line_3)
            if union and inter / union >= threshold:
                return text
        # Short-line fallback: high content-token overlap = effectively the same line.
        line_set = set(_content_tokens(text))
        if line_set:
            inter = len(cand_set & line_set)
            union = len(cand_set | line_set)
            if union and inter / union >= max(threshold, 0.8):
                return text
    return None


# ── persisted, opt-in corpus (JSONL) ──────────────────────────────────────────────

def default_corpus_path() -> str:
    """The corpus file under MOSH_LYRIC_CORPUS_DIR (default ~/Library/Mosh/lyrics)."""
    base = os.environ.get("MOSH_LYRIC_CORPUS_DIR") or os.path.join(
        os.path.expanduser("~"), "Library", "Mosh", "lyrics")
    return os.path.join(base, "style_corpus.jsonl")


class StyleCorpus:
    """An opt-in, user-owned JSONL corpus of lyric lines. Exact-duplicate lines are
    ignored on add. Read/write is line-oriented JSON (stdlib only)."""

    def __init__(self, path: Optional[str] = None):
        self.path = path or default_corpus_path()

    def _read(self) -> List[dict]:
        out: List[dict] = []
        if os.path.isfile(self.path):
            try:
                with open(self.path, encoding="utf-8") as f:
                    for raw in f:
                        raw = raw.strip()
                        if raw:
                            out.append(json.loads(raw))
            except (OSError, json.JSONDecodeError):
                pass
        return out

    def lines(self) -> List[dict]:
        return self._read()

    def add_lines(self, texts: List[str], meta: Optional[Dict[str, str]] = None) -> int:
        """Append non-empty, non-duplicate lines. Returns how many were newly added."""
        existing = {e.get("text", "") for e in self._read()}
        fresh = []
        for t in texts:
            t = (t or "").strip()
            if t and t not in existing:
                existing.add(t)
                fresh.append({"text": t, **(meta or {})})
        if fresh:
            os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as f:
                for e in fresh:
                    f.write(json.dumps(e, ensure_ascii=False) + "\n")
        return len(fresh)

    def stats(self) -> dict:
        """Counts only — never the content (the backend-only safety wall)."""
        rows = self._read()
        return {"ok": True, "lines": len(rows),
                "sources": sorted({str(e.get("source", "")) for e in rows if e.get("source")})}

    def clear(self) -> None:
        try:
            if os.path.isfile(self.path):
                os.remove(self.path)
        except OSError:
            pass


def load_corpus(extra: Optional[List[str]] = None, path: Optional[str] = None) -> List[dict]:
    """The retrieval pool: the persisted corpus PLUS any inline lines the request carried
    (e.g. the track's own accepted lyrics passed in the spec). Deterministic order."""
    rows = StyleCorpus(path).lines()
    for t in (extra or []):
        t = (t or "").strip()
        if t:
            rows.append({"text": t, "source": "inline"})
    return rows
