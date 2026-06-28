#!/usr/bin/env python3
"""Audio "mumble take" → lyric constraint spec (Finish-My-Song Phase 3).

The producer records themselves humming/mumbling a melody with placeholder words. We turn
that AUDIO into a lyric sheet they don't have to hand-type:

  - **Rhythm (reliable):** Basic Pitch note onsets — each sung syllable ≈ one note. Binned
    into bars (from the project tempo) → syllables-per-bar; note dynamics → a stress contour.
  - **Words (best-effort):** Whisper words with confidence; only HIGH-confidence words are
    placed as locked anchors, everything else becomes a `___` gap the L2/L3 loop fills.

This module is the deterministic IP: PURE functions over note/word lists (stdlib only), so
it golden-tests 3× identical with no audio and no model. When Whisper isn't installed,
/transcribe_words returns EMPTY words (everything becomes a gap) — never invented words
(misrecognized lyrics in the sheet would be worse than gaps), so the rhythm path still works.
"""
from __future__ import annotations

import re
from typing import List, Optional

MAX_BARS = 32                       # cap a long take (deterministic truncation)
_GRID_PER_BAR = {"1/4": 4, "1/8": 8, "1/16": 16}


def _grid_per_bar(grid: str) -> int:
    return _GRID_PER_BAR.get(grid, 16)


def _sec_per_bar(bpm: float, time_sig) -> float:
    """Bar length in seconds. bpm = quarter-notes/min; a bar of num/den = num beats, each a
    den-th note ⇒ num * (60/bpm) * (4/den)."""
    num, den = (time_sig[0], time_sig[1]) if time_sig else (4, 4)
    bpm = bpm if bpm and bpm > 0 else 120.0
    den = den if den else 4
    return float(num) * (60.0 / bpm) * (4.0 / float(den))


def _clean_word(w: str) -> str:
    return re.sub(r"[^a-z']", "", (w or "").lower())


def _stress(notes: List[dict]) -> str:
    """Per-note contour over the bar's (truncated) notes, in start order: 'X' (stressed) if
    the note is louder OR longer than the bar mean, else 'x'. A lone note is 'X' (an accent).
    Strict '>' against the MEAN so equal-valued notes don't all read as stressed."""
    if len(notes) == 1:
        return "X"
    vels = [float(n.get("velocity", 0)) for n in notes]
    # Round durations to the millisecond so float noise (0.9-0.5 != 0.4-0.0) can't flip the
    # contour — equal-length notes must compare equal so velocity is the deciding signal.
    durs = [round(float(n.get("end", 0)) - float(n.get("start", 0)), 3) for n in notes]
    mv = sum(vels) / len(vels)
    md = sum(durs) / len(durs)
    return "".join("X" if (v > mv or d > md) else "x" for v, d in zip(vels, durs))


def _bin_bars(notes: List[dict], spb: float):
    """Group notes into bars by start time → ordered list of (bar_index, [notes sorted by
    start]) for non-empty bars only, truncated to MAX_BARS bars."""
    bars: dict = {}
    for n in notes:
        b = int(float(n.get("start", 0.0)) // spb)
        bars.setdefault(b, []).append(n)
    out = []
    for b in sorted(bars):
        out.append((b, sorted(bars[b], key=lambda n: float(n.get("start", 0.0)))))
        if len(out) >= MAX_BARS:
            break
    return out


def build_spec_from_take(notes: List[dict], words: List[dict], bpm: float,
                         time_sig=(4, 4), conf_threshold: float = 0.6,
                         grid: str = "1/16", topic: str = "", mood: str = "") -> dict:
    """Notes + confidence-gated words → a lyric constraint spec (the shape lyrics.core
    consumes). One line per non-empty bar; syllables-per-bar = notes-per-bar clamped to
    [1, grid_per_bar]; stress from dynamics; confident words placed at their nearest note
    slot, the rest `___` gaps; ABAB rhyme groups. No notes ⇒ no_melody_detected."""
    if not notes:
        return {"ok": False, "error": "no_melody_detected", "lines": []}

    spb = _sec_per_bar(bpm, time_sig)
    per_bar = _grid_per_bar(grid)
    confident = sorted((w for w in (words or []) if float(w.get("confidence", 0)) >= conf_threshold),
                       key=lambda w: float(w.get("start", 0.0)))

    lines = []
    for dense, (bar, bar_notes) in enumerate(_bin_bars(notes, spb)):
        slots = bar_notes[:per_bar]                       # clamp dense bars to the grid
        n = len(slots)
        # Place confident words landing in THIS bar at their nearest unclaimed slot.
        bar_lo, bar_hi = bar * spb, (bar + 1) * spb
        placed = {}                                       # slot index → cleaned word
        for w in confident:
            ws = float(w.get("start", 0.0))
            if not (bar_lo <= ws < bar_hi):
                continue
            cw = _clean_word(w.get("word", ""))
            if not cw:
                continue
            free = [i for i in range(n) if i not in placed]
            if not free:
                break
            nearest = min(free, key=lambda i: abs(ws - float(slots[i].get("start", 0.0))))
            placed[nearest] = cw
        seed = " ".join(placed.get(i, "___") for i in range(n))
        lines.append({
            "index": dense, "role": "verse", "seedText": seed,
            "syllableTarget": n, "syllableTol": 1,
            "stress": _stress(slots),
            "rhymeGroup": "A" if dense % 2 == 0 else "B",
        })

    return {"ok": True, "grid": grid, "topic": topic, "mood": mood,
            "rhymeStrictness": "slant", "lines": lines}
