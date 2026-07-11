#!/usr/bin/env python3
"""Hybrid render authoring + overlay (FMS stage 6, deterministic core).

The reviewed sheet has SUNG lines (his real words, rendered by SVC) and REWRITTEN lines
(new words, rendered by melody-mode on his real F0). This module authors the melody-mode
input for the rewritten lines and overlays the two renders:

- rewrite_spans(sheet)            -> [(start_s, end_s)] of the rewritten lines.
- author_melody_metadata(...)     -> ONE melody-mode clip that sings ONLY the rewritten
                                     lines (sung spans become <SP> rests), with the take's
                                     real F0 attached as the space-separated 50fps string
                                     control=melody reads (note_pitch is ignored in melody).
- overlay(svc, melody, spans, sr) -> SVC everywhere, melody inside the rewritten spans,
                                     short edge crossfades so the rest boundaries don't click.

Pure stdlib (+ soulx.score for the phoneme/timing authoring). The MPS renders + F0
extraction that feed this are owner-gated and live in the render driver.
"""
from __future__ import annotations

import math
from typing import List, Optional, Tuple


def _score_by_index(sheet: dict) -> dict:
    return {ln.get("index"): sc for ln, sc in zip(sheet.get("lines", []), sheet.get("lineScores", []))}


def _span(sc: Optional[dict]) -> Optional[Tuple[float, float]]:
    slots = (sc or {}).get("slots") or []
    if not slots:
        return None
    return (min(float(x["start"]) for x in slots), max(float(x["end"]) for x in slots))


def _is_rewritten(line: dict) -> bool:
    return line.get("origin") in ("generated", "mixed")


def rewrite_spans(sheet: dict) -> List[Tuple[float, float]]:
    """The time spans of the rewritten lines (where melody-mode replaces SVC)."""
    by = _score_by_index(sheet)
    spans = []
    for ln in sheet.get("lines", []):
        if _is_rewritten(ln):
            sp = _span(by.get(ln.get("index")))
            if sp:
                spans.append(sp)
    return sorted(spans)


def author_melody_metadata(sheet: dict, take_f0: List[float], fps: int = 50,
                           name: str = "hybrid", t_end: Optional[float] = None) -> dict:
    """Sheet + the take's F0 (Hz per 1/fps s) -> one melody-mode clip. Only rewritten lines
    sing; sung spans are <SP> rests (SVC covers them). `t_end` limits to rewritten lines
    starting before that time (for slice renders)."""
    from soulx import score as sx
    by = _score_by_index(sheet)
    rewritten = []
    for ln in sheet.get("lines", []):
        if not _is_rewritten(ln):
            continue
        sc = by.get(ln.get("index"))
        sp = _span(sc)
        if sp is None:
            continue
        if t_end is not None and sp[0] >= t_end:
            continue
        rewritten.append({"text": ln.get("text", ""), "score": sc})
    if not rewritten:
        return {"ok": False, "error": "no_rewritten_lines"}
    r = sx.author_score(rewritten, name=name)
    if not r.get("ok"):
        return r
    clip = r["score"][0]
    n = round(clip["time"][1] / 1000 * fps)
    f0 = [float(x) for x in take_f0[:n]]
    if len(f0) < n:
        f0 += [0.0] * (n - len(f0))         # pad the tail unvoiced if the take is shorter
    clip["f0"] = " ".join(f"{x:.1f}" for x in f0)
    return {"ok": True, "score": [clip], "n_frames": n, "rewritten": len(rewritten),
            "events": r.get("events"), "words": r.get("words"), "duration_s": r.get("duration_s")}


