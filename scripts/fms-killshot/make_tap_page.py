#!/usr/bin/env python3
"""Generate the syllable-TAPPING page (FMS reset, Stage 0 — human-in-the-loop rhythm).

Automatic onset detection is too imprecise on his soft take, so the owner taps the syllables
himself = ground-truth rhythm. This page plays his take, records a timestamp on every SPACE
press into `window.taps`, and draws them live over his energy waveform. Claude reads the taps
back via preview_eval and builds the template from them (each tap → snapped to the nearest vocal
energy peak to correct reaction lag).
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
from skeleton import core as skcore  # noqa: E402

OUT = "/Users/emiliosanchez-harris/mosh-fms-ksb/resing-dominio"
LISTEN = os.path.join(OUT, "listen")
# args: [take_wav] [out_html_basename] [title]  — defaults = the 134 mumble take
TAKE = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(LISTEN, "take-134-section-0-63s.wav")
OUT_HTML = sys.argv[2] if len(sys.argv) > 2 else "tap.html"
TITLE = sys.argv[3] if len(sys.argv) > 3 else "your take"
AUDIO = os.path.basename(TAKE)


def main():
    import shutil
    if os.path.abspath(TAKE) != os.path.abspath(os.path.join(LISTEN, AUDIO)):
        shutil.copyfile(TAKE, os.path.join(LISTEN, AUDIO))   # serve it from the listening dir
    pcm = skcore.read_pcm_mono(TAKE)
    env = skcore.energy_envelope(pcm[0], pcm[1])
    dur = len(pcm[0]) / pcm[1]
    W, H = 1600, 200
    n, peak = len(env) or 1, (max(env) or 1.0)
    bars = []
    for x in range(W):
        lo = int(x / W * n)
        hi = max(lo + 1, int((x + 1) / W * n))
        v = max(env[lo:hi]) / peak if hi <= n else 0.0
        bars.append(f'<rect x="{x}" y="{H-int(v*(H-20))}" width="1" height="{int(v*(H-20))}" fill="#2a3550"/>')
    svg = (f'<svg id="viz" viewBox="0 0 {W} {H}" width="100%" preserveAspectRatio="none" '
           f'style="height:200px;background:#0f1116;border-radius:10px">' + "".join(bars)
           + f'<g id="taps"></g><line id="ph" x1="0" y1="0" x2="0" y2="{H}" stroke="#fff" stroke-width="1.5" opacity="0.8"/></svg>')

    html = f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Tap the syllables</title>
<style>
 :root{{color-scheme:dark}} body{{margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;background:#0e0f13;color:#e7e9ee}}
 .wrap{{max-width:900px;margin:0 auto;padding:34px 18px 90px}} h1{{font-size:22px;margin:0 0 4px}}
 .sub{{color:#8b90a0;font-size:13px;margin:0 0 20px}}
 .card{{background:#16181f;border:1px solid #23262f;border-radius:14px;padding:16px 18px;margin:0 0 14px}}
 .big{{font-size:44px;font-weight:700;letter-spacing:.5px}} .big small{{font-size:15px;color:#8b90a0;font-weight:400}}
 audio{{width:100%;margin-top:8px}} button{{font:inherit;background:#21242d;color:#e7e9ee;border:1px solid #333;border-radius:9px;padding:8px 16px;cursor:pointer;margin-right:8px}}
 button:hover{{background:#2a2e39}} kbd{{background:#2a2e39;border:1px solid #444;border-radius:6px;padding:1px 8px;font-family:ui-monospace,monospace}}
 .tip{{color:#e6c887;font-size:12.5px;margin-top:10px}}
</style></head><body><div class="wrap">
<h1>Tap the syllables 🥁 — {TITLE}</h1>
<p class="sub">Press <b>play</b>, then hit <kbd>Space</kbd> once for every syllable you hear — this becomes the rhythm the whole song is built on. Don't worry about being perfectly on time; I correct the lag using your vocal. Redo as many times as you like.</p>

<div class="card">
  <div class="big"><span id="count">0</span> <small>taps</small></div>
  <audio id="take" controls preload="auto" src="{AUDIO}"></audio>
  <div style="margin-top:12px">
    <button onclick="clearTaps()">Clear / redo</button>
    <button onclick="restart()">⏮ From start</button>
  </div>
  <div class="tip">Tip: tap along a few bars, hit Clear, and do it again until it feels right. When you're happy, tell me and I'll read them.</div>
</div>

<div class="card"><div style="overflow-x:auto">{svg}</div></div>
</div>
<script>
 const D={dur:.3f}, W={W}, H={H};
 const audio=document.getElementById('take'), gTaps=document.getElementById('taps'),
       ph=document.getElementById('ph'), cnt=document.getElementById('count');
 window.taps=[];
 function draw(){{
   gTaps.innerHTML=window.taps.map(t=>`<line x1="${{(t/D*W).toFixed(1)}}" y1="60" x2="${{(t/D*W).toFixed(1)}}" y2="${{H}}" stroke="#63d68a" stroke-width="2"/>`).join('');
   cnt.textContent=window.taps.length;
 }}
 document.addEventListener('keydown',e=>{{
   if(e.code==='Space'){{ e.preventDefault();
     if(!audio.paused){{ window.taps.push(+audio.currentTime.toFixed(3)); draw(); }} }}
 }});
 audio.addEventListener('timeupdate',()=>{{ const x=audio.currentTime/D*W; ph.setAttribute('x1',x); ph.setAttribute('x2',x); }});
 function clearTaps(){{ window.taps=[]; draw(); }}
 function restart(){{ audio.currentTime=0; }}
</script></body></html>"""
    open(os.path.join(LISTEN, OUT_HTML), "w").write(html)
    print(f"tap page -> {LISTEN}/{OUT_HTML}  (audio {AUDIO})")


if __name__ == "__main__":
    sys.exit(main())
