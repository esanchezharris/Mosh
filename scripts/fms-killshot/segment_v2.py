#!/usr/bin/env python3
"""Skeleton segmentation v2 (owner's rule, 2026-07-03): a new note/syllable starts when
the PITCH CHANGES or the level RE-ATTACKS through an energy gate; candidate boundaries
snap-with-tolerance to a simple quarter/eighth grid. The waveform's energy envelope is
first-class evidence — v1 trusted Basic-Pitch note edges + raw frame-to-frame F0 jumps,
which fires on vibrato/scoops ("illogical breaks") and misses soft re-articulations.

Pure stdlib, deterministic, harness-only (A/B against v1 via diagnose.py --algo both;
promotion into service/skeleton/core.py is a separate step after the ear verdict).

Boundary rules:
  - gate re-attack (closed -> open)        -> kind "attack"  (always kept: a real sound
    onset must open a nucleus even off-grid; it still snaps when within tolerance)
  - relative energy dip inside a span      -> kind "dip"    (the consonant valley between
    connected syllables — la-la on one pitch never crosses the absolute gate; the local
    dip IS the re-articulation. Noisiest detector, so off-grid dips are dropped)
  - sustained pitch step, energy continuous -> kind "legato" (melisma disambiguator:
    counted as a syllable per the locked decision, tagged for the Phase-3 render skeleton;
    DROPPED when it lands nowhere near a gridline — that's the illogical-break filter)

Selftest: python3 segment_v2.py --selftest   (synthetic cases, 3x identical)
"""
from __future__ import annotations

import math
from typing import List, Optional, Tuple

HOP_MS = 10.0            # aligns with FCPE's contour hop
WIN_MS = 25.0
GATE_FLOOR_MULT = 4.0    # theta_hi = max(4 x p5, 0.15 x p95)
GATE_P95_FRAC = 0.15
GATE_CLOSE_FRAC = 0.5    # theta_lo = 0.5 x theta_hi (hysteresis)
STEP_ST = 1.0            # sustained pitch step >= 1 semitone
STEP_SUSTAIN = 3         # frames the new level must hold (~30 ms) — kills vibrato/scoops
STEP_MEDIAN_K = 5        # median filter width for the semitone track
GRID_TOL = 0.25          # snap window: +/- 25% of an eighth
MIN_SPAN_S = 0.04        # gate spans shorter than this are noise blips
DIP_DEPTH = 0.55         # a valley must fall below 55% of BOTH neighbouring peaks (~-5 dB)
DIP_MIN_SEP_S = 0.08     # dips closer than this to the last boundary are the same event


def _pctl(sorted_vals: list, p: float) -> float:
    if not sorted_vals:
        return 0.0
    i = min(len(sorted_vals) - 1, max(0, int(round(p / 100.0 * (len(sorted_vals) - 1)))))
    return sorted_vals[i]


def energy_envelope(mono: List[float], sr: int, hop_ms: float = HOP_MS,
                    win_ms: float = WIN_MS) -> List[float]:
    """RMS frames over the mono signal (prefix-sum of squares, O(n))."""
    hop = max(1, int(sr * hop_ms / 1000.0))
    win = max(hop, int(sr * win_ms / 1000.0))
    acc = [0.0]
    for v in mono:
        acc.append(acc[-1] + v * v)
    env = []
    for s in range(0, max(1, len(mono) - win + 1), hop):
        e = acc[s + win] - acc[s]
        env.append(math.sqrt(e / win))
    return env


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
    """Relative energy dips inside gate-open spans -> re-articulation times (kind 'dip').

    Walk each span tracking the running peak; when the envelope falls below depth x peak
    and then recovers above depth x valley-relative level, the valley is a syllable
    boundary (the consonant trough between connected vowels)."""
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


def _median(vals: list) -> float:
    s = sorted(vals)
    n = len(s)
    return s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2])


