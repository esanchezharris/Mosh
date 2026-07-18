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
    timeline — gets its render audio shifted onto the slot's exact start. NOT in the
    product chain since mechanism-verify V3 (2026-07-17): blind-ranked worst in both
    ablation passages (see snap_render_to_take). Retained for ablation harnesses
    (scripts/fms-killshot/v3_assembly.py) and future re-evaluation only."""
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
    """Linear-interp resampler. Stdlib; no-op at equal rate / empty input. NOTE: linear
    interpolation is a POOR reconstruction filter for AUDIO — upsampling (e.g. SoulX's 24k
    render -> a 44.1k take) leaves spectral IMAGES above the source Nyquist (measured ~21x
    more 12-20k energy than a polyphase resampler), heard as HF harshness/"squeak". Use it
    only for non-audio ramps/envelopes; audio-render paths use resample_hq()."""
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


def resample_hq(mono: List[float], sr_from: int, sr_to: int) -> List[float]:
    """Band-limited polyphase resampler for AUDIO (scipy.signal.resample_poly) — proper
    anti-imaging so a 24k->44.1k upsample leaves the 12-22k band empty instead of smearing
    images into it. Falls back to resample_linear when numpy/scipy are unavailable (keeps
    stdlib-only runtimes working, just lower quality). Deterministic; no-op at equal rate."""
    if sr_from == sr_to or not mono:
        return list(mono)
    try:
        import math as _math

        import numpy as _np
        from scipy.signal import resample_poly as _rp
        g = _math.gcd(int(sr_from), int(sr_to))
        up, down = int(sr_to) // g, int(sr_from) // g
        y = _rp(_np.asarray(mono, dtype=_np.float64), up, down)
        return [float(v) for v in y]
    except Exception:  # noqa: BLE001 — no scipy/numpy: degrade to linear, never fail
        return resample_linear(mono, sr_from, sr_to)


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
    """The product timing-snap (single-clip): from the authored SoulX `clip`, phrase-align
    the render onto the take's clock — PHRASE level only. The per-word snap_to_events
    stage was REMOVED after mechanism-verify V3 (2026-07-17): it ranked WORST in both
    blind ablation passages while raising env_corr, and V0 measured it adding +30…50ms of
    vowel lateness — it optimized the alignment metric by damaging the sound. Word-level
    residuals are MEASURED (event_lags) for reporting, never enforced. `take`/`render`
    are same-rate mono lists. No-op safe: an empty clip returns the render unchanged."""
    from soulx.score import phrase_windows
    windows = phrase_windows(clip)
    if not windows:
        return list(render)
    env_t = energy_envelope(take, sr, hop_ms=hop_s * 1000.0)
    env_r = energy_envelope(render, sr, hop_ms=hop_s * 1000.0)
    shifts = phrase_shifts(env_t, env_r, windows, hop_s=hop_s)
    return apply_shifts(render, sr, windows, shifts, total_s=len(take) / sr)


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


# ── dynamics: give the render the take's LOUDNESS, per note ─────────────────────────────
# The SoulX target score has no dynamics channel (text/phoneme/pitch/note_type/duration and
# nothing else), so the model invents loudness conditioned on nothing from the take. Measured
# consequence on the own-pairs bench: energy-envelope correlation to the finished vocal 0.266,
# BELOW the 0.400 the untouched mumble scores, against a human-to-human band of 0.40-0.44.
#
# An earlier per-FRAME `transfer_envelope` was deleted (3fbb61d2) on the rationale "NSF
# supplies dynamics". That was wrong twice over: NSF ships OFF, and NSF's `perform` mode
# resynthesizes from the RENDER's own mel, so it transfers F0, never the take's loudness.
#
# Per-frame vs per-note is the whole difference. Frame-rate gain tracks the take's envelope
# hop by hop, so the render inherits an interior shape it never performed — that imported
# shape IS the "I can hear the volume automation rather than the words ending naturally"
# percept, and it MEASURES as overshoot: 0.726, far above the human band, with the worst pq
# of any arm. Per-note transfer takes only each note's LEVEL and leaves the model's own
# attack/decay inside the note alone: 0.414, in band, pq unchanged.
# Evidence: docs/superpowers/specs/2026-07-18-fms-performance-transfer-phase1-verdict.md

MAX_BOOST = 4.0        # never lift a note by more than this (no fabricating energy from hiss)
RAMP_S = 0.030         # inter-note gain transition, so a level change never steps


def _voicing_threshold(env: List[float]) -> float:
    """Above this the signal is actually SINGING (the overlap-QA convention — stricter than
    the rest gate, so breath under a note reads as non-voicing and is never boosted)."""
    if not env:
        return float("inf")
    sv = sorted(env)
    return max(1e-6, 4.0 * _pctl(sv, 5), 0.15 * _pctl(sv, 95))


def note_spans(clip: dict, total_s: float) -> List[tuple]:
    """[(start_s, end_s)] for each SOUNDED note of an authored clip (note_type 2/3; 1 is a
    rest). Authored durations laid end to end — the same clock `phrase_windows` reads."""
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


def transfer_note_dynamics(take: List[float], render: List[float], sr: int, clip: dict,
                           *, strength: float = 1.0, hop_s: float = HOP_S,
                           max_boost: float = MAX_BOOST, gate_frac: float = GATE_FRAC,
                           ramp_s: float = RAMP_S) -> List[float]:
    """Give each authored NOTE of `render` the loudness the take has over that span.

    One gain per note, held flat across it and ramped (~30 ms) between notes, so the curve
    moves at note rate rather than frame rate and the model's articulation inside each note
    survives. A note the take rests through is silenced; a note where the render is not
    voicing is never boosted (breath stays breath). `strength=0` returns the render
    byte-identical, matching duration.py's contract. No-op safe on an empty/degenerate clip."""
    if strength <= 0.0:
        return list(render)
    spans = note_spans(clip, len(render) / float(sr))
    if not spans:
        return list(render)
    env_t = energy_envelope(take, sr, hop_ms=hop_s * 1000.0)
    env_r = energy_envelope(render, sr, hop_ms=hop_s * 1000.0)
    if not env_t or not env_r:
        return list(render)

    th, th_r = _gate_threshold(env_t, gate_frac), _voicing_threshold(env_r)
    n = len(env_r)
    gains = [1.0] * n

    def _mean(env, a, b):
        seg = [env[i] for i in range(max(0, a), min(len(env), b))]
        return sum(seg) / len(seg) if seg else 0.0

    for s, e in spans:
        i0 = int(s / hop_s)
        i1 = max(int(e / hop_s), i0 + 1)
        et, er = _mean(env_t, i0, i1), _mean(env_r, i0, i1)
        if et < th:
            raw = 0.0                                   # the take rests across this note
        else:
            cap = max_boost if er >= th_r else 1.0
            raw = min(et / max(er, 1e-9), cap)
        g = (1.0 - strength) + strength * raw
        for i in range(max(0, i0), min(n, i1)):
            gains[i] = g

    half = max(1, int(ramp_s / hop_s) // 2)
    gains = [sum(gains[max(0, i - half):i + half + 1])
             / (min(n, i + half + 1) - max(0, i - half)) for i in range(n)]

    hop = max(1, int(sr * hop_s))
    out = []
    for j, v in enumerate(render):
        f = j / hop
        i = int(f)
        g = gains[-1] if i >= len(gains) - 1 else gains[i] + (gains[i + 1] - gains[i]) * (f - i)
        out.append(v * g)
    return out
