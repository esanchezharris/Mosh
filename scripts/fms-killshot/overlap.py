#!/usr/bin/env python3
"""Overlap/alignment QA: how much does a sung render agree with the original take?

The owner's "bare minimum" gate (2026-07-04): every sung render must be OVERLAPPED
against the take it came from — ear artifact + numbers — so chain weirdness (register
shifts, timing slop, wrong words) is caught by measurement, not vibes.

Artifacts per run (into --out):
  overlay.wav   stereo: L = original take, R = render (resampled to the take's rate,
                peak-normalized) — the listening artifact.
  overlap.json  metrics: global lag, onset agreement (precision/recall/F1), F0 register
                delta in semitones (+ octave_error_rate — the --auto_shift fingerprint),
                per-phrase lags, silence/energy leakage, optional ASR word-match of the
                RENDER against the score's own words.

Pure list-based cores live at the top (stdlib only — promotable to service/soulx later,
the segment_v2 -> skeleton/core discipline). Venv plumbing reuses diagnose.py.

Usage:
  overlap.py --original take.wav --render sung.wav [--score target_score.json]
             --out outdir [--runs 2] [--no-f0] [--no-asr] [--whisper-model small]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import struct
import sys
import tempfile
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import diagnose                      # noqa: E402  (venv plumbing: _venv_python/_to_wav/_run_json)
from skeleton import core as skcore  # noqa: E402  (energy_envelope, read_pcm_mono)

HOP_S = skcore.HOP_MS / 1000.0


# ── pure cores (lists in, dicts out) ───────────────────────────────────────────────────

def resample_linear(mono, sr_from: int, sr_to: int):
    """QA-grade linear-interp resampler (the repo has none; SoulX emits 24k, takes 44.1k)."""
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


def _pctl(sv, p):
    if not sv:
        return 0.0
    return sv[min(len(sv) - 1, max(0, int(round(p / 100.0 * (len(sv) - 1)))))]


def _gate_thresholds(env):
    sv = sorted(env)
    th_hi = max(4.0 * _pctl(sv, 5), 0.15 * _pctl(sv, 95))
    if th_hi <= 0.0:
        # Degenerate (silent) signal: a zero threshold would read EVERY frame as open
        # (>= 0) and invert the leakage verdicts — treat silence as all-CLOSED instead.
        return float("inf"), float("inf")
    return th_hi, 0.5 * th_hi


def onset_times(env, hop_s: float = HOP_S, min_sep_s: float = 0.06):
    """Adaptive-gate rise onsets over an RMS envelope (closed->open crossings)."""
    if not env:
        return []
    th_hi, th_lo = _gate_thresholds(env)
    onsets, is_open, last = [], False, -1e9
    for i, e in enumerate(env):
        if not is_open and e >= th_hi:
            t = i * hop_s
            if t - last >= min_sep_s:
                onsets.append(round(t, 4))
                last = t
            is_open = True
        elif is_open and e < th_lo:
            is_open = False
    return onsets


def onset_agreement(a, b, tol_s: float = 0.05, lag_s: float = 0.0) -> dict:
    """OPTIMAL one-to-one matching of render onsets b (shifted by -lag_s) against take
    onsets a. Both lists are time-sorted, so the maximum matching is non-crossing —
    an LCS-style DP (greedy nearest-match understates F1; review find)."""
    b_adj = [t - lag_s for t in b]
    n, m = len(a), len(b_adj)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            hit = 1 if abs(a[i - 1] - b_adj[j - 1]) <= tol_s else 0
            dp[i][j] = max(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1] + hit)
    matched = dp[n][m]
    # traceback for the matched |dt| distribution
    dts, i, j = [], n, m
    while i > 0 and j > 0:
        hit = 1 if abs(a[i - 1] - b_adj[j - 1]) <= tol_s else 0
        if dp[i][j] == dp[i - 1][j - 1] + hit and hit:
            dts.append(abs(a[i - 1] - b_adj[j - 1]))
            i, j = i - 1, j - 1
        elif dp[i][j] == dp[i - 1][j]:
            i -= 1
        elif dp[i][j] == dp[i][j - 1]:
            j -= 1
        else:
            i, j = i - 1, j - 1
    precision = matched / m if m else 0.0
    recall = matched / n if n else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall > 0 else 0.0
    dts.sort()
    return {"take_onsets": n, "render_onsets": m, "matched": matched,
            "precision": round(precision, 3), "recall": round(recall, 3), "f1": round(f1, 3),
            "median_abs_dt_ms": round(1000 * dts[len(dts) // 2], 1) if dts else None,
            "tol_ms": round(tol_s * 1000)}


def global_lag(env_a, env_b, hop_s: float = HOP_S, max_lag_s: float = 0.5) -> float:
    """Envelope cross-correlation lag (seconds; positive = render LATE vs the take)."""
    n = min(len(env_a), len(env_b))
    if n < 10:
        return 0.0
    a, b = env_a[:n], env_b[:n]
    ma, mb = sum(a) / n, sum(b) / n
    a = [x - ma for x in a]
    b = [x - mb for x in b]
    if all(x == 0.0 for x in a) or all(x == 0.0 for x in b):
        return 0.0               # flat/silent window: no correlation evidence — no lag
    max_k = min(n - 1, int(max_lag_s / hop_s))
    best_k, best_r = 0, -1e18
    # Nearest-zero lags first with STRICT improvement, so correlation ties (quasi-flat
    # windows) resolve to 0 instead of the extreme lag (review find).
    for k in sorted(range(-max_k, max_k + 1), key=abs):
        s = 0.0
        if k >= 0:                       # compare a[i] with b[i-k]
            for i in range(k, n):
                s += a[i] * b[i - k]
        else:
            for i in range(-k, n):
                s += a[i + k] * b[i]
        if s > best_r:
            best_r, best_k = s, k
    # In this indexing, positive k means the render LEADS; negate so the reported
    # convention is positive = render LATE vs the take.
    return round(-best_k * hop_s, 4)


def f0_compare(f0_a, f0_b, hop_s: float = 0.01) -> dict:
    """Voiced-frame register comparison over FCPE [{t,hz}] lists (both are the SAME
    voice, so Δsemitones ≈ register/transposition error). octave_error_rate is the
    --auto_shift fingerprint: fraction of matched frames off by ~±1 octave."""
    def to_map(f0):
        m = {}
        for p in f0 or []:
            hz = float(p.get("hz", 0) or 0)
            if hz > 0:
                m[int(round(float(p["t"]) / hop_s))] = hz
        return m
    ma, mb = to_map(f0_a), to_map(f0_b)
    ds = []
    for k, hz_a in ma.items():
        hz_b = mb.get(k)
        if hz_b:
            ds.append(12.0 * math.log2(hz_b / hz_a))
    if not ds:
        return {"voiced_matched": 0}
    ds.sort()
    n = len(ds)
    med = ds[n // 2]
    mean_a = sum(ds) / n
    var_ab = sum((d - mean_a) ** 2 for d in ds) / n
    return {"voiced_matched": n,
            "median_dsemitones": round(med, 2),
            "abs_median_st": round(abs(med), 2),
            "spread_st": round(math.sqrt(var_ab), 2),
            "octave_error_rate": round(sum(1 for d in ds if 11.0 <= abs(d) <= 13.0) / n, 3)}


def phrase_windows_from_score(clip: dict, rest_split_s: float = 0.35):
    """Score event chain -> [(start, end, n_word_events), ...] phrase windows (split at
    rests >= rest_split_s). Chain times are take-relative by construction (4dp diffusion)."""
    durs = [float(d) for d in clip["duration"].split()]
    types = [int(t) for t in clip["note_type"].split()]
    wins, t, cur = [], 0.0, None
    for d, nt in zip(durs, types):
        if nt == 1:
            if cur and d >= rest_split_s:
                wins.append(cur)
                cur = None
        else:
            if cur is None:
                cur = [t, t + d, 1 if nt == 2 else 0]
            else:
                cur[1] = t + d
                cur[2] += 1 if nt == 2 else 0
        t += d
    if cur:
        wins.append(cur)
    return [(round(a, 3), round(b, 3), n) for a, b, n in wins]


def window_lag(env_a, env_b, a: float, b: float, hop_s: float = HOP_S,
               max_lag_s: float = 0.15) -> float:
    lo, hi = max(0, int(a / hop_s)), int(b / hop_s)
    return global_lag(env_a[lo:hi], env_b[lo:hi], hop_s, max_lag_s)


def silence_energy(env_a, env_b) -> dict:
    """Energy leakage: how much of the render is LOUD where the take is silent (invented
    audio / shifted rests) and vice versa (dropped audio)."""
    n = min(len(env_a), len(env_b))
    if n == 0:
        return {}
    tha, _ = _gate_thresholds(env_a[:n])
    thb, _ = _gate_thresholds(env_b[:n])
    r_in_a_sil = sum(1 for i in range(n) if env_b[i] >= thb and env_a[i] < tha)
    a_in_r_sil = sum(1 for i in range(n) if env_a[i] >= tha and env_b[i] < thb)
    open_b = max(1, sum(1 for i in range(n) if env_b[i] >= thb))
    open_a = max(1, sum(1 for i in range(n) if env_a[i] >= tha))
    return {"render_in_take_silence_pct": round(100.0 * r_in_a_sil / open_b, 1),
            "take_in_render_silence_pct": round(100.0 * a_in_r_sil / open_a, 1)}


def score_events(clip: dict):
    """Score chain -> [(start_s, dur_s, midi_pitch, note_type), ...] absolute-timed
    sung events (types 2/3; rests excluded). Times come from the 4dp error-diffused
    duration chain, so they are take-aligned by construction."""
    durs = [float(d) for d in clip["duration"].split()]
    pitches = [int(p) for p in clip["note_pitch"].split()]
    types = [int(t) for t in clip["note_type"].split()]
    out, t = [], 0.0
    for d, p, nt in zip(durs, pitches, types):
        if nt in (2, 3) and p > 0 and d > 0:
            out.append((round(t, 4), round(d, 4), p, nt))
        t += d
    return out


def score_conformance(clip: dict, f0, onsets=None, tol_s: float = 0.05,
                      lag_s: float = 0.0) -> dict:
    """Does an audio signal SING WHAT THE SCORE SAYS? One function, two attribution
    rows: fed the TAKE's F0/onsets it measures score-authoring error ("was the score's
    melody even right about the take?"); fed the RENDER's it measures the model's
    conformance ("did SoulX sing what it was told?").

    Per sung event: the F0 median over its (lag-shifted) span vs its `note_pitch` ->
    Δ semitones. Reports median |Δ|, % within 0.5/1.0 st, and (when onsets are given)
    onset agreement of word-event starts vs the observed onsets."""
    events = score_events(clip)
    per = []
    f0_pts = sorted(({"t": float(p["t"]), "hz": float(p.get("hz", 0) or 0)}
                     for p in f0 or [] if float(p.get("hz", 0) or 0) > 0),
                    key=lambda p: p["t"])
    for (t, d, pitch, nt) in events:
        a, b = t + lag_s, t + d + lag_s
        hz = [p["hz"] for p in f0_pts if a <= p["t"] < b]
        if not hz:
            continue
        hz.sort()
        med = hz[len(hz) // 2]
        d_st = 12.0 * math.log2(med / (440.0 * (2.0 ** ((pitch - 69) / 12.0))))
        per.append({"t": t, "pitch": pitch, "type": nt, "d_st": round(d_st, 2)})
    ds = sorted(abs(e["d_st"]) for e in per)
    out = {"events": len(events), "voiced_events": len(per),
           "pitch_abs_median_st": round(ds[len(ds) // 2], 2) if ds else None,
           "pitch_within_half_st": round(sum(1 for d in ds if d <= 0.5) / len(ds), 3) if ds else None,
           "pitch_within_1_st": round(sum(1 for d in ds if d <= 1.0) / len(ds), 3) if ds else None}
    if onsets is not None:
        # lag_s maps score time -> observed time (observed = score + lag), and
        # onset_agreement shifts its b-list by -lag_s, bringing observed onsets back
        # onto the score timeline — so the sign passes straight through.
        word_starts = [t for (t, d, p, nt) in events if nt == 2]
        out["onsets"] = onset_agreement(word_starts, onsets, tol_s=tol_s, lag_s=lag_s)
    return out


def word_match(score_words, asr_words) -> dict:
    """Did the render sing the score's words? Sequence similarity + bag coverage."""
    import difflib

    def _norm(w):
        # Whisper emits U+2019 apostrophes; scores carry ASCII — normalize INTERNAL
        # punctuation variants too, not just edges (review find).
        return w.lower().replace("’", "'").replace("-", "").strip(".,!?'\"")

    sw = [_norm(w) for w in score_words if any(c.isalpha() for c in w)]
    aw = [_norm(w) for w in asr_words if any(c.isalpha() for c in w)]
    ratio = difflib.SequenceMatcher(a=sw, b=aw).ratio() if sw and aw else 0.0
    bag = sum(1 for w in set(sw) if w in set(aw)) / len(set(sw)) if sw else 0.0
    return {"score_words": len(sw), "render_words": len(aw),
            "seq_ratio": round(ratio, 3), "bag_coverage": round(bag, 3)}