def pitch_step_events(f0: Optional[List[dict]], step_st: float = STEP_ST,
                      sustain: int = STEP_SUSTAIN, median_k: int = STEP_MEDIAN_K,
                      max_gap_s: float = 0.03) -> List[float]:
    """Sustained pitch steps on the voiced contour -> event times (kind 'legato').

    f0 = [{t, hz}] voiced frames only. Median-filter the semitone track, then fire where
    the filtered level jumps >= step_st between temporally-adjacent frames AND the next
    `sustain` frames hold within step_st/2 of the new level."""
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
    # collapse bursts: one event per sustained step
    out = []
    for t in events:
        if not out or t - out[-1] > sustain * 0.01 * 2:
            out.append(t)
    return out


def snap_to_grid(events: List[Tuple[float, str]], bpm: float, time_sig=(4, 4),
                 grid: str = "1/8", tol: float = GRID_TOL):
    """Snap (time, kind) events to the nearest gridline within +/- tol x spacing.

    'attack' events are ALWAYS kept (a real onset must open a nucleus): snapped when
    within tolerance, left at their raw time otherwise. 'dip' and 'legato' events
    outside tolerance are DROPPED (the illogical-break filter). One event per gridline:
    attack beats dip beats legato, then earliest. Returns (kept_sorted, dropped_count)."""
    den = {"1/4": 1.0, "1/8": 2.0, "1/16": 4.0}.get(grid, 2.0)
    spacing = (60.0 / bpm) / den if bpm > 0 else 0.25
    per_line: dict = {}
    loose, dropped = [], 0
    rank = {"attack": 0, "dip": 1, "legato": 2}
    for t, kind in events:
        line = round(t / spacing)
        g = line * spacing
        if abs(t - g) <= tol * spacing:
            cur = per_line.get(line)
            if cur is None or (rank[kind], g) < (rank[cur[1]], cur[0]):
                per_line[line] = (g, kind)
        elif kind == "attack":
            loose.append((t, kind))
        else:
            dropped += 1
    kept = sorted(list(per_line.values()) + loose)
    return kept, dropped


def nuclei_v2(mono: List[float], sr: int, f0: Optional[List[dict]], bpm: float,
              time_sig=(4, 4), grid: str = "1/8") -> dict:
    """Full v2 extraction -> {"nuclei": [...], "boundaries": {...}} .

    Nuclei carry {start, end, velocity (1-127, Basic-Pitch-compatible so mumble._stress
    works unchanged), pitch (median-F0 MIDI or None), kind attack|dip|legato}."""
    hop_s = HOP_MS / 1000.0
    env = energy_envelope(mono, sr)
    attacks, spans = gate_events(env, hop_s)
    dips = dip_events(env, hop_s, spans)
    legatos = pitch_step_events(f0)
    kept, dropped = snap_to_grid([(t, "attack") for t in attacks] +
                                 [(t, "dip") for t in dips] +
                                 [(t, "legato") for t in legatos], bpm, time_sig, grid)

    p95 = _pctl(sorted(env), 95) or 1.0
    take_med_pitch = None
    if f0:
        hz = [float(p["hz"]) for p in f0 if float(p.get("hz", 0)) > 0]
        if hz:
            take_med_pitch = int(round(69 + 12 * math.log2(_median(hz) / 440.0)))

    def _vel(a: float, b: float) -> int:
        lo, hi = int(a / hop_s), max(int(a / hop_s) + 1, int(b / hop_s))
        peak = max(env[lo:hi]) if env[lo:hi] else 0.0
        return max(1, min(127, int(round(126 * peak / p95)) + 1))

    def _pitch(a: float, b: float):
        if not f0:
            return take_med_pitch
        hz = [float(p["hz"]) for p in f0 if a <= float(p["t"]) < b and float(p.get("hz", 0)) > 0]
        if not hz:
            return take_med_pitch
        return int(round(69 + 12 * math.log2(_median(hz) / 440.0)))

    nuclei = []
    for span_a, span_b in spans:
        # boundaries inside this gate-open span partition it; the span start opens it
        bounds = [span_a] + [g for g, kind in kept if span_a < g < span_b] + [span_b]
        kinds = ["attack"] + [kind for g, kind in kept if span_a < g < span_b]
        for i in range(len(bounds) - 1):
            a, b = bounds[i], bounds[i + 1]
            if b - a < MIN_SPAN_S:  # sliver at a span edge — merge away
                continue
            nuclei.append({"start": round(a, 4), "end": round(b, 4),
                           "velocity": _vel(a, b), "pitch": _pitch(a, b),
                           "kind": kinds[i]})
    return {
        "nuclei": nuclei,
        "boundaries": {"attacks": len(attacks), "dip_events": len(dips),
                       "legato_events": len(legatos),
                       "dropped_by_grid": dropped,
                       "legato_kept": sum(1 for n in nuclei if n["kind"] == "legato"),
                       "dip_kept": sum(1 for n in nuclei if n["kind"] == "dip"),
                       "gate_spans": len(spans)},
    }


