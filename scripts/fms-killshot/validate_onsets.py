#!/usr/bin/env python3
"""Validate syllable-onset detection on KNOWN ground truth (FMS Stage 0).

Scientific de-risk: prove the onset detector is CORRECT on a clean acapella of a known song
before trusting it on the mumble. Ground truth = the KNOWN "I'm Going Down" lyrics forced-aligned
to the clean excerpt (reliable on clear singing). Each detector is scored against it with the
existing onset-F1 metric (overlap.onset_agreement, optimal non-crossing DP), and a click track per
detector is staged so the owner ear-confirms on the clean take.

Inputs pre-computed on-Mac (owner-gated venvs):
  calibrate-onsets/aligned.json  — forced-aligned known words (skeleton venv, align.align_words)
  calibrate-onsets/librosa.json  — librosa transients (sketch venv)
This driver (base python) builds the GT, runs the energy-gate detector, scores everything, and
stages click tracks + an F1 table. Pure GT expansion is golden-tested in validate_onsets_test.py.
"""
import json
import math
import os
import sys

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import overlap
from skeleton import align, core as skcore
from phonology import core as ph

CAL = "/Users/emiliosanchez-harris/mosh-fms-ksb/calibrate"
GT = "/Users/emiliosanchez-harris/mosh-fms-ksb/calibrate-onsets"
LISTEN = "/Users/emiliosanchez-harris/mosh-fms-ksb/resing-dominio/listen"
EXC = os.path.join(CAL, "excerpt.wav")
_pron = ph.Pronouncer()


def syllable_gt_onsets(aligned, pron=None):
    """Forced-aligned words → per-SYLLABLE onset ground truth: each word's span split into its
    phonology-syllable count of contiguous slots (align.slots_for_word), keeping the slot starts.
    Pure + deterministic."""
    pron = pron or _pron

    def syl(w):
        c = "".join(ch for ch in w.lower() if ch.isalpha() or ch == "'")
        return max(1, pron.syllables(c) or 1) if c else 1

    out = []
    for w in aligned:
        for s in align.slots_for_word(float(w["start"]), float(w["end"]), syl(w["word"])):
            out.append(round(float(s["start"]), 4))
    return sorted(out)


def _click(sr, freq, amp, ms=45):
    n = int(sr * ms / 1000)
    t = np.arange(n) / sr
    return (amp * np.sin(2 * math.pi * freq * t) * np.exp(-t * 45)).astype(np.float32)


def _clicks(take, sr, onsets, freq=1500, amp=0.55):
    c = _click(sr, freq, amp)
    out = np.zeros(len(take), np.float32)
    for t in onsets:
        i = int(t * sr)
        j = min(len(out), i + len(c))
        if j > i:
            out[i:j] += c[: j - i]
    return out


def _norm(x, p=0.9):
    m = float(np.abs(x).max())
    return x * (p / m) if m > 0 else x


