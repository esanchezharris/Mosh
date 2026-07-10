#!/usr/bin/env python3
"""Build the rhythm template from the owner's TAPS (FMS reset, Stage 0 — human ground truth).

His taps are where he hears each syllable, offset by a roughly-constant reaction lag. We estimate
that lag against his own vocal (each tap → the steepest energy rise just before it = the real
attack), subtract it, and produce two click tracks over his take: his taps LAG-CORRECTED (his exact
feel) and GRID-SNAPPED (structured to the 16th grid). He judges by ear which lands.

  python3 scripts/fms-killshot/tap_template.py     (reads take-taps.json)
"""
import json
import math
import os
import statistics
import sys

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import template as tp
from skeleton import core as skcore

OUT = "/Users/emiliosanchez-harris/mosh-fms-ksb/resing-dominio"
LISTEN = os.path.join(OUT, "listen")
TAKE = os.path.join(LISTEN, "take-134-section-0-63s.wav")
BPM = 134.0
HOP = 0.01


def estimate_lag(taps, env, hop=HOP):
    """Median (tap − onset), where each onset is the steepest energy RISE in [tap−0.30, tap+0.03]
    — a person taps just after the attack, so the actual onset sits a roughly-constant lag earlier."""
    lags = []
    for t in taps:
        i0, i1 = max(0, int((t - 0.30) / hop)), min(len(env), int((t + 0.03) / hop))
        if i1 - i0 < 3:
            continue
        seg = env[i0:i1]
        diffs = [seg[k] - seg[k - 1] for k in range(1, len(seg))]
        onset_t = (i0 + diffs.index(max(diffs))) * hop
        lag = t - onset_t
        if 0.0 <= lag <= 0.35:
            lags.append(lag)
    return statistics.median(lags) if lags else 0.13


def lock_to_onsets(taps, onsets, back=0.28, ahead=0.07):
    """Snap each tap to its nearest detected transient — MONOTONIC (each onset used once, in tap
    order, so two taps never grab the same attack) and biased to onsets AT/BEFORE the tap (reaction
    lag). A tap with no transient in [t−back, t+ahead] falls back to a global-lag shift of the taps
    that DID lock, so the sung parts lock precisely and any undetected mumble still shifts sensibly."""
    onsets = sorted(onsets)
    out = [None] * len(taps)
    j = 0
    used = -1
    for i, t in enumerate(taps):
        best, bestd = None, 1e9
        k = used + 1
        while k < len(onsets) and onsets[k] <= t + ahead:
            if onsets[k] >= t - back:
                d = abs(onsets[k] - t)
                if d < bestd:
                    bestd, best = d, k
            k += 1
        if best is not None:
            out[i] = onsets[best]
            used = best
    locked_lags = [t - o for t, o in zip(taps, out) if o is not None]
    fallback = statistics.median(locked_lags) if locked_lags else 0.13
    matched = sum(1 for o in out if o is not None)
    return [round(o if o is not None else t - fallback, 4) for t, o in zip(taps, out)], matched, fallback


def _click(sr, freq, amp, ms=45):
    n = int(sr * ms / 1000)
    tt = np.arange(n) / sr
    return (amp * np.sin(2 * math.pi * freq * tt) * np.exp(-tt * 45)).astype(np.float32)


def _place(track, sr, at, c):
    i = int(at * sr)
    j = min(len(track), i + len(c))
    if j > i:
        track[i:j] += c[: j - i]


def _clicks_over(take, sr, onsets, strong_at=None):
    c = _click(sr, 1400, 0.5)
    cs = _click(sr, 1900, 0.6)
    out = np.zeros(len(take), np.float32)
    for i, t in enumerate(onsets):
        _place(out, sr, t, cs if (strong_at and strong_at[i]) else c)
    return out


def norm(x, p=0.9):
    m = float(np.abs(x).max())
    return x * (p / m) if m > 0 else x