# ---------------------------------------------------------------- v3: prune v1
# Ear verdict 2026-07-03: v1 (Basic-Pitch nuclei) is CLOSE — right density, 16ths intact,
# right beep pitches — but has "illogical breaks". v2's from-scratch re-segmentation lost
# 16ths (8th-grid drops) and beeped wrong notes (per-window median F0). So v3 applies the
# owner's rule as a PRUNER on v1: a v1 boundary survives only with evidence — the note
# changes across it, a real silence gap, or the envelope dips at it. Evidenced boundaries
# snap to the 16th lattice (8th/quarter lines preferred) when within tolerance; boundaries
# with NO evidence merge away. Nothing is invented, nothing evidenced is dropped.

PRUNE_GAP_S = 0.03        # inter-nucleus silence ≥ this = a real break (kind "gap")
PRUNE_PITCH_ST = 1.0      # note change across the boundary ≥ 1 semitone (kind "note")
PRUNE_DIP_FRAC = 0.60     # envelope valley near the boundary below 60% of the quieter
PRUNE_DIP_WIN_S = 0.06    #   neighbouring peak, searched ± this window (kind "dip")
PRUNE_GRID_TOL = 0.25     # snap window: ± 25% of a 16th


def _env_at(env: List[float], hop_s: float, a: float, b: float, fn) -> float:
    lo = max(0, int(a / hop_s))
    hi = min(len(env), max(lo + 1, int(b / hop_s)))
    seg = env[lo:hi]
    return fn(seg) if seg else 0.0


def _f0_median_st(f0, a: float, b: float) -> Optional[float]:
    if not f0:
        return None
    st = [12.0 * math.log2(float(p["hz"]) / 440.0)
          for p in f0 if a <= float(p["t"]) < b and float(p.get("hz", 0)) > 0]
    return _median(st) if st else None


def _snap16(t: float, bpm: float, tol: float = PRUNE_GRID_TOL) -> Tuple[float, bool]:
    """Snap t to the 16th lattice, preferring 8th/quarter lines when two lines qualify."""
    s16 = (60.0 / bpm) / 4.0 if bpm > 0 else 0.125
    line = round(t / s16)
    cands = [ln for ln in (line - 1, line, line + 1) if abs(t - ln * s16) <= tol * s16]
    if not cands:
        return t, False
    # metric weight: quarter (line%4==0) > 8th (line%2==0) > 16th; then nearest
    best = min(cands, key=lambda ln: ((ln % 4 != 0) + (ln % 2 != 0), abs(t - ln * s16)))
    return best * s16, True


