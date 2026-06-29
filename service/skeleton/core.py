#!/usr/bin/env python3
"""Phase-2 mumble -> rhythmic SKELETON core (Finish-My-Song roadmap §2).

Turns a hummed/mumbled take (Basic-Pitch note onsets, optionally + an F0 contour) into the
SAME `LineSpec` the Phase-1 lyric engine consumes — a wordless skeleton (every slot a `___`
gap) carrying the syllable count + stress contour per bar. NO words, NO synthesis.

Design: do NOT duplicate the binning. `lyrics.mumble.build_spec_from_take(nuclei, [])` already
bins onsets into bars, derives syllables-per-bar + a stress contour, and emits the exact spec
shape — so this module owns only the NEW signal step (note -> syllable *nuclei*) and funnels the
result through mumble. One `LineSpec` emitter, no contract drift.

- **No F0 (offline / fake / no FCPE venv):** identity — one note = one nucleus. The output is
  then byte-identical to today's `build_spec_from_take(notes, [])` (the safety equivalence).
- **With an F0 contour:** a sustained note that *re-articulates* (a pitch jump of >= a few
  semitones mid-note) splits into N nuclei — catching "laaa-aa-aa" = 1 note but 3 syllables, the
  case raw onsets miss. Deterministic: split AT the jump sample's time, no RNG.

Pure stdlib (the service interpreter has no numpy); the real FCPE F0 extraction lives in the
isolated `skeleton_cli.py` venv and feeds this its `f0` list.
"""
from __future__ import annotations

import math
from typing import List, Optional

from lyrics import mumble

# A within-note pitch re-articulation of at least this many semitones reads as a new syllable
# nucleus (a fresh vowel onset), not pitch drift within one sustained syllable.
_SPLIT_SEMITONES = 1.5


def _semitone(hz: float) -> Optional[float]:
    """Absolute semitones from A440 (relative is all we use). None for unvoiced/invalid."""
    return 12.0 * math.log2(hz / 440.0) if hz and hz > 0 else None


def nuclei_from_notes(notes: List[dict], f0: Optional[List[dict]] = None) -> List[dict]:
    """Refine Basic-Pitch notes into syllable nuclei (each a {start, end, velocity} dict).

    With no F0: identity (one note = one nucleus) — preserves the exact note dicts so the
    downstream binning is unchanged. With an F0 contour ([{t, hz}, ...] in SECONDS / Hz): split
    a note wherever the voiced pitch jumps by >= _SPLIT_SEMITONES between consecutive samples."""
    if not f0:
        return [dict(n) for n in notes]   # identity — the offline/fake path

    samples = sorted(
        ({"t": float(s.get("t", s.get("time", 0.0))),
          "st": _semitone(float(s.get("hz", s.get("f0", 0.0)) or 0.0))} for s in f0),
        key=lambda s: s["t"])

    out: List[dict] = []
    for n in notes:
        ns, ne = float(n.get("start", 0.0)), float(n.get("end", 0.0))
        vel = float(n.get("velocity", 0))
        inside = [s for s in samples if ns <= s["t"] < ne and s["st"] is not None]
        cuts = [b["t"] for a, b in zip(inside, inside[1:])
                if abs(b["st"] - a["st"]) >= _SPLIT_SEMITONES]
        bounds = [ns] + cuts + [ne]
        for i in range(len(bounds) - 1):
            if bounds[i + 1] > bounds[i]:
                out.append({"start": bounds[i], "end": bounds[i + 1], "velocity": vel})
    return out


def build_skeleton_spec(notes: List[dict], f0: Optional[List[dict]] = None, bpm: float = 120.0,
                        time_sig=(4, 4), grid: str = "1/16", topic: str = "", mood: str = "") -> dict:
    """Notes (+ optional F0) -> a wordless, editable `LineSpec` the Phase-1 engine consumes.

    Reuses `lyrics.mumble.build_spec_from_take` for the bar binning / stress / spec shape (words
    forced EMPTY -> all `___` gaps), then stamps the skeleton provenance. The native land marks
    each line `proposed` (the human-in-the-loop grid the producer confirms before generation)."""
    nuclei = nuclei_from_notes(notes, f0)
    spec = mumble.build_spec_from_take(nuclei, [], bpm, time_sig=time_sig, grid=grid,
                                       topic=topic, mood=mood)
    if spec.get("ok"):
        spec["source"] = "skeleton"
        spec["editable"] = True
    return spec
