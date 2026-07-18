#!/usr/bin/env python3
"""Pure aggregation + good-vs-bad ranking over score_vocal() stats (no audio, no venvs).

FMS-Bench, increment 1. `score_vocal` (bench_score.py) emits
`{"correctness": {...}, "naturalness": {...}, "meta": {...}}`; this module aggregates a
list of those into per-axis means and ranks a known-GOOD render against a known-BAD one
(the metric-validity gate). POLARITY encodes which direction each metric improves.
"""
from __future__ import annotations

# Direction each metric key improves. "hi" = higher is better; "lo" = smaller |value| better.
POLARITY = {
    "f1": "hi", "precision": "hi", "recall": "hi",
    "median_abs_dt_ms": "lo", "global_lag_ms": "lo",
    "abs_median_st": "lo", "median_dsemitones": "lo", "octave_error_rate": "lo", "spread_st": "lo",
    "render_in_take_silence_pct": "lo", "take_in_render_silence_pct": "lo",
    "seq_ratio": "hi", "bag_coverage": "hi",
    "median_vowel_onset_delta_ms": "lo",
    "pq": "hi", "singmos": "hi",
}


def _leaves(d, out):
    """Flatten nested dicts to {key: float}; last key wins, non-numeric/None/bool skipped."""
    for k, v in (d or {}).items():
        if isinstance(v, dict):
            _leaves(v, out)
        elif isinstance(v, (int, float)) and not isinstance(v, bool):
            out[k] = float(v)
    return out


def aggregate(stats_list):
    """Mean each metric across a list of score_vocal stats, skipping absent/None leaves."""
    n = len(stats_list)
    acc = {"correctness": {}, "naturalness": {}}
    cnt = {"correctness": {}, "naturalness": {}}
    for s in stats_list:
        for axis in ("correctness", "naturalness"):
            for k, v in _leaves(s.get(axis), {}).items():
                acc[axis][k] = acc[axis].get(k, 0.0) + v
                cnt[axis][k] = cnt[axis].get(k, 0) + 1
    means = {axis: {k: round(acc[axis][k] / cnt[axis][k], 4) for k in acc[axis]} for axis in acc}
    return {"n": n, **means}


def human_band(values):
    """Summarize a metric across the real (mumble -> finished) pairs -> the HUMAN BAND.

    Two genuine human takes of the same song do not score 1.0 against each other; they land
    in a band. That band is the absolute scale the benchmark previously lacked. `spread` says
    whether it is one calibration constant (tight) or a per-song accident (wide)."""
    v = [float(x) for x in values if x is not None]
    if not v:
        return {"lo": None, "hi": None, "mean": None, "spread": None, "n": 0}
    return {"lo": round(min(v), 4), "hi": round(max(v), 4),
            "mean": round(sum(v) / len(v), 4), "spread": round(max(v) - min(v), 4), "n": len(v)}


def _better(key, a, b):
    """Is `a` strictly better than `b` for `key`? 'good'/'bad'/'tie', or None if incomparable."""
    pol = POLARITY.get(key)
    if pol is None:
        return None
    if pol == "lo":                       # smaller |value| is better
        a2, b2 = abs(a), abs(b)
        if a2 == b2:
            return "tie"
        return "good" if a2 < b2 else "bad"
    if a == b:                            # "hi": larger is better
        return "tie"
    return "good" if a > b else "bad"


def ranks(good, bad):
    """Per axis: `<axis>_ok` iff `good` wins a strict majority of comparable metric keys."""
    out = {"detail": {}}
    for axis in ("correctness", "naturalness"):
        ga, ba = _leaves(good.get(axis), {}), _leaves(bad.get(axis), {})
        detail, wins, comps = {}, 0, 0
        for k in sorted(set(ga) & set(ba)):
            v = _better(k, ga[k], ba[k])
            if v is None:
                continue
            detail[k] = v
            if v != "tie":
                comps += 1
                wins += 1 if v == "good" else 0
        out["detail"][axis] = detail
        out[f"{axis}_ok"] = comps > 0 and wins * 2 > comps
    return out
