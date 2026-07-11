"""flowfit — the flexible 'rapper-moves' allocator that fits words onto a mumbled groove.

The rigid allocator (soulx.score._word_units) treats the take as a fixed template: it holds
the last word over any leftover notes (a tone sustained through the singer's silence) and
never rests. A rapper, subconsciously, does the opposite — when there are more notes than
syllables they hit the strong beats and let the weak positions breathe as RESTS.

`flow_units` implements that: it scores each slot by ACCENT (velocity + duration) and METRIC
position (downbeat > 8th > weak 16th), keeps the strongest slots for the syllables, and
leaves the weakest UNALLOCATED — the score author renders an unallocated slot as a rest
(silence), never a hold. Multi-syllable words take contiguous kept slots. When the take is
slot-starved (more words than notes) it falls back to the rigid squeeze (nothing to rest).

Returns the SAME `[(word|[words], [slots]), …]` shape author_score consumes, so it drops into
the one policy seam. Pure + deterministic.
"""
from __future__ import annotations

import re
from typing import List, Optional, Sequence, Tuple

from phonology import core as ph

_pronouncer: Optional[ph.Pronouncer] = None


def _pron() -> ph.Pronouncer:
    global _pronouncer
    if _pronouncer is None:
        _pronouncer = ph.Pronouncer()
    return _pronouncer


def _syllables(word: str) -> int:
    return max(1, _pron().syllables(re.sub(r"[^a-z']", "", word.lower())) or 1)


def _slot_strengths(slots: Sequence[dict], bpm: float, time_sig: Sequence[int]) -> List[float]:
    """Per-slot 'keep priority': accent (velocity + duration, the take's own emphasis —
    phase-independent, mirrors mumble._stress) plus a lighter metric-position bonus (downbeat
    > 8th > weak). Accent dominates so the ranking survives an unknown bar phase."""
    vels = [float(s.get("velocity", 0.0)) for s in slots]
    durs = [float(s.get("end", 0.0)) - float(s.get("start", 0.0)) for s in slots]
    vmax = max(vels) or 1.0
    dmax = max(durs) or 1.0
    s16 = (60.0 / bpm) / 4.0 if bpm and bpm > 0 else 0.125
    num, den = (int(time_sig[0]), int(time_sig[1])) if len(time_sig) >= 2 else (4, 4)
    spb = max(1, round(num * (4.0 / den) * 4))          # sixteenths per bar (4/4 -> 16)
    out: List[float] = []
    for i, s in enumerate(slots):
        pos = (round(float(s.get("start", 0.0)) / s16) % spb) if s16 > 0 else 0
        metric = 0.5 if pos % 4 == 0 else (0.25 if pos % 2 == 0 else 0.0)
        out.append(2.0 * (vels[i] / vmax) + (durs[i] / dmax) + metric)
    return out


def _contiguous(words: List[str], syls: List[int], slots: List[dict]) -> List[Tuple]:
    """Allocate each word its syllable-count of consecutive slots, in order (the rigid case-B
    packing). Only reached when total syllables >= len(slots), so there are no leftovers to
    hold — an exact or compressed fill."""
    units: List[Tuple] = []
    pos, n = 0, len(slots)
    for i, w in enumerate(words):
        after = sum(syls[i + 1:])
        k = max(1, min(syls[i], n - pos - after))
        units.append((w, slots[pos:pos + k]))
        pos += k
    if pos < n:                                          # defensive: never happens for a kept set
        w, taken = units[-1]
        units[-1] = (w, taken + slots[pos:])
    return units


# Key → pitch-class set. Major and its relative minor share a set (D major == B minor),
# which is exactly the Used2 lesson: the melody centered on B (relative-minor tonic) over a
# D-major beat, and snapping to B MAJOR manufactured sour notes (owner ear, demos d4/d5).
_MAJOR = [0, 2, 4, 5, 7, 9, 11]
_PC = {"c": 0, "c#": 1, "db": 1, "d": 2, "d#": 3, "eb": 3, "e": 4, "f": 5, "f#": 6,
       "gb": 6, "g": 7, "g#": 8, "ab": 8, "a": 9, "a#": 10, "bb": 10, "b": 11}


