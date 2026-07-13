"""Performance lock — snap a sung render onto the TAKE's timing.

The SoulX target score carries words/phonemes/pitch/timing but places syllables
within a phrase freely, so a render lands close to — but not exactly on — the
take's clock. This module measures each word-event's local lag against the take
(envelope cross-correlation) and shifts that segment onto the slot's exact start
(`snap_to_events` / `event_lags`) — the timing snap that feeds the NSF re-vocode.

Dynamics are NOT painted here: NSF resynthesis supplies the render's natural
volume/attack/decay, so the old envelope-transfer step was dropped (it only ever
produced contrast artifacts once NSF owned dynamics).

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


def _pctl(sv: List[float], p: float) -> float:
    return sv[min(len(sv) - 1, max(0, int(round(p / 100.0 * (len(sv) - 1)))))]


def _gate_threshold(env: List[float], frac: float = GATE_FRAC) -> float:
    """Rest gate: below this, the signal is resting (deliberately low so quiet
    decay tails survive)."""
    if not env:
        return float("inf")
    return max(1e-6, frac * _pctl(sorted(env), 95))


SNAP_MAX_SHIFT_S = 0.12   # a word never moves more than this — beyond it, it's a miss
SNAP_XFADE_S = 0.010


def _window_lag(env_a: List[float], env_b: List[float], a: float, b: float,
                hop_s: float, max_lag_s: float) -> float:
    """Lag (s) of env_b vs env_a inside [a, b] — argmax of normalized cross-correlation
    over integer-hop lags, clamped to ±max_lag_s. Positive = b is late."""
    lo, hi = max(0, int(a / hop_s)), min(len(env_a), len(env_b), int(b / hop_s))
    seg_a = env_a[lo:hi]
    if len(seg_a) < 2:
        return 0.0
    max_l = max(1, int(max_lag_s / hop_s))
    scores = {}
    best, best_lag = -1.0, 0
    for lag in range(-max_l, max_l + 1):
        s = n_a = n_b = 0.0
        for i, va in enumerate(seg_a):
            j = lo + i + lag
            vb = env_b[j] if 0 <= j < len(env_b) else 0.0
            s += va * vb
            n_a += va * va
            n_b += vb * vb
        c = s / (n_a * n_b) ** 0.5 if (n_a > 0 and n_b > 0) else 0.0
        scores[lag] = c
        if c > best:
            best, best_lag = c, lag
    # parabolic interpolation around the argmax: hop-quantized lags (10 ms) systematically
    # miss by one hop; the sub-hop vertex recovers the true offset
    cm, c0, cp = scores.get(best_lag - 1), scores[best_lag], scores.get(best_lag + 1)
    delta = 0.0
    if cm is not None and cp is not None:
        denom = cm - 2.0 * c0 + cp
        if abs(denom) > 1e-12:
            delta = max(-0.5, min(0.5, 0.5 * (cm - cp) / denom))
    return (best_lag + delta) * hop_s


def event_lags(take: List[float], render: List[float], sr: int, events: List[tuple],
               hop_s: float = HOP_S, max_shift_s: float = SNAP_MAX_SHIFT_S) -> List[float]:
    """Per-event measured lag (s) of the render vs the take — the corrections
    snap_to_events applies; exposed for honest reporting."""
    if not events:
        return []
    env_t = energy_envelope(take, sr, hop_ms=hop_s * 1000.0)
    env_r = energy_envelope(render, sr, hop_ms=hop_s * 1000.0)
    ev = sorted((float(a), float(b)) for a, b in events)
    out = []
    for k, (start, end) in enumerate(ev):
        nxt = ev[k + 1][0] if k + 1 < len(ev) else None
        win_end = min(nxt, end + 0.3) if nxt is not None else end + 0.3
        lag = _window_lag(env_t, env_r, max(0.0, start - max_shift_s),
                          win_end + max_shift_s, hop_s, max_shift_s)
        out.append(max(-max_shift_s, min(max_shift_s, lag)))
    return out


def snap_to_events(take: List[float], render: List[float], sr: int,
                   events: List[tuple], hop_s: float = HOP_S,
                   max_shift_s: float = SNAP_MAX_SHIFT_S) -> List[float]:
    """Slot-level timing snap: each word event (start, end) — absolute on the take's
    timeline — gets its render audio shifted onto the slot's exact start. The lag is
    measured per event by envelope cross-correlation against the TAKE (whose syllables
    sit on the slots by construction) in the window bounded by the neighboring events;
    audio between events (legato continuations) rides with its parent word. Phrase snap
    fixes phrase STARTS; this fixes the syllables inside."""
    if not events:
        return list(render)
    ev = sorted((float(a), float(b)) for a, b in events)
    n_total = max(len(take), len(render))
    out = [0.0] * n_total
    xf = max(1, int(SNAP_XFADE_S * sr))
    # measure every event's lag FIRST: each window's copy must stop at the NEXT event's
    # SOURCE position, or a late next-word's head gets duplicated as a pre-echo
    lags = event_lags(take, render, sr, ev, hop_s, max_shift_s)
    wins = [(start, (min(ev[k + 1][0], end + 0.3) if k + 1 < len(ev) else end + 0.3))
            for k, (start, end) in enumerate(ev)]
    for k, ((start, win_end), lag) in enumerate(zip(wins, lags)):
        dst0, dst1 = int(start * sr), min(int(win_end * sr), n_total)
        src0 = int((start + lag) * sr)
        # one-hop guard on the cap: a lag mis-measured by a single hop must not leak the
        # next word's head into this window as a pre-echo
        src_cap = (int((ev[k + 1][0] + lags[k + 1] - hop_s) * sr)
                   if k + 1 < len(ev) else len(render))
        for i in range(dst0, dst1):
            j = src0 + (i - dst0)
            v = render[j] if 0 <= j < min(len(render), src_cap) else 0.0
            e = min(1.0, (i - dst0 + 1) / xf, (dst1 - i) / xf)
            out[i] += v * e
    return out


PHRASE_MAX_SHIFT_S = 0.25   # a phrase START can drift more than a syllable within it


def resample_linear(mono: List[float], sr_from: int, sr_to: int) -> List[float]:
    """Linear-interp resampler so the take and render envelopes meet at one rate (SoulX
    may emit 24k/48k; the take is its own). Stdlib; no-op at equal rate / empty input."""
    if sr_from == sr_to or not mono:
        return list(mono)
    n_out = max(1, int(round(len(mono) * sr_to / float(sr_from))))
    out, ratio = [], (len(mono) - 1) / float(max(1, n_out - 1))
    for i in range(n_out):
        x = i * ratio
        j = int(x)
        frac = x - j
        a = mono[j]
        b = mono[j + 1] if j + 1 < len(mono) else a
        out.append(a + (b - a) * frac)
    return out


def phrase_shifts(env_take: List[float], env_render: List[float], windows: List[tuple],
                  hop_s: float = HOP_S, max_shift_s: float = PHRASE_MAX_SHIFT_S) -> List[float]:
    """Per-phrase lag (s) of the render vs the take (positive = render late), measured
    inside each score phrase window PADDED by the max shift (an unpadded window clips a
    late phrase's tail and biases the correlation low); clamped to +/- max_shift_s."""
    out = []
    for (a, b, _n) in windows:
        lag = _window_lag(env_take, env_render, max(0.0, a - max_shift_s),
                          b + max_shift_s, hop_s, max_shift_s)
        out.append(max(-max_shift_s, min(max_shift_s, lag)))
    return out


def apply_shifts(render: List[float], sr: int, windows: List[tuple], shifts: List[float],
                 total_s: float = None) -> List[float]:
    """Rebuild the render on the take's timeline: each phrase's audio copied from its
    (lag-shifted) source span to the score-true span, crossfaded at the seams. Gaps
    between phrases stay silent (rests are rests)."""
    n_total = int((total_s if total_s is not None else (len(render) / sr)) * sr) + int(0.25 * sr)
    out = [0.0] * n_total
    xf = max(1, int(SNAP_XFADE_S * sr))
    for (a, b, _n), lag in zip(windows, shifts):
        dst0, dst1 = int(a * sr), min(int(b * sr), n_total)
        src0 = int((a + lag) * sr)
        for i in range(dst0, dst1):
            j = src0 + (i - dst0)
            v = render[j] if 0 <= j < len(render) else 0.0
            e = min(1.0, (i - dst0 + 1) / xf, (dst1 - i) / xf)
            out[i] += v * e
    return out


def snap_render_to_take(take: List[float], render: List[float], sr: int, clip: dict,
                        hop_s: float = HOP_S) -> List[float]:
    """The product timing-snap (the spike backhalf_perform.lock() snap, single-clip): from
    the authored SoulX `clip`, phrase-align the render onto the take's clock, then snap each
    word event onto its slot's exact start. `take`/`render` are same-rate mono lists. No-op
    safe: an empty clip (no windows/events) returns the render unchanged."""
    from soulx.score import phrase_windows, word_event_spans
    windows = phrase_windows(clip)
    events = word_event_spans(clip)
    if not windows and not events:
        return list(render)
    aligned = list(render)
    if windows:
        env_t = energy_envelope(take, sr, hop_ms=hop_s * 1000.0)
        env_r = energy_envelope(render, sr, hop_ms=hop_s * 1000.0)
        shifts = phrase_shifts(env_t, env_r, windows, hop_s=hop_s)
        aligned = apply_shifts(render, sr, windows, shifts, total_s=len(take) / sr)
    if events:
        aligned = snap_to_events(take, aligned, sr, events, hop_s=hop_s)
    return aligned


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