def main():
    aligned = json.load(open(os.path.join(GT, "aligned.json")))
    librosa_on = json.load(open(os.path.join(GT, "librosa.json")))
    take, sr = sf.read(EXC)
    if take.ndim > 1:
        take = take.mean(1)
    take = take.astype(np.float32)
    pcm = skcore.read_pcm_mono(EXC)
    env = skcore.energy_envelope(pcm[0], pcm[1])

    word_gt = sorted(round(float(w["start"]), 4) for w in aligned)        # reliable word onsets
    syl_gt = syllable_gt_onsets(aligned)                                  # + interpolated syllables
    energy_on = overlap.onset_times(env, hop_s=0.01, min_sep_s=0.08)      # energy-gate detector

    detectors = {"librosa": librosa_on, "energy-gate": energy_on}
    refs = {"word-GT": word_gt, "syllable-GT": syl_gt}
    print(f"GT: {len(word_gt)} words, {len(syl_gt)} syllables | detectors: "
          f"librosa {len(librosa_on)}, energy-gate {len(energy_on)}\n")

    print(f"{'detector':<14}{'vs':<14}{'F1':>6}{'prec':>7}{'rec':>7}{'Δms':>7}{'  (lag-corrected)':>20}")
    results = {}
    for dname, det in detectors.items():
        for rname, ref in refs.items():
            r = overlap.onset_agreement(ref, det, tol_s=0.05)
            lag = overlap.global_lag(env, env)  # same clip → 0; kept for the mumble extension
            rl = overlap.onset_agreement(ref, det, tol_s=0.05, lag_s=lag)
            results[f"{dname}|{rname}"] = r
            print(f"{dname:<14}{rname:<14}{r['f1']:>6}{r['precision']:>7}{r['recall']:>7}"
                  f"{str(r['median_abs_dt_ms']):>7}{rl['f1']:>20}")

    # click tracks over the excerpt for the owner's ear
    tn = _norm(take, 0.8)
    sf.write(os.path.join(LISTEN, "val-gt-words.wav"), _norm(tn + _clicks(take, sr, word_gt, 1900, 0.55)), sr)
    sf.write(os.path.join(LISTEN, "val-librosa.wav"), _norm(tn + _clicks(take, sr, librosa_on, 1400, 0.5)), sr)
    sf.write(os.path.join(LISTEN, "val-energy.wav"), _norm(tn + _clicks(take, sr, energy_on, 1100, 0.5)), sr)
    print("\nstaged: val-gt-words.wav (forced-align truth), val-librosa.wav, val-energy.wav")
    _html(results, len(word_gt), len(syl_gt), len(librosa_on), len(energy_on))
    json.dump({"word_gt": word_gt, "syl_gt": syl_gt, "librosa": librosa_on, "energy": energy_on,
               "results": results}, open(os.path.join(GT, "validation.json"), "w"), indent=1)
    return 0


def _html(results, nw, ns, nl, ne):
    def row(d, r):
        x = results[f"{d}|{r}"]
        return f"<tr><td>{d}</td><td>{r}</td><td><b>{x['f1']}</b></td><td>{x['precision']}</td><td>{x['recall']}</td><td>{x['median_abs_dt_ms']}</td></tr>"
    rows = "".join(row(d, r) for d in ("librosa", "energy-gate") for r in ("word-GT", "syllable-GT"))
    html = f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Onset validation on known truth</title><style>:root{{color-scheme:dark}}
 body{{margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;background:#0e0f13;color:#e7e9ee}}
 .wrap{{max-width:680px;margin:0 auto;padding:34px 18px 80px}} h1{{font-size:21px;margin:0 0 4px}}
 .sub{{color:#8b90a0;font-size:13px;margin:0 0 20px}} .card{{background:#16181f;border:1px solid #23262f;border-radius:14px;padding:15px 17px;margin:0 0 13px}}
 .card.hot{{border-color:#2f5233}} .card h2{{font-size:15px;margin:0 0 3px}} .card p{{color:#8b90a0;font-size:12.5px;margin:0 0 10px}} audio{{width:100%}}
 table{{width:100%;border-collapse:collapse;font-size:13px}} td,th{{text-align:left;padding:5px 8px;border-bottom:1px solid #23262f}} th{{color:#8b90a0}}</style>
</head><body><div class="wrap">
<h1>Onset validation — "I'm Going Down" (known truth)</h1>
<p class="sub">Does automatic transient detection find the syllables where we KNOW they are? Ground truth = your known lyrics forced-aligned ({nw} words / {ns} syllables). Detectors: librosa {nl}, energy-gate {ne}. F1 ≥ 0.8 = trusted.</p>
<div class="card"><table><tr><th>detector</th><th>vs</th><th>F1</th><th>prec</th><th>rec</th><th>med Δms</th></tr>{rows}</table></div>
<div class="card hot"><h2>Ground truth · forced-aligned words</h2><p>Clicks where the known words start. Do these land on your syllables?</p><audio controls preload="metadata" src="val-gt-words.wav"></audio></div>
<div class="card hot"><h2>librosa transients</h2><p>The automatic detector.</p><audio controls preload="metadata" src="val-librosa.wav"></audio></div>
<div class="card"><h2>energy-gate</h2><audio controls preload="metadata" src="val-energy.wav"></audio></div>
</div></body></html>"""
    open(os.path.join(LISTEN, "validate.html"), "w").write(html)
    print(f"viz -> {LISTEN}/validate.html")


if __name__ == "__main__":
    sys.exit(main())