# ── I/O + CLI ──────────────────────────────────────────────────────────────────────────

def _read_mono(path: str, td: str):
    wav = diagnose._to_wav(os.path.abspath(path), td)
    r = skcore.read_pcm_mono(wav)
    if not r:
        mono, sr = diagnose._read_wav_mono(wav)
        return mono, sr, wav
    return r[0], r[1], wav


def _write_overlay(orig, sr_o, rend, sr_r, out_path):
    r441 = resample_linear(rend, sr_r, sr_o)
    def norm(x):
        pk = max((abs(v) for v in x), default=1.0) or 1.0
        return [0.9 * v / pk for v in x]
    L, R = norm(orig), norm(r441)
    n = max(len(L), len(R))
    with wave.open(out_path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr_o)
        frames = bytearray()
        for i in range(n):
            l = L[i] if i < len(L) else 0.0
            r = R[i] if i < len(R) else 0.0
            frames += struct.pack("<hh", int(max(-32767, min(32767, l * 32767))),
                                  int(max(-32767, min(32767, r * 32767))))
        w.writeframes(bytes(frames))


def analyze(orig_mono, sr_o, rend_mono, sr_r, f0_o=None, f0_r=None, score_clip=None) -> dict:
    env_o = skcore.energy_envelope(orig_mono, sr_o)
    env_r = skcore.energy_envelope(rend_mono, sr_r)
    lag = global_lag(env_o, env_r)
    on_o, on_r = onset_times(env_o), onset_times(env_r)
    out = {"v": 1,
           "sr": {"original": sr_o, "render": sr_r},
           "duration_s": {"original": round(len(orig_mono) / sr_o, 2),
                          "render": round(len(rend_mono) / sr_r, 2)},
           "global_lag_ms": round(lag * 1000, 1),
           "onsets": onset_agreement(on_o, on_r, lag_s=lag),
           "energy": silence_energy(env_o, env_r)}
    if f0_o is not None and f0_r is not None:
        out["f0"] = f0_compare(f0_o, f0_r)
    if score_clip:
        wins = phrase_windows_from_score(score_clip)
        out["phrases"] = [{"window": [a, b], "words": nw,
                           "lag_ms": round(window_lag(env_o, env_r, a, b) * 1000, 1),
                           "take_onsets": sum(1 for t in on_o if a <= t < b),
                           "render_onsets": sum(1 for t in on_r if a <= t < b)}
                          for a, b, nw in wins]
    return out