def main():
    taps = json.load(open(os.path.join(OUT, "take-taps.json")))
    take, sr = sf.read(TAKE)
    if take.ndim > 1:
        take = take.mean(1)
    take = take.astype(np.float32)
    pcm = skcore.read_pcm_mono(TAKE)
    env = skcore.energy_envelope(pcm[0], pcm[1])

    onsets = json.load(open(os.path.join(OUT, "take-onsets.json")))
    locked, matched, fb = lock_to_onsets(taps, onsets)              # per-tap transient lock
    lag = estimate_lag(taps, env)
    corrected = [round(t - lag, 4) for t in taps]                   # blunt global shift (reference)
    print(f"{len(taps)} taps; {matched}/{len(taps)} locked to a transient; "
          f"fallback lag {fb*1000:.0f}ms; global lag {lag*1000:.0f}ms")

    # grid-snapped version of the ONSET-LOCKED onsets (structured to the 16th grid)
    anchors = [{"anchor": t, "origin": "real", "word": None} for t in locked]
    grid_tpl = tp.snap_anchors_to_grid(anchors, BPM, subdiv=4)
    grid_onsets = [s["onset"] for s in grid_tpl]
    strong = [s["stress"] == "strong" for s in grid_tpl]
    json.dump({"locked": locked, "matched": matched, "grid": grid_onsets, "corrected": corrected},
              open(os.path.join(OUT, "tap-template.json"), "w"), indent=1)

    take_n = norm(take, 0.8)
    sf.write(os.path.join(LISTEN, "tap-onset-clicks.wav"), norm(take_n + _clicks_over(take, sr, locked)), sr)
    sf.write(os.path.join(LISTEN, "tap-grid-clicks.wav"), norm(take_n + _clicks_over(take, sr, grid_onsets, strong)), sr)
    sf.write(os.path.join(LISTEN, "tap-corrected-clicks.wav"), norm(take_n + _clicks_over(take, sr, corrected)), sr)
    sf.write(os.path.join(LISTEN, "tap-raw-clicks.wav"), norm(take_n + _clicks_over(take, sr, taps)), sr)
    print("staged: tap-onset-clicks.wav (transient-locked), tap-grid-clicks.wav (+grid), "
          "tap-corrected-clicks.wav (global shift), tap-raw-clicks.wav (as tapped)")

    _html(len(taps), matched)
    return 0


def _html(ntaps, matched):
    html = f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Your taps → rhythm</title>
<style>:root{{color-scheme:dark}} body{{margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;background:#0e0f13;color:#e7e9ee}}
 .wrap{{max-width:680px;margin:0 auto;padding:34px 18px 80px}} h1{{font-size:21px;margin:0 0 4px}}
 .sub{{color:#8b90a0;font-size:13px;margin:0 0 22px}} .card{{background:#16181f;border:1px solid #23262f;border-radius:14px;padding:15px 17px;margin:0 0 13px}}
 .card.hot{{border-color:#2f5233}} .card h2{{font-size:15px;margin:0 0 3px}} .card p{{color:#8b90a0;font-size:12.5px;margin:0 0 10px}} audio{{width:100%}}</style>
</head><body><div class="wrap">
<h1>Your taps → rhythm ({ntaps} syllables)</h1>
<p class="sub">Rhythm from YOU + transient detection to lock the exact onset: {matched}/{ntaps} taps snapped to a real attack in your vocal (the rest use a gentle shift). Which lands?</p>
<div class="card hot"><h2>1 · Transient-locked (each tap → your real attack)</h2><p>Every tap snapped to its nearest detected onset in your vocal — not a blunt global shift. This should land dead-on.</p>
<audio controls preload="metadata" src="tap-onset-clicks.wav"></audio></div>
<div class="card hot"><h2>2 · Transient-locked + snapped to the 134 grid</h2><p>Same, then quantized to 16th notes — structured.</p>
<audio controls preload="metadata" src="tap-grid-clicks.wav"></audio></div>
<div class="card"><h2>Reference · blunt global shift (what felt too aggressive)</h2><audio controls preload="metadata" src="tap-corrected-clicks.wav"></audio></div>
<div class="card"><h2>Reference · exactly as tapped (no correction)</h2><audio controls preload="metadata" src="tap-raw-clicks.wav"></audio></div>
</div></body></html>"""
    open(os.path.join(LISTEN, "taps.html"), "w").write(html)
    print(f"viz -> {LISTEN}/taps.html")


if __name__ == "__main__":
    sys.exit(main())