def _key_pcs(key: str) -> set:
    m = re.match(r"^\s*([a-g][#b]?)\s+(major|minor)\s*$", str(key or "").lower())
    if not m or m.group(1) not in _PC:
        raise ValueError(f"unknown key: {key!r} (expected e.g. 'D major' / 'B minor')")
    root = _PC[m.group(1)]
    if m.group(2) == "minor":
        root = (root + 3) % 12          # relative major shares the pitch set
    return {(root + i) % 12 for i in _MAJOR}


def snap_slots_to_key(slots: List[dict], key: str = "D major") -> List[dict]:
    """Pitch hygiene (owner-certified, demo d5): snap every segment pitch to the SONG KEY's
    scale (nearest tone, ties prefer lower) and clamp octave outliers toward the line median.
    Basic Pitch leaves noise in the skeleton's measured pitches — ornament mis-tracks and
    octave errors — and the singer faithfully sings the wrong note it's given. Pure; the
    input is not mutated."""
    pcs = _key_pcs(key)

    def snap(p: int) -> int:
        for k in sorted(range(-6, 7), key=lambda k: (abs(k), k)):
            if (p + k) % 12 in pcs:
                return p + k
        return p

    all_p = sorted(snap(int(g.get("pitch", 69))) for s in slots for g in s.get("segments") or [])
    med = all_p[len(all_p) // 2] if all_p else 69
    out: List[dict] = []
    for s in slots:
        segs = []
        for g in s.get("segments") or []:
            p = snap(int(g.get("pitch", 69)))
            while p - med > 7:
                p -= 12
            while med - p > 7:
                p += 12
            segs.append({**g, "pitch": p})
        out.append({**s, "segments": segs} if s.get("segments") is not None else dict(s))
    return out


def condition_slots(slots: List[dict], bpm: float = 138.0, max_beats: float = 1.5) -> List[dict]:
    """Cap each slot's sung length to `max_beats` beats. The skeleton sometimes captures a long
    span as ONE slot (e.g. 1.9s); sung whole it holds a tone through what is really the singer's
    silence (the 'sine over no mumble' the owner heard). Trimming a slot's end (and its segments
    to match) frees the tail — author_score then renders that freed time as a REST, since the gap
    to the next slot grows. Short/consecutive real notes are untouched. Pure + deterministic."""
    beat = (60.0 / bpm) if bpm and bpm > 0 else 0.5
    cap = max(0.05, max_beats * beat)
    out: List[dict] = []
    for s in slots:
        st, en = float(s.get("start", 0.0)), float(s.get("end", 0.0))
        if en - st <= cap:
            out.append(s)
            continue
        new_en = st + cap
        ns = {**s, "end": round(new_en, 4)}
        if s.get("segments") is not None:
            segs = [{**g, "end": round(min(float(g.get("end", new_en)), new_en), 4)}
                    for g in s["segments"] if float(g.get("start", st)) < new_en]
            pitch = int((s["segments"] or [{}])[0].get("pitch", 69)) if s["segments"] else 69
            ns["segments"] = segs or [{"start": round(st, 4), "end": round(new_en, 4), "pitch": pitch}]
        out.append(ns)
    return out


def flow_units(words: List[str], slots: List[dict], bpm: float = 138.0,
               time_sig: Sequence[int] = (4, 4)) -> List[Tuple]:
    """Fit `words` onto `slots` like a rapper: keep the strongest notes for syllables, rest
    the weak leftovers (unallocated slots -> the author renders them as silence). Falls back
    to the rigid squeeze only when there are more words than notes."""
    n = len(slots)
    if not words or n == 0:
        return []
    if len(words) > n:                                   # slot-starved: nothing to rest, squeeze
        return [(words[i], [slots[i]]) for i in range(n - 1)] + [(words[n - 1:], [slots[n - 1]])]
    syls = [_syllables(w) for w in words]
    total = sum(syls)
    if total >= n:                                       # exact/compressed fill, no rests
        return _contiguous(words, syls, slots)
    # fewer syllables than notes: keep the `total` strongest slots (in time order), rest the rest
    strengths = _slot_strengths(slots, bpm, time_sig)
    keep = sorted(sorted(range(n), key=lambda i: (strengths[i], -i), reverse=True)[:total])
    return _contiguous(words, syls, [slots[i] for i in keep])
