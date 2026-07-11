"""FIT report — the NUMERIC workability readout for a written line over a mumble's grid.

`soulx.score.author_score` places words onto the take's real notes and `adapters.
soulx_adapter._render_fake` makes that audible. This module measures the SAME placement so
"does the verse fit the mumble?" is a number, not an argument — and the number agrees with
the beeps because both read the same slots.

Per line, against its N note-slots:
  * squeezed = max(0, words − N)      — more WORDS than notes ⇒ words share the last note
                                        (the audibly rushed/mushed case; author_score's
                                        "squeeze tail").
  * crammed  = max(0, syllables − N)  — more SYLLABLES than notes ⇒ slurred/dropped.
  * held     = max(0, N − syllables)  — more NOTES than syllables ⇒ the last word is held
                                        across the spare notes (benign melisma).
  * fit = clamp(1 − (crammed + HELD_W·held) / N)   (crammed already covers squeezed's cost;
                                                     held is lightly weighted — it usually
                                                     sounds intentional.)

A line author_score would SKIP (no slots, or no asserted words / a `___` gap) is skipped
here too, so the overall workability reflects only what actually renders.
"""
from __future__ import annotations

import re
from typing import List, Optional

from phonology import core as ph

HELD_W = 0.15   # a spare note held on the last word is benign; a fraction of a full miss

_pronouncer: Optional[ph.Pronouncer] = None


def _pron() -> ph.Pronouncer:
    global _pronouncer
    if _pronouncer is None:
        _pronouncer = ph.Pronouncer()
    return _pronouncer


def _clean(word: str) -> str:
    return re.sub(r"[^a-z']", "", word.lower())


def _asserted_text(line: dict) -> str:
    """Mirror soulx.score._asserted_text: the words author_score would actually sing."""
    text = str(line.get("text", "") or "").strip()
    if not line.get("asserted") or not text or "___" in text:
        return ""
    if not any(ch.isalnum() for ch in text):
        return ""
    return text


def _syllables(word: str) -> int:
    return max(1, _pron().syllables(_clean(word)) or 1)


def fit_line(line: dict, index: int = 0) -> dict:
    """The fit of ONE written line over its own note-slots. `scored=False` when the line has
    no notes or no asserted words (author_score would skip it)."""
    slots = (line.get("score") or {}).get("slots") or []
    n = len(slots)
    text = _asserted_text(line)
    if n == 0 or not text:
        return {"index": index, "text": str(line.get("text", "")), "scored": False,
                "slots": n, "words": 0, "syllables": 0,
                "squeezed": 0, "crammed": 0, "held": 0, "fit": 0.0, "verdict": "skipped"}
    words = text.split()
    w = len(words)
    s = sum(_syllables(x) for x in words)
    squeezed = max(0, w - n)
    crammed = max(0, s - n)
    held = max(0, n - s)
    fit = max(0.0, 1.0 - (crammed + HELD_W * held) / n)
    if squeezed > 0:
        verdict = "squeezed"
    elif crammed > 0:
        verdict = "crammed"
    elif held > 0:
        verdict = "held"
    else:
        verdict = "clean"
    return {"index": index, "text": text, "scored": True, "slots": n, "words": w, "syllables": s,
            "squeezed": squeezed, "crammed": crammed, "held": held,
            "fit": round(fit, 4), "verdict": verdict}


def compute_fit(lines: List[dict]) -> dict:
    """Per-line fit + an overall workability score (the slot-weighted mean over the lines
    that actually render). Deterministic; pure."""
    reports = [fit_line(ln, i) for i, ln in enumerate(lines or [])]
    scored = [r for r in reports if r["scored"]]
    tot_slots = sum(r["slots"] for r in scored)
    workability = (sum(r["fit"] * r["slots"] for r in scored) / tot_slots) if tot_slots else 0.0
    return {
        "ok": True,
        "lines": reports,
        "workability": workability,     # exact (weighted mean of the per-line fits); round for display
        "linesScored": len(scored),
        "linesSkipped": len(reports) - len(scored),
        "clean": sum(1 for r in scored if r["verdict"] == "clean"),
        "squeezed": sum(1 for r in scored if r["verdict"] == "squeezed"),
        "crammed": sum(1 for r in scored if r["verdict"] == "crammed"),
        "held": sum(1 for r in scored if r["verdict"] == "held"),
    }
