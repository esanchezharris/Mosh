#!/usr/bin/env python3
"""Energy-first syllable detector (Phase C consolidation, 2026-07-13).

Promotes the benchtest-proven SIMPLE detector into product code. The grid benchtest
(scripts/fms-killshot/backhalf_gridbench.py) measured a plain energy detector — gate
attacks + relative-dip re-articulations — against the owner's 147-mark truth and found it
matches/beats the elaborate Basic-Pitch v3/v4 ladder on per-phrase syllable COUNTS (the old
prune collapsed 140 BP notes -> 90 slots, worse than raw). So EXISTENCE comes from the
energy envelope (+ F0 for dip disambiguation), not from Basic-Pitch note edges.

Ported verbatim from the ear-validated scripts/fms-killshot/segment_v2.py: gate_events /
dip_events / pitch_step_events (do not tune blind — the constants are the ones the owner's
ear confirmed on real takes). `energy_nuclei` assembles them into syllable slots and
re-derives per-slot melisma segments from F0 (the truth_slots-v2 pattern — SoulX
continuation glides survive), matching the shape `skeleton.core._line_scores` /
`lyrics.mumble` already consume.

Pure stdlib, deterministic. The envelope is computed by the caller (see
skeleton.core.energy_envelope) so this module stays list-based.
"""
from __future__ import annotations

import math
from typing import List, Optional, Tuple

HOP_MS = 10.0            # aligns with FCPE's contour hop + skeleton.core.energy_envelope
GATE_FLOOR_MULT = 4.0    # theta_hi = max(4 x p5, 0.15 x p95)
GATE_P95_FRAC = 0.15
GATE_CLOSE_FRAC = 0.5    # theta_lo = 0.5 x theta_hi (hysteresis)
STEP_ST = 1.0            # sustained pitch step >= 1 semitone
STEP_SUSTAIN = 3         # frames the new level must hold (~30 ms) — kills vibrato/scoops
STEP_MEDIAN_K = 5        # median filter width for the semitone track
MIN_SPAN_S = 0.04        # gate spans / slivers shorter than this are noise blips
DIP_DEPTH = 0.55         # a valley must fall below 55% of the neighbouring peak (~-5 dB)
DIP_MIN_SEP_S = 0.08     # dips closer than this to the last boundary are the same event


def _pctl(sorted_vals: list, p: float) -> float:
    if not sorted_vals:
        return 0.0
    i = min(len(sorted_vals) - 1, max(0, int(round(p / 100.0 * (len(sorted_vals) - 1)))))
    return sorted_vals[i]


def _median(vals: list) -> float:
    s = sorted(vals)
    n = len(s)
    return s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2])


def gate_events(env: List[float], hop_s: float,
                floor_mult: float = GATE_FLOOR_MULT, p95_frac: float = GATE_P95_FRAC,
                close_frac: float = GATE_CLOSE_FRAC, min_span_s: float = MIN_SPAN_S):
    """Adaptive hysteresis gate -> (attack_times, open_spans).

    theta_hi = max(floor_mult x p5(env), p95_frac x p95(env)); theta_lo = close_frac x theta_hi.
    An attack fires on every closed->open crossing; spans shorter than min_span_s drop."""
    if not env:
        return [], []
    sv = sorted(env)
    th_hi = max(floor_mult * _pctl(sv, 5), p95_frac * _pctl(sv, 95))
    th_lo = close_frac * th_hi
    attacks, spans = [], []
    open_t: Optional[float] = None
    for i, e in enumerate(env):
        t = i * hop_s
        if open_t is None and e >= th_hi:
            open_t = t
        elif open_t is not None and e < th_lo:
            if t - open_t >= min_span_s:
                attacks.append(open_t)
                spans.append((open_t, t))
            open_t = None
    if open_t is not None:
        end = len(env) * hop_s
        if end - open_t >= min_span_s:
            attacks.append(open_t)
            spans.append((open_t, end))
    return attacks, spans


def dip_events(env: List[float], hop_s: float, spans: List[Tuple[float, float]],
               depth: float = DIP_DEPTH, min_sep_s: float = DIP_MIN_SEP_S) -> List[float]:
    """Relative energy dips inside gate-open spans -> re-articulation times.

    Walk each span tracking the running peak; when the envelope falls below depth x peak and
    then recovers above ~valley/depth, the valley is a syllable boundary (the consonant
    trough between connected vowels — la-la on one pitch never crosses the absolute gate)."""
    out = []
    for span_a, span_b in spans:
        lo, hi = int(span_a / hop_s), int(span_b / hop_s)
        seg = env[lo:hi]
        if len(seg) < 3:
            continue
        peak = seg[0]
        valley, valley_i = None, -1
        last = span_a - min_sep_s
        for i in range(1, len(seg)):
            e = seg[i]
            if valley is None:
                if e > peak:
                    peak = e
                elif e < depth * peak:
                    valley, valley_i = e, i
            else:
                if e < valley:
                    valley, valley_i = e, i
                elif valley > 0 and e > valley / depth:   # recovered ~ symmetric rise
                    t = span_a + valley_i * hop_s
                    if t - last >= min_sep_s:
                        out.append(round(t, 4))
                        last = t
                    peak, valley = e, None
    return out