def prune_v1_nuclei(nuclei: List[dict], pitches: List[Optional[int]],
                    mono: List[float], sr: int, f0: Optional[List[dict]],
                    bpm: float) -> dict:
    """v1 nuclei + their parent-note pitches -> merged/snapped nuclei + evidence log.

    For each boundary between consecutive nuclei: keep on gap/note-change/dip evidence
    (snapping evidenced boundaries to the 16th lattice, 8ths preferred), else merge."""
    if len(nuclei) <= 1:
        return {"nuclei": [dict(n) for n in nuclei], "pitches": list(pitches),
                "evidence": {"gap": 0, "note": 0, "dip": 0, "offgrid": 0},
                "merged_away": 0}
    hop_s = HOP_MS / 1000.0
    env = energy_envelope(mono, sr)
    counts = {"gap": 0, "note": 0, "dip": 0, "offgrid": 0}
    out = [dict(nuclei[0])]
    out_p = [pitches[0]]
    merged = 0
    for n, p in zip(nuclei[1:], pitches[1:]):
        a = out[-1]
        t = float(n["start"])
        kind = None
        if t - float(a["end"]) >= PRUNE_GAP_S:
            kind = "gap"
        else:
            pa = _f0_median_st(f0, float(a["start"]), float(a["end"]))
            pb = _f0_median_st(f0, t, float(n["end"]))
            if pa is not None and pb is not None:
                if abs(pb - pa) >= PRUNE_PITCH_ST:
                    kind = "note"
            elif out_p[-1] is not None and p is not None and abs(p - out_p[-1]) >= PRUNE_PITCH_ST:
                kind = "note"
            if kind is None:
                pk_a = _env_at(env, hop_s, max(float(a["start"]), t - 3 * PRUNE_DIP_WIN_S), t, max)
                pk_b = _env_at(env, hop_s, t, min(float(n["end"]), t + 3 * PRUNE_DIP_WIN_S), max)
                valley = _env_at(env, hop_s, t - PRUNE_DIP_WIN_S, t + PRUNE_DIP_WIN_S, min)
                ref = min(pk_a, pk_b)
                if ref > 0 and valley < PRUNE_DIP_FRAC * ref:
                    kind = "dip"
        if kind is None:
            a["end"] = max(float(a["end"]), float(n["end"]))     # merge: no evidence
            a["velocity"] = max(float(a["velocity"]), float(n.get("velocity", 0)))
            merged += 1
            continue
        counts[kind] += 1
        g, on_grid = _snap16(t, bpm)
        if not on_grid:
            counts["offgrid"] += 1
        elif g != t and float(a["start"]) < g < float(n["end"]):
            a["end"] = round(g, 4)                               # slide the cut to the line
            n = dict(n); n["start"] = round(g, 4)
        nn = dict(n); nn["kind"] = kind
        out.append(nn)
        out_p.append(p)
    return {"nuclei": out, "pitches": out_p, "evidence": counts, "merged_away": merged}


def articulation_groups(nuclei: List[dict], pitches: List[Optional[int]]) -> List[dict]:
    """Group v3 nuclei into ARTICULATIONS (owner's rule 2026-07-03: a new note is not a
    new word). A nucleus whose kind is "note" (pitch changed, energy continuous) CONTINUES
    the previous articulation — a melisma segment — while "gap"/"dip"/first-of-span starts
    a new one. Each group = one syllable slot for the lyric grid; `segments` keeps the
    per-note pitch/time detail for the render skeleton (and the legato beep re-synth)."""
    groups: List[dict] = []
    for n, p in zip(nuclei, pitches):
        seg = {"start": float(n["start"]), "end": float(n["end"]),
               "pitch": p if p is not None else 69}
        if groups and n.get("kind") == "note" and \
                float(n["start"]) - groups[-1]["end"] < 1e-6:
            g = groups[-1]
            g["end"] = seg["end"]
            g["velocity"] = max(g["velocity"], float(n.get("velocity", 0)))
            g["segments"].append(seg)
        else:
            groups.append({"start": seg["start"], "end": seg["end"],
                           "velocity": float(n.get("velocity", 0)),
                           "kind": n.get("kind", "attack"),
                           "segments": [seg]})
    return groups


