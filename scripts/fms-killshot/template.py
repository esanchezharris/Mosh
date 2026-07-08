#!/usr/bin/env python3
"""Per-syllable rhythm/stress TEMPLATE (FMS reset, Stage 0 — STRUCTURED / grid-quantized).

A song is highly structured, so the template must be too. Two structural commitments (owner's
insight after the onset-based v1 came in under the ≥80% bar with missing/extra syllables):

  1. The syllable COUNT comes from the WORDS, never from noisy onset detection — his real words
     → `phonology.syllables`, his `***` mumble marks → one syllable each. Exact: no missing, no
     extra. (This is the "use STT to count syllables" idea — with his typed words as ground truth.)
  2. Every syllable ONSET snaps to the musical GRID (16th notes at the known BPM), monotonic, with
     a one-grid-step minimum duration — so nothing lands off-grid or crammed into an impossible slot
     ("I won't sneak a polysyllabic word in under half a second").

A template is a time-ordered list of syllables:
    {i, onset, dur, pitch, stress: "strong"|"weak", beat: "strong"|"weak", origin: "real"|"gap",
     word, k}   (k = grid-step index)

Rough anchor times (to know WHICH grid slots are hit) come from the forced-aligned real words
(spread each word's syllables across its span) and from interpolation across the mumble gaps; the
grid PHASE is calibrated to minimise snap error on the real-word anchors. Pure + deterministic;
golden-tested in template_test.py. Reuses phonology.core + skeleton.align (pure F0→pitch only).
"""
from __future__ import annotations

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


# ── musical grid (known BPM; acapella → grid is the tempo, not an instrumental) ────────────

def beat_dur(bpm: float) -> float:
    return 60.0 / max(1e-6, bpm)


def grid_step(bpm: float, subdiv: int = 4) -> float:
    """Seconds per grid slot (subdiv=4 → 16th notes: a beat split into 4)."""
    return beat_dur(bpm) / max(1, subdiv)


def calibrate_phase(anchors: List[float], step: float, res: int = 24) -> float:
    """Grid phase offset in [0, step) that minimises total snap distance of the anchor onsets —
    aligns the grid to how he actually sang, deterministically."""
    if not anchors:
        return 0.0
    best = (float("inf"), 0.0)
    for c in range(res):
        phase = c / res * step
        err = sum(abs(a - (phase + round((a - phase) / step) * step)) for a in anchors)
        if err < best[0]:
            best = (err, phase)
    return best[1]


def on_strong_beat(t: float, bpm: float, sig=(4, 4), strong=(0, 2), tol: float = 0.12) -> bool:
    bd = beat_dur(bpm)
    idx = round(t / bd)
    return abs(t - idx * bd) <= tol and (idx % max(1, sig[0])) in set(strong)


def beat_positions(bpm: float, t_end: float, sig=(4, 4), strong=(0, 2)) -> List[dict]:
    bd = beat_dur(bpm)
    out, k = [], 0
    while k * bd <= t_end + 1e-6:
        out.append({"t": round(k * bd, 4), "strong": (k % max(1, sig[0])) in set(strong)})
        k += 1
    return out


def _energy(env, hop_s: float, a: float, b: float) -> float:
    if not env:
        return 0.0
    i0 = max(0, int(a / hop_s))
    i1 = min(len(env), max(i0 + 1, int(b / hop_s)))
    seg = env[i0:i1]
    return sum(seg) / len(seg) if seg else 0.0


# ── exact syllable anchors (count from the WORDS, rough time from alignment) ────────────────

def syllable_anchors(units: List[dict], aligned: List[dict]) -> List[dict]:
    """The exact ordered syllable sequence with a ROUGH anchor time each. Count is ground truth:
    a real word contributes `phonology.syllables` anchors spread across its aligned span; a gap of
    n contributes n anchors spread across the silence to the next real word."""
    out: List[dict] = []
    ptr = 0
    prev_end = 0.0
    for ui, u in enumerate(units):
        if "word" in u:
            a = aligned[ptr] if ptr < len(aligned) else None
            ptr += 1
            if a is None:
                continue
            s, e = float(a["start"]), float(a["end"])
            n = _syllables(u["word"])
            for k in range(n):
                out.append({"anchor": s + (e - s) * k / n, "origin": "real", "word": u["word"]})
            prev_end = e
        else:
            n = int(u.get("gap", 1))
            nxt = None
            for v in units[ui + 1:]:
                if "word" in v and ptr < len(aligned):
                    nxt = float(aligned[ptr]["start"])
                    break
            hi = nxt if nxt is not None else prev_end + n * 0.25
            hi = max(hi, prev_end + 0.05)
            for k in range(n):
                out.append({"anchor": prev_end + (hi - prev_end) * (k + 0.5) / n,
                            "origin": "gap", "word": None})
            prev_end = hi
    out.sort(key=lambda x: x["anchor"])
    return out


def build_template(units: List[dict], aligned: List[dict], f0=None, env=None,
                   bpm: float = 120.0, subdiv: int = 4, hop_s: float = 0.01, sig=(4, 4)) -> List[dict]:
    """Structured per-syllable template: exact word-derived count, grid-snapped onsets.

    `units` = the take's word/gap sequence ({"word": str} | {"gap": n}); `aligned` = forced-aligned
    real words [{word,start,end,...}] for rough timing. Onsets snap to the `subdiv`-per-beat grid,
    monotonic (min one grid step apart), durations run to the next syllable. Deterministic."""
    anchors = syllable_anchors(units, aligned)
    if not anchors:
        return []
    step = grid_step(bpm, subdiv)
    phase = calibrate_phase([a["anchor"] for a in anchors if a["origin"] == "real"], step)

    # snap each anchor to a grid index, strictly increasing (min one step apart)
    ks: List[int] = []
    last = -1
    for a in anchors:
        k = round((a["anchor"] - phase) / step)
        if k <= last:
            k = last + 1
        ks.append(k)
        last = k

    beats_per_bar = max(1, sig[0]) * subdiv        # grid slots per bar
    out: List[dict] = []
    for i, (a, k) in enumerate(zip(anchors, ks)):
        onset = phase + k * step
        nxt_onset = phase + ks[i + 1] * step if i + 1 < len(ks) else onset + step
        dur = max(step, nxt_onset - onset)
        pitch = int(align._pitch_from_f0(f0, onset, onset + dur)) if f0 else 69
        pos = k % beats_per_bar                     # grid position within the bar
        on_beat = (k % subdiv) == 0                 # lands on a quarter-note beat
        strong_beat = pos in (0, 2 * subdiv)        # downbeat or beat 3
        out.append({
            "i": i, "k": k, "onset": round(onset, 4), "dur": round(dur, 4), "pitch": pitch,
            "origin": a["origin"], "word": a["word"],
            "stress": "strong" if on_beat else "weak",
            "beat": "strong" if strong_beat else "weak",
        })
    return out


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