def pitch_step_events(f0: Optional[List[dict]], step_st: float = STEP_ST,
                      sustain: int = STEP_SUSTAIN, median_k: int = STEP_MEDIAN_K,
                      max_gap_s: float = 0.03) -> List[float]:
    """Sustained pitch steps on the voiced contour -> event times (melisma boundaries).

    f0 = [{t, hz}] voiced frames only. Median-filter the semitone track, then fire where the
    filtered level jumps >= step_st between temporally-adjacent frames AND the next `sustain`
    frames hold within step_st/2 of the new level (kills vibrato/scoops)."""
    if not f0 or len(f0) < median_k + sustain:
        return []
    pts = sorted(({"t": float(p["t"]), "st": 12.0 * math.log2(float(p["hz"]) / 440.0)}
                  for p in f0 if float(p.get("hz", 0)) > 0), key=lambda p: p["t"])
    if len(pts) < median_k + sustain:
        return []
    half = median_k // 2
    med = [_median([pts[j]["st"] for j in range(max(0, i - half), min(len(pts), i + half + 1))])
           for i in range(len(pts))]
    events = []
    for i in range(1, len(pts) - sustain):
        if pts[i]["t"] - pts[i - 1]["t"] > max_gap_s:
            continue  # a voicing gap — the gate owns that boundary
        step = med[i] - med[i - 1]
        if abs(step) < step_st:
            continue
        if all(abs(med[i + k] - med[i]) <= step_st / 2 for k in range(1, sustain + 1)):
            events.append(pts[i]["t"])
    out = []                                                  # collapse bursts to one event
    for t in events:
        if not out or t - out[-1] > sustain * 0.01 * 2:
            out.append(t)
    return out


def _pitch_of(f0_in: List[dict], a: float, b: float, take_med: Optional[int]) -> int:
    """Median-F0 MIDI pitch over [a, b); fall back to the take median, else A4 (69)."""
    hz = [float(p["hz"]) for p in f0_in if a <= float(p["t"]) < b and float(p.get("hz", 0)) > 0]
    if hz:
        return int(round(69 + 12 * math.log2(_median(hz) / 440.0)))
    return take_med if take_med is not None else 69


def _melisma_segments(f0_in: List[dict], a: float, b: float, take_med: Optional[int]) -> List[dict]:
    """Split [a, b] at sustained F0 steps (the truth_slots-v2 pattern) -> pitch segments.
    ONE syllable slot regardless; the segments are the internal SoulX continuation glides."""
    steps = [t for t in pitch_step_events(f0_in) if a < t < b]
    bounds = [a] + steps + [b]
    return [{"start": round(bounds[i], 4), "end": round(bounds[i + 1], 4),
             "pitch": _pitch_of(f0_in, bounds[i], bounds[i + 1], take_med)}
            for i in range(len(bounds) - 1)]


def energy_nuclei(env: List[float], hop_s: float, f0: Optional[List[dict]]) -> List[dict]:
    """Energy envelope (+ optional F0) -> syllable slots (the benchtest E detector).

    EXISTENCE = gate attacks + relative dips: each gate-open span, partitioned at its dips,
    is one syllable slot. Each slot's melisma `segments` are re-derived from F0 (pitch steps
    inside the slot); velocity rides the envelope peak (1..127, Basic-Pitch-compatible so
    `lyrics.mumble._stress` works unchanged). Empty envelope -> [] (caller degrades to v1).
    Shape matches `skeleton.core._line_scores` / `lyrics.mumble` groups exactly."""
    if not env:
        return []
    attacks, spans = gate_events(env, hop_s)
    dips = dip_events(env, hop_s, spans)
    p95 = _pctl(sorted(env), 95) or 1.0
    take_med = None
    if f0:
        hz = [float(p["hz"]) for p in f0 if float(p.get("hz", 0)) > 0]
        if hz:
            take_med = int(round(69 + 12 * math.log2(_median(hz) / 440.0)))

    def _vel(a: float, b: float) -> int:
        lo, hi = int(a / hop_s), max(int(a / hop_s) + 1, int(b / hop_s))
        peak = max(env[lo:hi]) if env[lo:hi] else 0.0
        return max(1, min(127, int(round(126 * peak / p95)) + 1))

    nuclei: List[dict] = []
    for span_a, span_b in spans:
        inner = sorted(d for d in dips if span_a < d < span_b)
        bounds = [span_a] + inner + [span_b]
        f0_span = [p for p in (f0 or []) if span_a <= float(p["t"]) < span_b and float(p.get("hz", 0)) > 0]
        for i in range(len(bounds) - 1):
            a, b = bounds[i], bounds[i + 1]
            if b - a < MIN_SPAN_S:                             # sliver at a boundary — drop
                continue
            nuclei.append({"start": round(a, 4), "end": round(b, 4), "velocity": _vel(a, b),
                           "segments": _melisma_segments(f0_span, a, b, take_med)})
    return nuclei