def fuse_asr_budget(groups: List[dict], words: List[dict], bpm: float,
                    tol: float = PRUNE_GRID_TOL) -> Tuple[List[dict], dict]:
    """v4 (owner's idea, 2026-07-03): ASR counts, DSP times. `words` are GENEROUSLY
    decoded ASR words [{start, end, syl}] — wrong words welcome, only their syllable
    budget and span matter. Within each word span, surplus articulation groups fold
    into their predecessor (same mechanism as melisma folding: the audio is one word),
    weakest evidence first — off-grid before on-grid, dip-kind before gap-kind. Fewer
    groups than budget -> keep (never invent). Groups outside any word span (ASR heard
    silence/no word) pass through verbatim. Pure stdlib; caller supplies syllable
    counts (phonology stays out of this module)."""
    s16 = (60.0 / bpm) / 4.0 if bpm > 0 else 0.125

    # Budget at PHRASE level (contiguous words, gap < 0.4 s), spans extended to the next
    # phrase's start: word-level spans proved too fine for sung timing (ASR word ends
    # land early on held notes; boundary slots get mis-assigned and over-fold).
    phrases: List[dict] = []
    for w in sorted(words, key=lambda x: float(x["start"])):
        if phrases and float(w["start"]) - phrases[-1]["end"] < 0.4:
            phrases[-1]["end"] = max(phrases[-1]["end"], float(w["end"]))
            phrases[-1]["syl"] += max(1, int(w.get("syl", 1)))
        else:
            phrases.append({"start": float(w["start"]), "end": float(w["end"]),
                            "syl": max(1, int(w.get("syl", 1)))})
    for p, nxt in zip(phrases, phrases[1:]):
        p["span_end"] = nxt["start"]
    if phrases:
        phrases[-1]["span_end"] = phrases[-1]["end"] + 2.0

    def word_of(t: float) -> int:
        for i, p in enumerate(phrases):
            if p["start"] - 0.05 <= t < p["span_end"]:
                return i
        return -1

    out = [dict(g, segments=list(g["segments"])) for g in groups]
    owner = [word_of(g["start"]) for g in out]
    folded = 0
    words_over = words_under = 0
    kind_rank = {"dip": 0, "note": 1, "gap": 2, "attack": 3}
    for wi, w in enumerate(phrases):
        idxs = [i for i, o in enumerate(owner) if o == wi]
        budget = max(1, int(w.get("syl", 1)))
        if len(idxs) < budget:
            words_under += 1
            continue
        if len(idxs) == budget:
            continue
        words_over += 1
        # fold candidates: every group in the span except the first; weakest first
        def weakness(i: int):
            g = out[i]
            off = abs(g["start"] - round(g["start"] / s16) * s16) > tol * s16
            return (0 if off else 1, kind_rank.get(g.get("kind", "gap"), 2), g["start"])
        for i in sorted(idxs[1:], key=weakness)[: len(idxs) - budget]:
            out[i]["_fold"] = True
            folded += 1
    fused: List[dict] = []
    for g in out:
        if g.pop("_fold", False) and fused:
            prev = fused[-1]
            prev["end"] = max(prev["end"], g["end"])
            prev["velocity"] = max(prev["velocity"], g["velocity"])
            prev["segments"] += g["segments"]
        else:
            fused.append(g)
    stats = {"asr_words": len(words), "asr_phrases": len(phrases),
             "words_over": words_over, "words_under": words_under,
             "folded_by_asr": folded,
             "unassigned_groups": sum(1 for o in owner if o < 0)}
    return fused, stats


