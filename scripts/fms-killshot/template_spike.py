#!/usr/bin/env python3
"""Template spike (FMS reset, Stage 0) — SEE + HEAR the per-syllable grid, no singing.

Builds the per-syllable template (template.build_template) for the take from: his forced-aligned
real words + FCPE F0 + Basic-Pitch note onsets (for gap syllables) + the energy envelope. Then
synthesizes a CLICK TRACK — one click per detected syllable (strong = accented) — mixed onto his
take, plus a beat-grid metronome, and an SVG waveform with syllable markers + a synced playhead.

The owner judges by EAR whether the clicks land on the syllables he actually sang (≥80% → the grid
is good enough to build generation/singing on). Zero render, ~$0.

  python3 scripts/fms-killshot/template_spike.py     (reads the saved align/f0/notes for the take)
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
from skeleton import core as skcore

OUT = "/Users/emiliosanchez-harris/mosh-fms-ksb/resing-dominio"
LISTEN = os.path.join(OUT, "listen")
TAKE = os.path.join(LISTEN, "take-134-section-0-63s.wav")
BPM = 134.0

# his lyric — real words; "*" = one mumbled syllable (from his own marking)
LYRIC = [
    "I got balmains on yeah", "put them on just to sing this song",
    "you did me so dirty did me wrong yeah", "she pulling up she won't be long",
    "ride or die ride to the sunset for my life", "growing up ain't easy when you do it right",
    "try and live * live a * life", "* * * * in my sprite",
    "* * tears diamonds in my sprite", "everything we do it's super right",
    "* * * * * * *", "not not enough time", "not enough in the world * * *",
    "I'm * * * * * nervous", "I'm so * * *", "* * * * * * * *",
    "abercrombie and fitch in a ditch", "I left everything",
]


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
    take, sr = sf.read(TAKE)
    if take.ndim > 1:
        take = take.mean(1)
    take = take.astype(np.float32)
    dur = len(take) / sr

    whisper = json.load(open(os.path.join(OUT, "take-whisper.json")))
    f0 = json.load(open(os.path.join(OUT, "take-f0.json")))
    pcm = skcore.read_pcm_mono(TAKE)
    env = skcore.energy_envelope(pcm[0], pcm[1])

    # ASR-driven template (owner's ask): Whisper word timestamps → count + placement, grid-snapped.
    tpl, phase = tp.build_template_from_words(whisper, bpm=BPM, subdiv=4, f0=f0, conf_floor=0.5)
    real = sum(1 for s in tpl if s["origin"] == "real")
    print(f"template (whisper-driven): {len(tpl)} syllables ({real} clear, {len(tpl)-real} low-conf); "
          f"grid phase {phase*1000:.0f}ms; strong {sum(1 for s in tpl if s['stress']=='strong')}")
    json.dump(tpl, open(os.path.join(OUT, "template.json"), "w"), indent=1)

    # ── click track: one click per syllable (strong = brighter/louder) ──
    strong_c = _click(sr, 1500, 0.55)
    weak_c = _click(sr, 950, 0.32)
    clicks = np.zeros(len(take), np.float32)
    for s in tpl:
        _place(clicks, sr, s["onset"], strong_c if s["stress"] == "strong" else weak_c)

    # beat-grid metronome — PHASE-LOCKED to his vocal (fixes "vocal ahead of the click")
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

    _write_html(tpl, env, dur, phase)
    return 0


def _write_html(tpl, env, dur, phase=0.0):
    W, H = 1600, 220
    # energy waveform (downsampled to W bars)
    n = len(env) or 1
    peak = max(env) or 1.0
    bars = []
    for x in range(W):
        lo = int(x / W * n)
        hi = max(lo + 1, int((x + 1) / W * n))
        v = max(env[lo:hi]) / peak if hi <= n else 0.0
        bars.append(f'<rect x="{x}" y="{H-int(v*(H-30))}" width="1" height="{int(v*(H-30))}" fill="#2a3550"/>')
    # beat grid (faint) — phase-locked to his vocal
    grid = []
    bd = tp.beat_dur(BPM)
    k = 0
    while phase + k * bd <= dur:
        gx = (phase + k * bd) / dur * W
        grid.append(f'<line x1="{gx:.1f}" y1="0" x2="{gx:.1f}" y2="{H}" stroke="{"#3a3f52" if k % 4 == 0 else "#22252f"}" stroke-width="1"/>')
        k += 1
    # syllable markers (real=green, gap=orange; strong taller)
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
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Template check — does the grid land on my syllables?</title>
<style>
 :root{{color-scheme:dark}} body{{margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;background:#0e0f13;color:#e7e9ee}}
 .wrap{{max-width:820px;margin:0 auto;padding:36px 18px 90px}} h1{{font-size:21px;margin:0 0 4px}}
 .sub{{color:#8b90a0;font-size:13px;margin:0 0 22px}} h3{{font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:#6c7180;margin:26px 0 10px}}
 .card{{background:#16181f;border:1px solid #23262f;border-radius:14px;padding:15px 17px;margin:0 0 13px}}
 .card.hot{{border-color:#2f5233}} .card h2{{font-size:15px;margin:0 0 3px}} .card p{{color:#8b90a0;font-size:12.5px;margin:0 0 10px}}
 audio{{width:100%}} .legend{{font-size:12px;color:#8b90a0;margin-top:8px}}
 .g{{color:#63d68a}} .o{{color:#e6a15c}}
</style></head><body><div class="wrap">
<h1>Template check — does the grid land on my syllables?</h1>
<p class="sub">No singing. A click on every syllable the tool detected. If the clicks land where you sang, the rhythm template is good and we build on it. {len(tpl)} syllables detected.</p>

<h3>The test</h3>
<div class="card hot"><h2>Your take + a click on each syllable</h2>
<p>Do the clicks land ON your syllables? That's the whole question.</p>
<audio id="a" controls preload="metadata" src="tpl-take+clicks.wav"></audio></div>

<div class="card"><h2>Visual — syllable markers over your energy</h2>
<p>Playhead follows the audio above. <span class="g">green = your words</span> · <span class="o">orange = mumble gaps</span> · taller = stressed. Faint vertical lines = the 134 bpm grid.</p>
<div style="overflow-x:auto">{svg}</div></div>

<h3>Reference</h3>
<div class="card"><h2>Clicks alone</h2><audio controls preload="metadata" src="tpl-clicks-solo.wav"></audio></div>
<div class="card"><h2>Your take + 134 bpm metronome</h2><p>Is the tempo/grid right?</p><audio controls preload="metadata" src="tpl-take+beatgrid.wav"></audio></div>
</div>
<script>
 const a=document.getElementById('a'),ph=document.getElementById('ph'),W={W},D={dur:.3f};
 a&&a.addEventListener('timeupdate',()=>{{ph.setAttribute('x1',a.currentTime/D*W);ph.setAttribute('x2',a.currentTime/D*W);}});
</script></body></html>"""
    open(os.path.join(LISTEN, "index.html"), "w").write(html)
    print(f"viz -> {LISTEN}/index.html")


if __name__ == "__main__":
    sys.exit(main())