# ── selftest (synthetic, 3x deterministic — the segment_v2 --selftest convention) ──────

def _selftest_once() -> str:
    sr = 8000

    def tone(hz, dur_s, amp=0.5, sr_=sr):
        n = int(dur_s * sr_)
        return [amp * math.sin(2 * math.pi * hz * i / sr_) for i in range(n)]

    sig = [0.0] * int(0.1 * sr) + tone(220, 0.3) + [0.0] * int(0.2 * sr) + tone(330, 0.3) + [0.0] * int(0.1 * sr)
    env = skcore.energy_envelope(sig, sr)

    # onsets land at the two burst starts (±30 ms: the RMS window reads ~2 hops early —
    # a CONSISTENT bias, identical for take and render, so agreement metrics are unbiased)
    ons = onset_times(env)
    assert len(ons) == 2 and abs(ons[0] - 0.1) < 0.03 and abs(ons[1] - 0.6) < 0.03, ons

    # identity agreement is perfect; a 120 ms shift is found by global_lag and forgiven by it
    ag = onset_agreement(ons, ons)
    assert ag["f1"] == 1.0 and ag["median_abs_dt_ms"] == 0.0, ag
    shifted = [0.0] * int(0.12 * sr) + sig
    env_s = skcore.energy_envelope(shifted, sr)
    lag = global_lag(env, env_s)
    assert abs(lag - 0.12) <= 0.02, lag
    ag2 = onset_agreement(ons, onset_times(env_s), lag_s=lag)
    assert ag2["f1"] == 1.0, ag2
    ag3 = onset_agreement(ons, onset_times(env_s), lag_s=0.0)
    assert ag3["f1"] == 0.0, ag3   # without the lag, nothing matches at 50 ms tol

    # resampler: doubles the length (±1), preserves a ramp
    ramp = [i / 100.0 for i in range(100)]
    up = resample_linear(ramp, 8000, 16000)
    assert abs(len(up) - 200) <= 1 and abs(up[-1] - ramp[-1]) < 1e-6, len(up)

    # f0_compare: same register -> 0 st; octave up -> +12 with octave_error_rate 1.0
    fa = [{"t": i * 0.01, "hz": 220.0} for i in range(50)]
    fb = [{"t": i * 0.01, "hz": 440.0} for i in range(50)]
    same = f0_compare(fa, fa)
    assert same["median_dsemitones"] == 0.0 and same["octave_error_rate"] == 0.0, same
    oct_up = f0_compare(fa, fb)
    assert oct_up["median_dsemitones"] == 12.0 and oct_up["octave_error_rate"] == 1.0, oct_up

    # silence_energy: a tone injected into the take's silent mid-gap -> leakage detected
    leaky = list(sig)
    gap_tone = tone(262, 0.15)
    lo = int(0.42 * sr)
    leaky[lo:lo + len(gap_tone)] = gap_tone
    leak = silence_energy(env, skcore.energy_envelope(leaky, sr))
    assert leak["render_in_take_silence_pct"] > 0, leak
    # degenerate gate: an all-silent take must read all-CLOSED (not all-open — the
    # inverted verdict a zero threshold produced; review fix)
    env_silent = skcore.energy_envelope([0.0] * len(sig), sr)
    leak2 = silence_energy(env_silent, env)
    assert leak2["render_in_take_silence_pct"] == 100.0 \
        and leak2["take_in_render_silence_pct"] == 0.0, leak2
    # flat window: cross-correlation ties resolve to lag 0, never the extreme (review fix)
    assert global_lag(env_silent, env) == 0.0

    # phrase windows from a score chain: two phrases split at the 0.5 s rest
    clip = {"duration": "0.10 0.30 0.50 0.30 0.10", "note_type": "1 2 1 2 1",
            "note_pitch": "0 57 0 60 0", "text": "<SP> hold <SP> flame <SP>"}
    wins = phrase_windows_from_score(clip)
    assert len(wins) == 2 and wins[0][2] == 1 and wins[1][2] == 1, wins

    # word match: exact sequence -> 1.0; disjoint -> 0.0 coverage
    wm = word_match(["hold", "the", "flame"], ["hold", "the", "flame"])
    assert wm["seq_ratio"] == 1.0 and wm["bag_coverage"] == 1.0, wm
    wm2 = word_match(["hold", "the", "flame"], ["stay", "up"])
    assert wm2["bag_coverage"] == 0.0, wm2

    # score_conformance: an F0 that sings EXACTLY the score's notes -> 0 st error,
    # perfect within-half; a contour a whole step sharp on one event shows up per-event.
    sc_clip = {"duration": "0.50 0.5000 0.5000 0.5000", "note_pitch": "0 57 60 62",
               "note_type": "1 2 2 3", "text": "<SP> hold flame flame"}
    def midi_hz_(p):
        return 440.0 * (2.0 ** ((p - 69) / 12.0))
    f0_exact = ([{"t": 0.5 + i * 0.01, "hz": midi_hz_(57)} for i in range(50)]
                + [{"t": 1.0 + i * 0.01, "hz": midi_hz_(60)} for i in range(50)]
                + [{"t": 1.5 + i * 0.01, "hz": midi_hz_(62)} for i in range(50)])
    conf = score_conformance(sc_clip, f0_exact, onsets=[0.5, 1.0])
    assert conf["pitch_abs_median_st"] == 0.0 and conf["pitch_within_half_st"] == 1.0, conf
    assert conf["onsets"]["f1"] == 1.0, conf["onsets"]
    f0_sharp = ([{"t": 0.5 + i * 0.01, "hz": midi_hz_(59)} for i in range(50)]   # +2 st on event 1
                + [{"t": 1.0 + i * 0.01, "hz": midi_hz_(60)} for i in range(50)]
                + [{"t": 1.5 + i * 0.01, "hz": midi_hz_(62)} for i in range(50)])
    conf2 = score_conformance(sc_clip, f0_sharp)
    assert conf2["pitch_within_half_st"] == round(2 / 3, 3), conf2
    # a lagged signal is forgiven when the lag is passed in
    f0_late = [{"t": p["t"] + 0.12, "hz": p["hz"]} for p in f0_exact]
    conf3 = score_conformance(sc_clip, f0_late, onsets=[0.62, 1.12], lag_s=0.12)
    assert conf3["pitch_abs_median_st"] == 0.0 and conf3["onsets"]["f1"] == 1.0, conf3

    rep = analyze(sig, sr, shifted, sr, fa, fa, clip)
    return json.dumps(rep, sort_keys=True)


