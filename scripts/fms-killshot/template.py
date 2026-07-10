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


def anchors_from_words(words: List[dict], conf_floor: float = 0.5) -> List[dict]:
    """Whisper (or any) timed words → the exact syllable sequence with rough anchor times.
    Count comes from the WORDS (phonology), timing from each word's [start,end], and each
    syllable's origin is `real` when the word was heard confidently, `gap` when it wasn't
    (Whisper's own confidence separates his clear lyrics from the mumbles)."""
    out: List[dict] = []
    for w in words or []:
        word = str(w.get("word", "")).strip()
        s, e = float(w.get("start", 0.0)), float(w.get("end", 0.0))
        if e <= s:
            e = s + 0.1
        n = _syllables(word)
        origin = "real" if float(w.get("confidence", 0.0) or 0.0) >= conf_floor else "gap"
        for k in range(n):
            out.append({"anchor": s + (e - s) * k / n, "origin": origin, "word": word})
    out.sort(key=lambda x: x["anchor"])
    return out


def snap_anchors_to_grid(anchors: List[dict], bpm: float, subdiv: int = 4, f0=None,
                         sig=(4, 4), phase: Optional[float] = None) -> List[dict]:
    """Snap ordered syllable anchors to the `subdiv`-per-beat grid — monotonic (min one step
    apart), durations to the next syllable, pitch from F0, stress on-beat, beat on strong-beat."""
    if not anchors:
        return []
    step = grid_step(bpm, subdiv)
    if phase is None:
        cal = [a["anchor"] for a in anchors if a.get("origin") == "real"] or [a["anchor"] for a in anchors]
        phase = calibrate_phase(cal, step)
    ks: List[int] = []
    last = -1
    for a in anchors:
        k = round((a["anchor"] - phase) / step)
        if k <= last:
            k = last + 1
        ks.append(k)
        last = k
    beats_per_bar = max(1, sig[0]) * subdiv
    out: List[dict] = []
    for i, (a, k) in enumerate(zip(anchors, ks)):
        onset = phase + k * step
        nxt = phase + ks[i + 1] * step if i + 1 < len(ks) else onset + step
        dur = max(step, nxt - onset)
        pitch = int(align._pitch_from_f0(f0, onset, onset + dur)) if f0 else 69
        pos = k % beats_per_bar
        out.append({"i": i, "k": k, "onset": round(onset, 4), "dur": round(dur, 4), "pitch": pitch,
                    "origin": a["origin"], "word": a["word"],
                    "stress": "strong" if (k % subdiv) == 0 else "weak",
                    "beat": "strong" if pos in (0, 2 * subdiv) else "weak"})
    return out


def build_template(units: List[dict], aligned: List[dict], f0=None, env=None,
                   bpm: float = 120.0, subdiv: int = 4, hop_s: float = 0.01, sig=(4, 4)) -> List[dict]:
    """Structured per-syllable template from his lyric `units` ({"word"} | {"gap": n}) + the
    forced-aligned real words `aligned` (rough timing). Exact word-derived count, grid-snapped."""
    return snap_anchors_to_grid(syllable_anchors(units, aligned), bpm, subdiv, f0, sig)


# ── the VALIDATED recipe: words-first onsets, transient-refined, gaps gridded ──────────────
# (Stage-0 validation on known truth: count from WORDS, timing from forced-align refined to the
#  nearest acoustic transient — ~15ms precise; grid only structures the wordless mumble gaps.)

def refine_to_transients(onsets: List[float], transients: List[float], window: float = 0.06) -> List[float]:
    """Snap each onset to its nearest detected transient within ±window (the ~15ms precision the
    validation showed is available); an onset with no transient in range is left as-is. Pure."""
    ts = sorted(transients or [])
    if not ts:
        return list(onsets)
    out = []
    for o in onsets:
        near = [t for t in ts if abs(t - o) <= window]
        out.append(round(min(near, key=lambda t: abs(t - o)), 4) if near else o)
    return out