def overlay(svc, melody, spans: List[Tuple[float, float]], sr: int, xfade_ms: float = 30) -> List[float]:
    """SVC (the clear/sung voice, full length) with the melody render (rewritten phrases)
    spliced in over each rewritten span, with short linear crossfades at the edges so the
    rest boundaries never click. melody is silent outside the spans by construction."""
    out = [float(x) for x in svc]
    n = len(out)
    mlen = len(melody)
    xf = max(1, int(xfade_ms / 1000 * sr))
    for s, e in spans:
        i0, i1 = int(s * sr), int(e * sr)
        for k in range(max(0, i0), min(i1, n, mlen)):
            out[k] = float(melody[k])
        for k in range(max(0, i0 - xf), min(i0, n, mlen)):        # fade in: svc -> melody
            a = (k - (i0 - xf)) / xf
            out[k] = (1 - a) * float(svc[k]) + a * float(melody[k])
        for k in range(max(0, i1), min(i1 + xf, n, mlen)):        # fade out: melody -> svc
            a = (k - i1) / xf
            out[k] = (1 - a) * float(melody[k]) + a * float(svc[k])
    return out


def _rms(xs) -> float:
    return math.sqrt(sum(float(x) * x for x in xs) / len(xs)) if xs else 0.0


def gate_to_take(signal, take, sr: int, thresh_ratio: float = 0.03,
                 env_ms: float = 25, smooth_ms: float = 12) -> List[float]:
    """Silence-match (owner's rule: NO audio where the raw take is silent). Follows the take's
    envelope — a moving-average of |take|, thresholded vs its own peak, one-pole smoothed to
    avoid clicks — and multiplies it into `signal`. This kills score-synth bleed in the gaps
    where he wasn't singing; kept regions (== the take, above the floor) pass through."""
    n = min(len(signal), len(take))
    w = max(1, int(env_ms / 1000 * sr))
    env = [0.0] * n
    acc = 0.0
    for i in range(n):
        acc += abs(float(take[i]))
        if i >= w:
            acc -= abs(float(take[i - w]))
        env[i] = acc / min(i + 1, w)
    thr = thresh_ratio * max(max(env) if env else 0.0, 1e-9)
    coef = math.exp(-1.0 / max(1, int(smooth_ms / 1000 * sr)))
    out = [0.0] * n
    v = 0.0
    for i in range(n):
        target = 1.0 if env[i] > thr else 0.0
        v = target + coef * (v - target)          # one-pole toward the binary gate
        out[i] = float(signal[i]) * v
    return out


def splice_matched(base, insert, spans: List[Tuple[float, float]], sr: int,
                   xfade_ms: float = 30, match: bool = True, max_gain: float = 8.0) -> List[float]:
    """Keep-raw + splice-fixes (the owner's chosen architecture — NO global voice conversion).

    `base` is his RAW take, kept UNTOUCHED everywhere except the rewrite spans; `insert` is the
    score-mode synth of the new words (positioned at absolute time, silent outside its spans).
    Inside each span the synth replaces the mumble, level-matched to the take's RMS there (so a
    fix sits at his volume, not louder/quieter) and equal-power crossfaded at the rest edges so
    the real→synth boundary doesn't click. The kept audio is his real performance, verbatim."""
    out = [float(x) for x in base]
    n = len(out)
    ilen = len(insert)
    xf = max(1, int(xfade_ms / 1000 * sr))
    for s, e in spans:
        i0, i1 = int(s * sr), int(e * sr)
        a0, a1 = max(0, i0), min(i1, n, ilen)
        if a1 <= a0:
            continue
        g = 1.0
        if match:
            b_rms = _rms([base[k] for k in range(a0, a1)])
            i_rms = _rms([insert[k] for k in range(a0, a1)])
            if i_rms > 1e-6:
                g = min(max_gain, b_rms / i_rms)
        for k in range(a0, a1):
            out[k] = insert[k] * g
        for k in range(max(0, i0 - xf), a0):                       # equal-power fade in: raw -> synth
            t = (k - (i0 - xf)) / xf
            iv = insert[k] * g if k < ilen else 0.0
            out[k] = math.cos(t * math.pi / 2) * base[k] + math.sin(t * math.pi / 2) * iv
        for k in range(a1, min(i1 + xf, n)):                       # equal-power fade out: synth -> raw
            t = (k - i1) / xf
            iv = insert[k] * g if k < ilen else 0.0
            out[k] = math.cos(t * math.pi / 2) * iv + math.sin(t * math.pi / 2) * base[k]
    return out
