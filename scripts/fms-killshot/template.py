#!/usr/bin/env python3
"""Per-syllable rhythm/stress TEMPLATE (FMS reset, Stage 0 — the de-risk).

The research's load-bearing lesson: everything downstream (constrained generation, singing)
rides on an ACCURATE per-syllable template extracted from the take. This module builds that
template for a "real-words-with-gaps" mumble take and NOTHING else — no generation, no render.
It is validated in isolation by a click track (template_spike.py) the owner judges by ear.

A template is a time-ordered list of syllables:
    {i, onset, dur, pitch, stress: "strong"|"weak", beat: "strong"|"weak", origin: "real"|"gap", word}

- REAL-word syllables come from FORCED ALIGNMENT (skeleton.align: his marked-real words timed to
  the audio) split into `phonology.syllables(word)` slots, pitched from F0 (align.slots_for_word).
- GAP syllables come from the note onsets (Basic Pitch nuclei) that fall inside the silence between
  the bracketing real words — so a mumbled run is placed where he actually vocalised, not guessed.
- STRESS is a strong/weak accent per syllable (longer OR louder than the take's median — the
  research's "longer/accented notes take stressed syllables"), and BEAT marks whether the syllable
  lands on a strong beat of the known-BPM grid (the rhythmic reference the loose prior render lacked).

Pure + deterministic (given its inputs): the impure I/O — forced alignment, F0, note detection,
energy — lives in the owner-gated driver. Golden-tested in template_test.py. Reuses
skeleton.align.slots_for_word and phonology.core.
"""
from __future__ import annotations

import statistics
from typing import List, Optional

from phonology import core as ph
from skeleton import align

_pron: Optional[ph.Pronouncer] = None


def _pr() -> ph.Pronouncer:
    global _pron
    if _pron is None:
        _pron = ph.Pronouncer()
    return _pron


def _syllables(word: str) -> int:
    c = "".join(ch for ch in word.lower() if ch.isalpha() or ch == "'")
    return max(1, _pr().syllables(c) or 1) if c else 1


# ── beat grid (known BPM; his takes are acapellas so the grid is the tempo, not an instrumental) ──

def beat_dur(bpm: float) -> float:
    return 60.0 / max(1e-6, bpm)


def on_strong_beat(t: float, bpm: float, sig=(4, 4), strong=(0, 2), tol: float = 0.12) -> bool:
    """Does onset `t` land on a strong beat (default beats 1 & 3 of a 4/4 bar) within `tol` s?"""
    bd = beat_dur(bpm)
    idx = round(t / bd)
    if abs(t - idx * bd) > tol:
        return False
    return (idx % max(1, sig[0])) in set(strong)


def beat_positions(bpm: float, t_end: float, sig=(4, 4), strong=(0, 2)) -> List[dict]:
    """Every beat position up to t_end, flagged strong/weak — for the metronome/grid overlay."""
    bd = beat_dur(bpm)
    out, k = [], 0
    while k * bd <= t_end + 1e-6:
        out.append({"t": round(k * bd, 4), "strong": (k % max(1, sig[0])) in set(strong)})
        k += 1
    return out


# ── energy per syllable window (for the stress accent) ───────────────────────────────────

def _energy(env, hop_s: float, a: float, b: float) -> float:
    if not env:
        return 0.0
    i0 = max(0, int(a / hop_s))
    i1 = min(len(env), max(i0 + 1, int(b / hop_s)))
    seg = env[i0:i1]
    return sum(seg) / len(seg) if seg else 0.0


# ── syllable builders ────────────────────────────────────────────────────────────────────

def _real_syllables(word: str, start: float, end: float, f0) -> List[dict]:
    """A real word's audio span → one entry per syllable (F0-pitched), origin=real."""
    slots = align.slots_for_word(start, end, _syllables(word), f0=f0)
    out = []
    for s in slots:
        pitch = int((s.get("segments") or [{"pitch": 69}])[0].get("pitch", 69))
        out.append({"onset": round(float(s["start"]), 4), "dur": round(float(s["end"]) - float(s["start"]), 4),
                    "pitch": pitch, "origin": "real", "word": word})
    return out


