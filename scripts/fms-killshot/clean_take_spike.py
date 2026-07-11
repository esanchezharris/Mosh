#!/usr/bin/env python3
"""Clean-take template spike (FMS Stage 0) — run the VALIDATED recipe on a clean self-take.

The soft 134bpm mumble was the pathological case (weak onsets, low forced-align confidence). The
owner re-performed a much cleaner, louder take so we can tell whether the METHOD works when the
audio cooperates. This driver runs the validated recipe end-to-end on that take:

  Whisper words (owner-gated, precomputed → whisper.json / aligned.json) → forced-aligned onsets
  REFINED to the nearest librosa transient (~15ms, his feel) → wordless gaps grid-placed → a click
  per syllable over his take, plus a phase-locked beat grid and an SVG viz. Zero render, ~$0.

Inputs (precomputed under the take dir, owner-gated venvs):
  aligned.json    — forced-aligned words [{word,start,end,score,confidence}]  (skeleton venv)
  take-onsets.json — librosa transients                                       (sketch venv)
  take-f0.json    — {"f0":[{t,hz}]}  FCPE                                     (skeleton venv)
  take.wav        — clean 16-bit mono PCM copy

  python3 scripts/fms-killshot/clean_take_spike.py [take_dir] [bpm]
      defaults: ~/mosh-fms-ksb/clean-take  147
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

import template as tp

OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.expanduser("~/mosh-fms-ksb/clean-take")
BPM = float(sys.argv[2]) if len(sys.argv) > 2 else 147.0
LISTEN = os.path.join(OUT, "listen")
TAKE = os.path.join(OUT, "take.wav")


def _click(sr, freq, amp, ms=45):
    n = int(sr * ms / 1000)
    t = np.arange(n) / sr
    return (amp * np.sin(2 * math.pi * freq * t) * np.exp(-t * 45)).astype(np.float32)


def _place(track, sr, at_s, click):
    i = int(at_s * sr)
    j = min(len(track), i + len(click))
    if j > i:
        track[i:j] += click[: j - i]


def main():
    os.makedirs(LISTEN, exist_ok=True)
    take, sr = sf.read(TAKE)
    if take.ndim > 1:
        take = take.mean(1)
    take = take.astype(np.float32)
    dur = len(take) / sr

    aligned = json.load(open(os.path.join(OUT, "aligned.json")))
    transients = json.load(open(os.path.join(OUT, "take-onsets.json")))
    f0 = json.load(open(os.path.join(OUT, "take-f0.json"))).get("f0", [])

    # VALIDATED recipe: clean take = all real words (no mumble marks). Count from the words,
    # onset = forced-align REFINED to the nearest transient, gaps (none here) gridded.
    units = [{"word": a["word"]} for a in aligned]
    tpl = tp.build_template_wordsfirst(units, aligned, transients=transients, f0=f0, bpm=BPM, subdiv=4)
    real = sum(1 for s in tpl if s["origin"] == "real")
    phase = tp.calibrate_phase([s["onset"] for s in tpl if s["origin"] == "real"], tp.grid_step(BPM, 4))
    print(f"template (words-first + transient-refine): {len(tpl)} syllables ({real} real, {len(tpl)-real} gap) "
          f"from {len(aligned)} words; grid phase {phase*1000:.0f}ms; "
          f"strong {sum(1 for s in tpl if s['stress']=='strong')}; bpm {BPM:g}")
    json.dump(tpl, open(os.path.join(OUT, "template.json"), "w"), indent=1)

    # ── click track: one click per syllable (strong = brighter/louder) ──
    strong_c = _click(sr, 1500, 0.55)
    weak_c = _click(sr, 950, 0.32)
    clicks = np.zeros(len(take), np.float32)
    for s in tpl:
        _place(clicks, sr, s["onset"], strong_c if s["stress"] == "strong" else weak_c)

    # beat-grid metronome — PHASE-LOCKED to his vocal
    beat_c_strong = _click(sr, 2000, 0.4)
    beat_c_weak = _click(sr, 1300, 0.22)
    beats = np.zeros(len(take), np.float32)
    bd = tp.beat_dur(BPM)
    k = 0
    while phase + k * bd <= dur:
        _place(beats, sr, phase + k * bd, beat_c_strong if k % 4 == 0 else beat_c_weak)
        k += 1

    def norm(x, p=0.9):
        m = float(np.abs(x).max())
        return x * (p / m) if m > 0 else x

    take_n = norm(take, 0.8)
    sf.write(os.path.join(LISTEN, "tpl-take+clicks.wav"), norm(take_n + clicks), sr)   # THE test
    sf.write(os.path.join(LISTEN, "tpl-clicks-solo.wav"), norm(clicks), sr)
    sf.write(os.path.join(LISTEN, "tpl-take+beatgrid.wav"), norm(take_n + beats), sr)
    print("staged: tpl-take+clicks.wav, tpl-clicks-solo.wav, tpl-take+beatgrid.wav")

    _write_html(tpl, take, sr, dur, phase)
    return 0


def _write_html(tpl, take, sr, dur, phase=0.0):
    W, H = 1600, 220
    # energy waveform from the take itself (downsampled to W bars)
    hop = max(1, len(take) // W)
    bars = []
    peak = float(np.abs(take).max()) or 1.0
    for x in range(W):
        seg = take[x * hop:(x + 1) * hop]
        v = float(np.abs(seg).max()) / peak if len(seg) else 0.0
        bars.append(f'<rect x="{x}" y="{H-int(v*(H-30))}" width="1" height="{int(v*(H-30))}" fill="#2a3550"/>')
    grid = []
    bd = tp.beat_dur(BPM)
    k = 0
    while phase + k * bd <= dur:
        gx = (phase + k * bd) / dur * W
        grid.append(f'<line x1="{gx:.1f}" y1="0" x2="{gx:.1f}" y2="{H}" stroke="{"#3a3f52" if k % 4 == 0 else "#22252f"}" stroke-width="1"/>')
        k += 1
    marks = []
    for s in tpl:
        mx = s["onset"] / dur * W
        h = 90 if s["stress"] == "strong" else 55
        col = "#63d68a" if s["origin"] == "real" else "#e6a15c"
        marks.append(f'<line x1="{mx:.1f}" y1="{H-h}" x2="{mx:.1f}" y2="{H}" stroke="{col}" stroke-width="2"/>')
    svg = (f'<svg id="viz" viewBox="0 0 {W} {H}" width="100%" preserveAspectRatio="none" '
           f'style="height:220px;background:#0f1116;border-radius:10px">'
           + "".join(grid) + "".join(bars) + "".join(marks)
           + f'<line id="ph" x1="0" y1="0" x2="0" y2="{H}" stroke="#fff" stroke-width="1.5" opacity="0.85"/></svg>')

    html = f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Clean-take template check</title>
<style>
 :root{{color-scheme:dark}} body{{margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;background:#0e0f13;color:#e7e9ee}}
 .wrap{{max-width:820px;margin:0 auto;padding:36px 18px 90px}} h1{{font-size:21px;margin:0 0 4px}}
 .sub{{color:#8b90a0;font-size:13px;margin:0 0 22px}} h3{{font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:#6c7180;margin:26px 0 10px}}
 .card{{background:#16181f;border:1px solid #23262f;border-radius:14px;padding:15px 17px;margin:0 0 13px}}
 .card.hot{{border-color:#2f5233}} .card h2{{font-size:15px;margin:0 0 3px}} .card p{{color:#8b90a0;font-size:12.5px;margin:0 0 10px}}
 audio{{width:100%}} .g{{color:#63d68a}} .o{{color:#e6a15c}}
</style></head><body><div class="wrap">
<h1>Clean-take template check — do the clicks land on my syllables?</h1>
<p class="sub">Your cleaner {BPM:g} bpm take. A click on every syllable the tool detected (counted from your words, timed by forced-align refined to the nearest real transient). {len(tpl)} syllables. If the clicks sit on your syllables, the rhythm template is proven and we build singing on it.</p>

<h3>The test</h3>
<div class="card hot"><h2>Your take + a click on each syllable</h2>
<p>Do the clicks land ON your syllables?</p>
<audio id="a" controls preload="metadata" src="tpl-take+clicks.wav"></audio></div>

<div class="card"><h2>Visual — syllable markers over your waveform</h2>
<p>Playhead follows the audio above. <span class="g">green = your words</span> · <span class="o">orange = mumble gaps</span> · taller = stressed. Faint verticals = the {BPM:g} bpm grid.</p>
<div style="overflow-x:auto">{svg}</div></div>

<h3>Reference</h3>
<div class="card"><h2>Clicks alone</h2><audio controls preload="metadata" src="tpl-clicks-solo.wav"></audio></div>
<div class="card"><h2>Your take + {BPM:g} bpm metronome</h2><p>Is the tempo/grid right?</p><audio controls preload="metadata" src="tpl-take+beatgrid.wav"></audio></div>
</div>
<script>
 const a=document.getElementById('a'),ph=document.getElementById('ph'),W={W},D={dur:.3f};
 a&&a.addEventListener('timeupdate',()=>{{ph.setAttribute('x1',a.currentTime/D*W);ph.setAttribute('x2',a.currentTime/D*W);}});
</script></body></html>"""
    open(os.path.join(LISTEN, "index.html"), "w").write(html)
    print(f"viz -> {LISTEN}/index.html")


if __name__ == "__main__":
    sys.exit(main())
