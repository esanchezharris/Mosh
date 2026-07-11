"""Performance transfer — constrain a sung render to the TAKE's delivery.

The SoulX target score carries words/phonemes/pitch/timing but NO dynamics: the
model invents its own volume, attack, and decay, so a render never wears the
producer's performance — and "it doesn't feel like my idea brought to life."
This module transfers the take's energy envelope onto the render
deterministically:

  gain[frame] = take_env / render_env,  with
    - silence gate: frames where the take rests force gain 0 (kills model
      breath/hiss between phrases),
    - boost cap: a note the render barely sang is not amplified into noise,
    - short smoothing against zipper artifacts,
    - a strength dial (1.0 = wear the take exactly, 0.0 = untouched).

`env_corr` is the honest fit metric: envelope correlation on take-ACTIVE frames
(the same convention the ACE audit used — a missed phrase tanks it, rests can't
inflate it). Pure stdlib lists in/out; the envelope core is shared with the
skeleton segmenter.
"""
from __future__ import annotations

import math
from typing import List

from skeleton.core import energy_envelope

HOP_S = 0.010
GATE_FRAC = 0.05      # take-active threshold: this fraction of the envelope's p95
MAX_BOOST = 4.0       # never lift a render frame by more than this factor
SMOOTH_HOPS = 3       # centered moving average over the gain curve (~30 ms)


def _pctl(sv: List[float], p: float) -> float:
    return sv[min(len(sv) - 1, max(0, int(round(p / 100.0 * (len(sv) - 1)))))]


def _gate_threshold(env: List[float], frac: float = GATE_FRAC) -> float:
    """Rest gate: below this, the signal is resting (deliberately low so quiet
    decay tails survive)."""
    if not env:
        return float("inf")
    return max(1e-6, frac * _pctl(sorted(env), 95))


def _voicing_threshold(env: List[float]) -> float:
    """Voicing gate: above this, the signal is actually SINGING (the overlap-QA
    convention — stricter than the rest gate, so breath under a note reads as
    non-voicing and is never boosted)."""
    if not env:
        return float("inf")
    sv = sorted(env)
    return max(1e-6, 4.0 * _pctl(sv, 5), 0.15 * _pctl(sv, 95))


def transfer_envelope(take: List[float], render: List[float], sr: int,
                      hop_s: float = HOP_S, smooth_hops: int = SMOOTH_HOPS,
                      max_boost: float = MAX_BOOST, strength: float = 1.0,
                      gate_frac: float = GATE_FRAC) -> List[float]:
    """Return the render gain-matched to the take's energy envelope (same length)."""
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
            # boost only where the render is actually VOICING; breath/hiss under a
            # take note is left at unity, never amplified into fake energy
            cap = max_boost if env_r[i] >= th_r else 1.0
            raw = min(et / max(env_r[i], 1e-9), cap)
        gains.append((1.0 - strength) + strength * raw)

    if smooth_hops > 1:
        half = smooth_hops // 2
        gains = [sum(gains[max(0, i - half):i + half + 1])
                 / (min(len(gains), i + half + 1) - max(0, i - half))
                 for i in range(len(gains))]

    hop = max(1, int(sr * hop_s))
    out = []
    for j, v in enumerate(render):
        f = j / hop
        i = int(f)
        if i >= len(gains) - 1:
            g = gains[-1]
        else:
            frac = f - i
            g = gains[i] + (gains[i + 1] - gains[i]) * frac
        out.append(v * g)
    return out


def env_corr(ref: List[float], other: List[float], sr: int,
             hop_s: float = HOP_S, gate_frac: float = GATE_FRAC) -> float:
    """Pearson correlation of the two energy envelopes over ref-ACTIVE frames."""
    env_a = energy_envelope(ref, sr, hop_ms=hop_s * 1000.0)
    env_b = energy_envelope(other, sr, hop_ms=hop_s * 1000.0)
    n = min(len(env_a), len(env_b))
    if n < 2:
        return 0.0
    th = _gate_threshold(env_a[:n], gate_frac)
    xs = [(env_a[i], env_b[i]) for i in range(n) if env_a[i] >= th]
    if len(xs) < 2:
        return 0.0
    ma = sum(a for a, _ in xs) / len(xs)
    mb = sum(b for _, b in xs) / len(xs)
    cov = sum((a - ma) * (b - mb) for a, b in xs)
    va = sum((a - ma) ** 2 for a, _ in xs)
    vb = sum((b - mb) ** 2 for _, b in xs)
    if va <= 0.0 or vb <= 0.0:
        return 0.0
    return cov / math.sqrt(va * vb)