def _gap_syllables(lo: float, hi: float, notes, f0, n_expected: int) -> List[dict]:
    """A mumbled gap [lo, hi) → syllables at the note ONSETS that fall inside it (where he
    actually vocalised). No notes in the gap → fall back to `n_expected` even-spaced slots so a
    mumble the detector missed still gets a placeholder grid."""
    onsets = sorted(float(n["start"]) for n in (notes or [])
                    if lo - 1e-6 <= float(n["start"]) < hi - 1e-6)
    if not onsets and n_expected > 0 and hi > lo:
        step = (hi - lo) / n_expected
        onsets = [lo + k * step for k in range(n_expected)]
    out = []
    for k, on in enumerate(onsets):
        nxt = onsets[k + 1] if k + 1 < len(onsets) else hi
        pitch = align._pitch_from_f0(f0, on, max(on + 0.05, nxt)) if f0 else 69
        out.append({"onset": round(on, 4), "dur": round(max(0.06, nxt - on), 4),
                    "pitch": int(pitch), "origin": "gap", "word": None})
    return out


def build_template(units: List[dict], aligned: List[dict], notes, f0, env,
                   hop_s: float = 0.01, bpm: float = 120.0, sig=(4, 4)) -> List[dict]:
    """`units` = the take's word/gap sequence in order: {"word": str} (real, matched to `aligned`
    in order) or {"gap": n} (n mumbled syllables). `aligned` = forced-aligned real words
    [{word,start,end,...}]. Returns the time-ordered per-syllable template with stress + beat."""
    syls: List[dict] = []
    ptr = 0
    prev_end = 0.0
    for ui, u in enumerate(units):
        if "word" in u:
            a = aligned[ptr] if ptr < len(aligned) else None
            ptr += 1
            if a is None:
                continue
            for e in _real_syllables(u["word"], float(a["start"]), float(a["end"]), f0):
                syls.append(e)
                prev_end = float(a["end"])
        else:  # gap of n mumbled syllables between the bracketing real words
            n = int(u.get("gap", 1))
            nxt_start = None
            for v in units[ui + 1:]:
                if "word" in v and ptr < len(aligned):
                    nxt_start = float(aligned[ptr]["start"])
                    break
            hi = nxt_start if nxt_start is not None else prev_end + n * 0.3
            syls.extend(_gap_syllables(prev_end, max(hi, prev_end + 0.06), notes, f0, n))
            prev_end = max(prev_end, hi)

    syls.sort(key=lambda s: s["onset"])
    if not syls:
        return []
    # stress: strong if longer OR louder than the take's median (the research's accent rule)
    durs = [s["dur"] for s in syls]
    engs = [_energy(env, hop_s, s["onset"], s["onset"] + s["dur"]) for s in syls]
    md, me = statistics.median(durs), (statistics.median(engs) if any(engs) else 0.0)
    for i, s in enumerate(syls):
        s["i"] = i
        s["stress"] = "strong" if (s["dur"] > md or engs[i] > me) else "weak"
        s["beat"] = "strong" if on_strong_beat(s["onset"], bpm, sig) else "weak"
    return syls


# ── convenience: parse his "real words + * mumble" lyric into `units` ───────────────────────

def units_from_lyric(lines: List[str]) -> List[dict]:
    """His lyric lines (real words; "*" = one mumbled syllable) → the flat units sequence."""
    units: List[dict] = []
    for ln in lines:
        for tok in ln.split():
            if set(tok) <= {"*"}:
                if units and "gap" in units[-1]:
                    units[-1]["gap"] += 1
                else:
                    units.append({"gap": 1})
            else:
                units.append({"word": tok})
    return units