def build_template_wordsfirst(units: List[dict], aligned: List[dict], transients=None, f0=None,
                              bpm: float = 120.0, subdiv: int = 4, sig=(4, 4),
                              refine_window: float = 0.06) -> List[dict]:
    """The validated template: real-word syllables keep their forced-aligned onset REFINED to the
    nearest transient (exact, not grid-snapped — his feel); wordless mumble syllables are grid-
    placed between the bracketing words. Count is word-derived. Stress/beat are labelled against the
    tempo grid. `transients` = acoustic onsets (librosa); omit to keep the raw forced-align times."""
    step = grid_step(bpm, subdiv)
    anchors: List[dict] = []
    ptr = 0
    prev_end = 0.0
    for ui, u in enumerate(units):
        if "word" in u:
            a = aligned[ptr] if ptr < len(aligned) else None
            ptr += 1
            if a is None:
                continue
            s, e = float(a["start"]), float(a["end"])
            for sl in align.slots_for_word(s, e, _syllables(u["word"])):
                anchors.append({"onset": float(sl["start"]), "origin": "real", "word": u["word"]})
            prev_end = e
        else:
            n = int(u.get("gap", 1))
            nxt = None
            for v in units[ui + 1:]:
                if "word" in v and ptr < len(aligned):
                    nxt = float(aligned[ptr]["start"])
                    break
            hi = max(nxt if nxt is not None else prev_end + n * 0.25, prev_end + 0.05)
            for k in range(n):
                anchors.append({"onset": prev_end + (hi - prev_end) * (k + 0.5) / n, "origin": "gap", "word": None})
            prev_end = hi
    # refine only the REAL onsets to the acoustic transients
    if transients:
        refined = iter(refine_to_transients([a["onset"] for a in anchors if a["origin"] == "real"],
                                            transients, refine_window))
        for a in anchors:
            if a["origin"] == "real":
                a["onset"] = next(refined)
    anchors.sort(key=lambda x: x["onset"])
    for i in range(1, len(anchors)):                          # keep strictly increasing
        if anchors[i]["onset"] <= anchors[i - 1]["onset"]:
            anchors[i]["onset"] = anchors[i - 1]["onset"] + 0.01
    phase = calibrate_phase([a["onset"] for a in anchors if a["origin"] == "real"]
                            or [a["onset"] for a in anchors], step)
    beats_per_bar = max(1, sig[0]) * subdiv
    out: List[dict] = []
    for i, a in enumerate(anchors):
        onset = a["onset"]
        nxt = anchors[i + 1]["onset"] if i + 1 < len(anchors) else onset + step
        dur = max(0.06, nxt - onset)
        pitch = int(align._pitch_from_f0(f0, onset, onset + dur)) if f0 else 69
        k = round((onset - phase) / step)
        out.append({"i": i, "onset": round(onset, 4), "dur": round(dur, 4), "pitch": pitch,
                    "origin": a["origin"], "word": a["word"],
                    "stress": "strong" if k % subdiv == 0 else "weak",
                    "beat": "strong" if (k % beats_per_bar) in (0, 2 * subdiv) else "weak"})
    return out


def build_template_from_words(words: List[dict], bpm: float = 120.0, subdiv: int = 4,
                              f0=None, env=None, conf_floor: float = 0.5, sig=(4, 4)):
    """The ASR-driven template (owner's ask): Whisper timed words → grid-snapped syllables.
    Returns (template, grid_phase) so the caller can phase a metronome to his vocal."""
    anchors = anchors_from_words(words, conf_floor)
    step = grid_step(bpm, subdiv)
    cal = [a["anchor"] for a in anchors if a["origin"] == "real"] or [a["anchor"] for a in anchors]
    phase = calibrate_phase(cal, step)
    return snap_anchors_to_grid(anchors, bpm, subdiv, f0, sig, phase), phase


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
