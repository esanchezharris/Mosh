#!/usr/bin/env python3
"""Consonant-EVIDENCE report — "words which don't sound like words", made checkable.

The owner hears missing sibilants (S-type consonants) in SoulX renders. Sibilance is
band-limited noise (S/Z ~4-10 kHz, SH/CH/JH ~2-8 kHz), so "commanded an S, produced no S
energy" is directly measurable. For every commanded sibilant-class phone this grades the
RENDER against the TAKE over the same window:

  missing      the take shows the sibilant's band energy there (the singer really made
               the sound) and the render does not
  present      the render shows it too
  unsupported  the take itself doesn't evidence it there (excluded from the headline —
               we never demand what the ground truth doesn't contain)

Windows lean 0.12 s BEFORE the note start (V4a: onset consonants land at/before the note
boundary). Strong tier S Z SH ZH CH JH is the headline; weak F TH reported only. Pure
cores (band ratio, event extraction, grading) are golden-tested on synthetic frames;
audio I/O is a thin wrapper. Plain python3 + numpy + soundfile (the bench contract).
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(REPO, "service"))

SR = 44100
N_FFT = 2048          # the viz instrument's STFT config — same time/freq resolution
HOP = 512
PRE_PAD_S = 0.12      # onset consonants live at/before the note boundary (V4a)
CAP_S = 0.35          # keep codas of normal notes in-window without eating the next word
TOTAL_BAND = (100.0, 12000.0)
BANDS = {"S": (4000.0, 10000.0), "Z": (4000.0, 10000.0),
         "SH": (2000.0, 8000.0), "ZH": (2000.0, 8000.0),
         "CH": (2000.0, 8000.0), "JH": (2000.0, 8000.0),
         "F": (2000.0, 10000.0), "TH": (2000.0, 10000.0)}
STRONG = {"S", "Z", "SH", "ZH", "CH", "JH"}
TAKE_FLOOR_MIN = 0.25     # the take must clear this to claim the sibilant was really sung
TAKE_FLOOR_MED_MULT = 2.0  # ... or 2x the song's median band ratio, whichever is larger
RENDER_FRAC = 0.5          # render clears if it reaches this fraction of the take's ratio


# ── pure cores ──────────────────────────────────────────────────────────────────────────
def note_phones(clip):
    """[(class, note_index)] for every sibilant-class phone commanded by a sung note.
    Phones ride notes as en_-prefixed dash-joined ARPAbet; stress digits are vowel-only,
    so consonant tokens match their class name exactly."""
    out = []
    types = [int(t) for t in clip["note_type"].split()]
    for k, tok in enumerate(clip["phoneme"].split()):
        if types[k] == 1:
            continue
        body = tok[3:] if tok.startswith("en_") else tok
        for p in body.split("-"):
            if p in BANDS:
                out.append((p, k))
    return out


def band_ratio_frames(spec_mags, freqs, band, total=TOTAL_BAND):
    """Per-frame E_band/E_total from |STFT| magnitudes [frames][bins]. Pure numpy-free
    math over lists is too slow for real audio, but the CORE contract (what counts as a
    ratio) is this arithmetic — tests feed tiny synthetic frames."""
    lo, hi = band
    tlo, thi = total
    out = []
    for row in spec_mags:
        eb = et = 0.0
        for f, m in zip(freqs, row):
            e = m * m
            if tlo <= f <= thi:
                et += e
                if lo <= f <= hi:
                    eb += e
        out.append(eb / et if et > 1e-12 else 0.0)
    return out


def p95(xs):
    if not xs:
        return 0.0
    s = sorted(xs)
    return s[min(len(s) - 1, int(round(0.95 * (len(s) - 1))))]


def grade(take_r, render_r, take_floor):
    """One event's verdict from the two p95 band ratios. The take is its own floor:
    we only demand from the render what the singer demonstrably produced."""
    if take_r < take_floor:
        return "unsupported"
    return "present" if render_r >= RENDER_FRAC * take_r else "missing"


def summarize(rows):
    strong = [r for r in rows if r["phone"] in STRONG and r["verdict"] != "unsupported"]
    missing = sum(1 for r in strong if r["verdict"] == "missing")
    return {"n_events": len(rows), "graded": len(strong), "missing": missing,
            "missing_frac": round(missing / len(strong), 3) if strong else None,
            "missing_words": sorted({f"{r['word']}({r['phone']})" for r in strong
                                     if r["verdict"] == "missing"})}


# ── audio side ──────────────────────────────────────────────────────────────────────────
def _stft_ratios(y, sr, band):
    import numpy as np
    if sr != SR:
        from soulx.perform import resample_hq
        y = np.asarray(resample_hq([float(v) for v in y], sr, SR))
        sr = SR
    win = np.hanning(N_FFT)
    n = max(0, (len(y) - N_FFT) // HOP + 1)
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / sr)
    lo, hi = band
    tlo, thi = TOTAL_BAND
    bsel = (freqs >= lo) & (freqs <= hi)
    tsel = (freqs >= tlo) & (freqs <= thi)
    out = []
    for k in range(n):
        seg = y[k * HOP:k * HOP + N_FFT] * win
        mag2 = np.abs(np.fft.rfft(seg)) ** 2
        et = float(mag2[tsel].sum())
        out.append(float(mag2[bsel].sum()) / et if et > 1e-12 else 0.0)
    return out


def analyze(render_wav, take_wav, clip, *, deps=None):
    """Per-event verdicts + summary. `deps` injects the ratio probe for tests."""
    import soundfile as sf

    def read(p):
        y, sr = sf.read(p)
        if getattr(y, "ndim", 1) > 1:
            y = y.mean(axis=1)
        return y, sr

    ratio_fn = (deps or {}).get("ratios")
    if ratio_fn is None:
        take_y, take_sr = read(take_wav)
        rend_y, rend_sr = read(render_wav)

        def ratio_fn(side, band):
            y, sr = (take_y, take_sr) if side == "take" else (rend_y, rend_sr)
            return _stft_ratios(y, sr, band)

    rows = []
    floors = {}
    for phone, k in note_phones(clip):
        band = BANDS[phone]
        key = band
        if key not in floors:
            tr_all = ratio_fn("take", band)
            med = sorted(tr_all)[len(tr_all) // 2] if tr_all else 0.0
            floors[key] = {"frames": {"take": tr_all, "render": ratio_fn("render", band)},
                           "floor": max(TAKE_FLOOR_MIN, TAKE_FLOOR_MED_MULT * med)}
        fr = floors[key]
        start = _note_start(clip, k)
        dur = float(clip["duration"].split()[k])
        a, b = max(0.0, start - PRE_PAD_S), start + min(dur, CAP_S)
        i0, i1 = int(a * SR / HOP), max(int(b * SR / HOP), int(a * SR / HOP) + 1)
        t_r = p95(fr["frames"]["take"][i0:i1])
        r_r = p95(fr["frames"]["render"][i0:i1])
        word = clip["text"].split()[k]
        rows.append({"word": word, "phone": phone, "t": round(start, 3),
                     "take_ratio": round(t_r, 3), "render_ratio": round(r_r, 3),
                     "verdict": grade(t_r, r_r, fr["floor"])})
    return {"events": rows, "summary": summarize(rows)}


def _note_start(clip, k):
    durs = [float(d) for d in clip["duration"].split()]
    return round(sum(durs[:k]), 4)


def print_report(song, rep):
    s = rep["summary"]
    print(f"\n== {song} ==  sibilant events {s['n_events']} | graded {s['graded']} | "
          f"MISSING {s['missing']}" +
          (f" ({s['missing_frac']:.0%})" if s["missing_frac"] is not None else ""))
    for r in rep["events"]:
        mark = {"missing": "✗", "present": "·", "unsupported": " "}[r["verdict"]]
        print(f"  {mark} {r['t']:6.2f}s {r['word']:14s} {r['phone']:2s} "
              f"take={r['take_ratio']:.2f} render={r['render_ratio']:.2f} {r['verdict']}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True, help="own_run.json of a round")
    ap.add_argument("--arm", default="pipeline",
                    help="render arm (RAW pipeline = score-clock-exact by default)")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    rows = json.load(open(a.run))
    base = os.path.dirname(os.path.abspath(a.run))
    out = {}
    for r in rows:
        song = r["item"].replace("own-", "")
        arms = r.get("arms", {})
        if a.arm not in arms or "reference" not in arms:
            continue
        clip = None
        for f in sorted(os.listdir(base)):
            if f.startswith(song) and f.endswith("_pipeline_score.json"):
                sc = json.load(open(os.path.join(base, f)))
                clip = sc[0] if isinstance(sc, list) else sc
        if clip is None:
            continue
        rep = analyze(arms[a.arm]["wav"], arms["reference"]["wav"], clip)
        out[song] = rep
        print_report(song, rep)
    if a.out:
        json.dump(out, open(a.out, "w"), indent=1, sort_keys=True)
        print(f"\nwrote {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