def main() -> int:
    if "--selftest" in sys.argv:
        digests = {hashlib.sha256(_selftest_once().encode()).hexdigest() for _ in range(3)}
        assert len(digests) == 1, "overlap selftest not deterministic across 3 runs"
        print("overlap selftest PASS (3x deterministic)")
        return 0
    ap = argparse.ArgumentParser()
    ap.add_argument("--original", required=True)
    ap.add_argument("--render", required=True)
    ap.add_argument("--score", help="target_score.json (phrase windows + word match)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--no-f0", action="store_true")
    ap.add_argument("--no-asr", action="store_true")
    ap.add_argument("--whisper-model", default="small")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    with tempfile.TemporaryDirectory() as td:
        # SEPARATE decode dirs: diagnose._to_wav always writes <dir>/input-decoded.wav,
        # so two non-PCM inputs sharing one dir would silently analyze the same audio
        # twice (review find — identity metrics on different files).
        td_o = os.path.join(td, "orig")
        td_r = os.path.join(td, "rend")
        os.makedirs(td_o)
        os.makedirs(td_r)
        orig, sr_o, orig_wav = _read_mono(args.original, td_o)
        rend, sr_r, rend_wav = _read_mono(args.render, td_r)

        score_clip = None
        if args.score:
            doc = json.load(open(args.score))
            score_clip = doc[0] if isinstance(doc, list) else doc

        sk_py = None if args.no_f0 else diagnose._venv_python("skeleton/.skeleton.env", "SKELETON_PY")
        cli = os.path.join(REPO, "service/skeleton/skeleton_cli.py")
        digests = []
        report = None
        f0_o = f0_r = None
        # --runs N re-runs the MODEL subprocesses too (diagnose.py's semantics —
        # a determinism flag over cached inputs would be tautological; review find).
        for _ in range(max(1, args.runs)):
            if sk_py:
                ra = diagnose._run_json(sk_py, cli, orig_wav)
                rb = diagnose._run_json(sk_py, cli, rend_wav)
                f0_o = ra.get("f0") if ra.get("ok") else None
                f0_r = rb.get("f0") if rb.get("ok") else None
            report = analyze(orig, sr_o, rend, sr_r, f0_o, f0_r, score_clip)
            digests.append(hashlib.sha256(json.dumps(report, sort_keys=True).encode()).hexdigest())
        report["deterministic"] = len(set(digests)) == 1

        if score_clip and not args.no_asr:
            wp = diagnose._venv_python("whisper/.whisper.env", "WHISPER_PY")
            if wp:
                cli = os.path.join(REPO, "service/whisper/whisper_cli.py")
                res = diagnose._run_json(wp, cli, rend_wav, args.whisper_model)
                if res.get("ok"):
                    sw = [w for w, t in zip(score_clip["text"].split(),
                                            score_clip["note_type"].split()) if t == "2"]
                    aw = [w.get("word", "").strip() for w in res.get("words", [])]
                    report["asr_check"] = word_match(sw, aw)

        _write_overlay(orig, sr_o, rend, sr_r, os.path.join(args.out, "overlay.wav"))
        with open(os.path.join(args.out, "overlap.json"), "w") as f:
            json.dump(report, f, indent=1, sort_keys=True)
        print(json.dumps(report, indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