# ---------------------------------------------------------------- selftest
def _selftest_once() -> str:
    import json
    sr = 8000
    # two bursts of a 220 Hz then 262 Hz tone with a silent gap: expect 2 gate spans,
    # and a legato pitch step inside the second burst (220 -> 277 held).
    def tone(hz, n, amp=0.5):
        return [amp * math.sin(2 * math.pi * hz * i / sr) for i in range(n)]
    mono = (tone(220, 4000) + [0.0] * 2400 + tone(220, 2000) + tone(277, 2600))
    f0 = []
    t = 0.0
    for seg, hz in ((4000, 220), (2400, 0), (2000, 220), (2600, 277)):
        for i in range(0, seg, 80):
            if hz:
                f0.append({"t": round(t + i / sr, 4), "hz": hz})
        t += seg / sr
    r = nuclei_v2(mono, sr, f0, bpm=120)
    b = r["boundaries"]
    assert b["gate_spans"] == 2, b
    assert b["attacks"] == 2, b
    assert b["legato_events"] >= 1, b
    kinds = [n["kind"] for n in r["nuclei"]]
    assert kinds.count("attack") == 2 and kinds.count("legato") >= 1, kinds
    ps = [n["pitch"] for n in r["nuclei"]]
    assert ps[0] == 57 and ps[-1] == 61, ps           # A3=57 (220 Hz), C#4=61 (277 Hz)
    # dip case: same-pitch la-la — two loud vowels joined by a shallow valley that never
    # crosses the absolute gate; the relative dip must produce the boundary. Real takes
    # contain silence (the gate floor), so the synthetic needs some too.
    lala = ([0.0] * 1600 + tone(220, 3600) + [0.35 * v for v in tone(220, 800)]
            + tone(220, 3600) + [0.0] * 1600)
    env2 = energy_envelope(lala, sr)
    _, spans2 = gate_events(env2, HOP_MS / 1000.0)
    assert len(spans2) == 1, spans2                    # gate never closes...
    dips2 = dip_events(env2, HOP_MS / 1000.0, spans2)
    assert len(dips2) == 1, dips2                      # ...but the dip is caught
    # grid filter: an off-grid legato event must be dropped
    kept, dropped = snap_to_grid([(0.5, "attack"), (0.62, "legato"), (0.75, "legato")],
                                 bpm=120, grid="1/8")
    assert dropped == 1 and len(kept) == 2, (kept, dropped)
    assert kept[0] == (0.5, "attack") and kept[1] == (0.75, "legato"), kept

    # ---- v3 pruner cases (120 bpm: 16th = 0.125s) ----
    # (a) held vowel double-detected by Basic Pitch: contiguous, same pitch, no dip -> MERGE
    vowel = tone(220, 8000, amp=0.5)
    f0v = [{"t": round(i / sr, 4), "hz": 220} for i in range(0, 8000, 80)]
    nuc = [{"start": 0.0, "end": 0.5, "velocity": 90},
           {"start": 0.5, "end": 1.0, "velocity": 80}]
    rp = prune_v1_nuclei(nuc, [57, 57], vowel, sr, f0v, bpm=120)
    assert len(rp["nuclei"]) == 1 and rp["merged_away"] == 1, rp["evidence"]
    # (b) la-la with a real dip at the same boundary -> KEPT as "dip"
    lala3 = tone(220, 4000, 0.5) + [0.15 * v for v in tone(220, 400)] + tone(220, 3600, 0.5)
    rp2 = prune_v1_nuclei(nuc, [57, 57], lala3, sr, f0v, bpm=120)
    assert len(rp2["nuclei"]) == 2 and rp2["evidence"]["dip"] == 1, rp2["evidence"]
    # (c) note change across the boundary -> KEPT as "note", even with no dip
    f0nc = ([{"t": round(i / sr, 4), "hz": 220} for i in range(0, 4000, 80)]
            + [{"t": round((4000 + i) / sr, 4), "hz": 262} for i in range(0, 4000, 80)])
    rp3 = prune_v1_nuclei(nuc, [57, 60], vowel, sr, f0nc, bpm=120)
    assert len(rp3["nuclei"]) == 2 and rp3["evidence"]["note"] == 1, rp3["evidence"]
    # (d) snap prefers the 8th line: 0.51 is within tol of the 0.5 8th line
    g, ok = _snap16(0.51, bpm=120)
    assert ok and abs(g - 0.5) < 1e-9, (g, ok)
    # (e) a real silence gap survives as "gap"
    nug = [{"start": 0.0, "end": 0.45, "velocity": 90},
           {"start": 0.55, "end": 1.0, "velocity": 80}]
    rp4 = prune_v1_nuclei(nug, [57, 57], vowel, sr, f0v, bpm=120)
    assert len(rp4["nuclei"]) == 2 and rp4["evidence"]["gap"] == 1, rp4["evidence"]
    # (f) articulation grouping: note-kind continuation folds into ONE group (melisma =
    #     one syllable slot, two pitch segments); a dip-kind starts a new group
    tri = [{"start": 0.0, "end": 0.5, "velocity": 90},
           {"start": 0.5, "end": 1.0, "velocity": 80, "kind": "note"},
           {"start": 1.0, "end": 1.5, "velocity": 85, "kind": "dip"}]
    gs = articulation_groups(tri, [57, 60, 60])
    assert len(gs) == 2, gs
    assert len(gs[0]["segments"]) == 2 and [s["pitch"] for s in gs[0]["segments"]] == [57, 60], gs[0]
    assert gs[0]["velocity"] == 90 and abs(gs[0]["end"] - 1.0) < 1e-9, gs[0]
    # ---- v4 ASR-budget fusion cases (120 bpm: 16th = 0.125s) ----
    def G(a, b, kind="gap", pitch=57):
        return {"start": a, "end": b, "velocity": 90, "kind": kind,
                "segments": [{"start": a, "end": b, "pitch": pitch}]}
    # (g) 3 groups inside a 1-syllable word -> fold 2 (weakest = off-grid dip first)
    grp = [G(0.0, 0.25), G(0.31, 0.45, "dip"), G(0.5, 0.75)]   # 0.31 is off-grid
    fused, st = fuse_asr_budget(grp, [{"start": 0.0, "end": 0.8, "syl": 1}], bpm=120)
    assert len(fused) == 1 and st["folded_by_asr"] == 2, (len(fused), st)
    assert len(fused[0]["segments"]) == 3, fused[0]
    # (h) never invent: 1 group in a 3-syllable word stays 1
    fused2, st2 = fuse_asr_budget([G(0.0, 0.5)], [{"start": 0.0, "end": 0.6, "syl": 3}], bpm=120)
    assert len(fused2) == 1 and st2["words_under"] == 1, st2
    # (i) outside any phrase span (last phrase extends +2.0s to own held tails) -> verbatim
    fused3, st3 = fuse_asr_budget([G(3.0, 3.3), G(3.5, 3.8)], [{"start": 0.0, "end": 0.6, "syl": 1}], bpm=120)
    assert len(fused3) == 2 and st3["unassigned_groups"] == 2, st3
    # (k) two words <0.4s apart pool into ONE phrase budget; a slot near the seam folds
    #     against the pooled budget instead of over-folding per word
    grp5 = [G(0.0, 0.2), G(0.28, 0.45, "dip"), G(0.5, 0.7)]
    fused5, st5 = fuse_asr_budget(grp5, [{"start": 0.0, "end": 0.3, "syl": 1},
                                         {"start": 0.45, "end": 0.7, "syl": 1}], bpm=120)
    assert st5["asr_phrases"] == 1 and len(fused5) == 2 and st5["folded_by_asr"] == 1, st5
    # (j) exact budget -> untouched
    fused4, st4 = fuse_asr_budget([G(0.0, 0.2), G(0.25, 0.5)], [{"start": 0.0, "end": 0.6, "syl": 2}], bpm=120)
    assert len(fused4) == 2 and st4["folded_by_asr"] == 0, st4
    return json.dumps((r, rp, rp2, rp3, rp4, gs, fused, fused2, fused3, fused4), sort_keys=True)


if __name__ == "__main__":
    import hashlib
    import sys
    if "--selftest" in sys.argv:
        digests = {hashlib.sha256(_selftest_once().encode()).hexdigest() for _ in range(3)}
        assert len(digests) == 1, "selftest not deterministic across 3 runs"
        print("segment_v2 selftest PASS (3x deterministic)")
    else:
        print(__doc__)
