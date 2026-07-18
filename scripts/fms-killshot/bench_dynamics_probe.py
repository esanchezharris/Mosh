#!/usr/bin/env python3
"""DIAGNOSTIC PROBE — how much of the performance gap is DYNAMICS?

The own-pairs run showed the pipeline lands at energy-envelope correlation 0.266 against the
finished take, below the 0.400 floor the untouched mumble scores, against a human-to-human
band of 0.40–0.44. The suspected cause: **nothing in the pipeline conditions loudness on the
take.** The SoulX score has no dynamics channel, `perform.transfer_envelope` was deleted
(3fbb61d2) on the rationale "NSF supplies dynamics", NSF is default-off — and NSF's `perform`
mode transfers F0 anyway, resynthesizing from the render's own mel, so it never carried the
take's loudness at all.

This module sizes that gap before anything is built. It lives in the LAB on purpose:

  `frame` — the deleted implementation recovered verbatim from fac16264. The owner REJECTED
     this by ear ("I can hear the volume automation rather than the words ending naturally"),
     so it is a measuring stick, never a shipping candidate. It paints a frame-rate gain curve
     over the render — including INSIDE notes, which is the likely reason it read as automation.

  `note` — the Phase-2 hypothesis, testable for free here: impose the take's loudness PER NOTE
     and leave the model's own attack/decay shape intact within each note. If `frame` and
     `note` reach a similar correlation, the intra-note painting was pure cost and the cheap
     fix is real.

Both are read against a TWO-SIDED band: ~0.42 is the target, and >0.9 means the envelope was
painted on rather than transferred — overshoot is failure, not success. That guard is the
reason a metric cannot be optimized here into the V3 trap.
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))

from skeleton.core import energy_envelope           # noqa: E402
from soulx.perform import GATE_FRAC, HOP_S, _gate_threshold, _pctl   # noqa: E402

MAX_BOOST = 4.0       # never lift a render frame by more than this factor
SMOOTH_HOPS = 3       # centered moving average over the gain curve (~30 ms)


def _voicing_threshold(env):
    """Above this the signal is actually SINGING (the overlap-QA convention — stricter than
    the rest gate, so breath under a note reads as non-voicing and is never boosted)."""
    if not env:
        return float("inf")
    sv = sorted(env)
    return max(1e-6, 4.0 * _pctl(sv, 5), 0.15 * _pctl(sv, 95))


def _apply_gain_curve(render, gains, sr, hop_s):
    """Linear-interpolate a per-hop gain curve across samples."""
    hop = max(1, int(sr * hop_s))
    out = []
    for j, v in enumerate(render):
        f = j / hop
        i = int(f)
        if i >= len(gains) - 1:
            g = gains[-1]
        else:
            g = gains[i] + (gains[i + 1] - gains[i]) * (f - i)
        out.append(v * g)
    return out


def transfer_envelope_frame(take, render, sr, *, hop_s=HOP_S, smooth_hops=SMOOTH_HOPS,
                            max_boost=MAX_BOOST, strength=1.0, gate_frac=GATE_FRAC):
    """RECOVERED VERBATIM from fac16264 (the ear-rejected version). Gain-matches the render
    to the take's energy envelope at frame rate. strength<=0 returns the render untouched."""
    if strength <= 0.0:
        return list(render)
    env_t = energy_envelope(take, sr, hop_ms=hop_s * 1000.0)
    env_r = energy_envelope(render, sr, hop_ms=hop_s * 1000.0)
    if not env_t or not env_r:
        return list(render)

    th = _gate_threshold(env_t, gate_frac)
    th_r = _voicing_threshold(env_r)
    gains = []
    for i in range(len(env_r)):
        et = env_t[i] if i < len(env_t) else 0.0
        if et < th:
            raw = 0.0                     # the take rests here — force silence
        else:
            # boost only where the render is actually VOICING; breath/hiss under a take
            # note is left at unity, never amplified into fake energy
            cap = max_boost if env_r[i] >= th_r else 1.0
            raw = min(et / max(env_r[i], 1e-9), cap)
        gains.append((1.0 - strength) + strength * raw)

    if smooth_hops > 1:
        half = smooth_hops // 2
        gains = [sum(gains[max(0, i - half):i + half + 1])
                 / (min(len(gains), i + half + 1) - max(0, i - half))
                 for i in range(len(gains))]
    return _apply_gain_curve(render, gains, sr, hop_s)


def note_spans(clip, total_s):
    """[(start_s, end_s)] for each SOUNDED note in an authored SoulX clip (note_type 2/3;
    type 1 is a rest). Durations are the authored per-note seconds, laid end to end."""
    if not clip:
        return []
    try:
        durs = [float(x) for x in str(clip.get("duration", "")).split()]
        types = [int(x) for x in str(clip.get("note_type", "")).split()]
    except ValueError:
        return []
    spans, t = [], 0.0
    for d, ty in zip(durs, types):
        if ty != 1 and d > 0:
            spans.append((t, min(t + d, total_s)))
        t += d
    return [(a, b) for a, b in spans if b > a and a < total_s]


def transfer_envelope_note(take, render, sr, clip, *, hop_s=HOP_S, max_boost=MAX_BOOST,
                           strength=1.0, gate_frac=GATE_FRAC):
    """PHASE-2 HYPOTHESIS: impose the take's loudness PER NOTE — one gain per note, so the
    model's own attack/decay shape survives inside the note. The frame version repaints the
    shape within every note, which is the likely source of the "volume automation" percept.

    Gains are held flat across each note and ramped between notes at hop resolution, so the
    curve moves at note rate (~200-500 ms) rather than 10 ms. strength<=0 is a byte-identical
    no-op, matching duration.py's contract."""
    if strength <= 0.0:
        return list(render)
    spans = note_spans(clip, len(render) / float(sr))
    if not spans:
        return list(render)
    env_t = energy_envelope(take, sr, hop_ms=hop_s * 1000.0)
    env_r = energy_envelope(render, sr, hop_ms=hop_s * 1000.0)
    if not env_t or not env_r:
        return list(render)

    th = _gate_threshold(env_t, gate_frac)
    th_r = _voicing_threshold(env_r)
    n = len(env_r)
    gains = [1.0] * n

    def _mean(env, a, b):
        seg = [env[i] for i in range(max(0, a), min(len(env), b))]
        return sum(seg) / len(seg) if seg else 0.0

    for s, e in spans:
        i0, i1 = int(s / hop_s), max(int(e / hop_s), int(s / hop_s) + 1)
        et, er = _mean(env_t, i0, i1), _mean(env_r, i0, i1)
        if et < th:
            raw = 0.0                                  # the take rests across this note
        else:
            cap = max_boost if er >= th_r else 1.0
            raw = min(et / max(er, 1e-9), cap)
        g = (1.0 - strength) + strength * raw
        for i in range(max(0, i0), min(n, i1)):
            gains[i] = g

    # ramp between adjacent note gains so a level change never steps discontinuously
    half = max(1, int(0.030 / hop_s) // 2)             # ~30 ms transition
    smoothed = [sum(gains[max(0, i - half):i + half + 1])
                / (min(n, i + half + 1) - max(0, i - half)) for i in range(n)]
    return _apply_gain_curve(render, smoothed, sr, hop_s)
