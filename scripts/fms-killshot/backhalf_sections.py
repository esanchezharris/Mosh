#!/usr/bin/env python3
"""Full-take section planner + line offsetter (2026-07-16).

The grid path bins nuclei into bars and TRUNCATES at MAX_BARS=32 (lyrics/mumble.py) — at
152bpm that is ~50s, so a full take must be built in sections. Codex skipped this and
rendered 137s as one clip (silent truncation + a temporally-unrelated render). Here the
handling is deliberate: split the take AT REAL RESTS into sections under the bar cap,
build each section's grid + lyrics locally, then shift the authored lines' slot times back
onto the take timeline (`offset_lines`) so `soulx.score.author_score` emits ONE score on
the take clock. Hard cuts (no rest in reach) are flagged, never silent.

Pure + deterministic; rest detection reuses the product gate (skeleton.segment.gate_events)
so "a rest" means exactly what the grid itself considers silence.
"""
from __future__ import annotations

import json
import os
import sys
from typing import List, Tuple

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(_HERE)), "service"))

from skeleton import segment  # noqa: E402


def rest_gaps(env: List[float], hop_s: float, min_rest_s: float = 0.4) -> List[Tuple[float, float]]:
    """Silent gaps between gate-open spans (>= min_rest_s), incl. leading/trailing silence."""
    _, spans = segment.gate_events(env, hop_s)
    dur = len(env) * hop_s
    gaps, prev = [], 0.0
    for a, b in spans:
        if a - prev >= min_rest_s:
            gaps.append((round(prev, 4), round(a, 4)))
        prev = b
    if dur - prev >= min_rest_s:
        gaps.append((round(prev, 4), round(dur, 4)))
    return gaps


def plan_sections(env: List[float], hop_s: float, cap_s: float,
                  min_rest_s: float = 0.4) -> List[dict]:
    """Tile [0, take_end] into sections <= cap_s, cutting at rest midpoints.

    Cut choice per window: the LONGEST rest whose midpoint falls in the later half of
    (a, a+cap_s] — a long rest is the safest seam; falling back to any in-window rest,
    then to an honestly-flagged hard cut at the cap (cut: "rest" | "hard" | "end")."""
    dur = round(len(env) * hop_s, 4)
    inner = [g for g in rest_gaps(env, hop_s, min_rest_s) if g[0] > 0.0 and g[1] < dur]
    out, a = [], 0.0
    while dur - a > cap_s + 1e-9:
        window = [g for g in inner if a < 0.5 * (g[0] + g[1]) <= a + cap_s]
        late = [g for g in window if 0.5 * (g[0] + g[1]) > a + 0.5 * cap_s]
        pool = late or window
        if pool:
            g = max(pool, key=lambda g: (g[1] - g[0], 0.5 * (g[0] + g[1])))
            b, cut = round(0.5 * (g[0] + g[1]), 4), "rest"
        else:
            b, cut = round(a + cap_s, 4), "hard"
        out.append({"a": round(a, 4), "b": b, "cut": cut})
        a = b
    out.append({"a": round(a, 4), "b": dur, "cut": "end"})
    return out


def offset_lines(lines: List[dict], t0: float) -> List[dict]:
    """Deep-copied lines with every slot + segment time shifted by t0 (section start ->
    take timeline). author_score reads only these times, so this is the whole re-basing."""
    out = json.loads(json.dumps(lines))
    for ln in out:
        sc = ln.get("score")
        if not isinstance(sc, dict):
            continue
        for sl in sc.get("slots") or []:
            sl["start"] = round(float(sl["start"]) + t0, 4)
            sl["end"] = round(float(sl["end"]) + t0, 4)
            for seg in sl.get("segments") or []:
                seg["start"] = round(float(seg["start"]) + t0, 4)
                seg["end"] = round(float(seg["end"]) + t0, 4)
    return out
