#!/usr/bin/env python3
"""Ground-truth annotator (annotator round, 2026-07-12) — hand-mark the syllables.

Every grid gate has measured against a ruler nobody's ear certified. This builds a
visual waveform editor: per-phrase, the owner drags syllable-ONSET markers over the
real take, hears clicks against the audio, and adjusts until dead-on. The marks POST to
back-half/ground-truth.json (the preview server's /api/annotations endpoint) and become
THE grid via `backhalf_regrid.py rebuild truth`.

Seeded from detector F (the owner's closest blind pick) so it's nudge-not-place. C and E
show as faint read-only reference rows. Served at
  http://127.0.0.1:8189/used2/asserted-proof/annotate/

Usage:  backhalf_annotate.py            build annotate/index.html
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / "service"))

import backhalf_regrid as rg           # noqa: E402  (evidence + detectors)
from backhalf_ab_bench import BH, ROOT  # noqa: E402
from lyrics import flowspec            # noqa: E402

SERVE = ROOT / "asserted-proof"
OUT = SERVE / "annotate" / "index.html"
PAD_S = 0.3
GAP_S, MIN_SYL = 0.35, 2


def _onsets_in(slots: list, a: float, b: float) -> list:
    return sorted(round(float(s["start"]), 4) for s in slots if a <= float(s["start"]) < b)


def build_annotate_data(evidence: dict, skeleton: dict) -> dict:
    """Pure: evidence + skeleton -> the page's embedded DATA (phrase spans, F seed marks,
    C/E reference marks, the RMS envelope). Deterministic."""
    phrases = flowspec.group_by_rest(skeleton.get("lineScores") or [],
                                     gap_s=GAP_S, min_syllables=MIN_SYL)
    cands = rg._candidate_slots(evidence, skeleton)
    take_s = float(evidence.get("takeS") or 0.0)
    rows = []
    for i, ph in enumerate(phrases):
        a, b = float(ph["start"]), float(ph["end"])
        rows.append({
            "index": i,
            "startS": round(a, 4), "endS": round(b, 4),
            "padStart": round(max(0.0, a - PAD_S), 4),
            "padEnd": round(min(take_s, b + PAD_S), 4),
            "seedF": _onsets_in(cands["F"], a, b),
            "refC": _onsets_in(cands["C"], a, b),
            "refE": _onsets_in(cands["E"], a, b),
        })
    return {"takeS": round(take_s, 4), "hopS": float(evidence.get("hopS") or 0.01),
            "env": evidence.get("env") or [], "audio": "../back-half/source-backhalf-48k.wav",
            "phrases": rows}


def build() -> int:
    ev = rg._load_evidence()
    skel = json.loads(rg.SKELETON.read_text())
    data = build_annotate_data(ev, skel)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(_PAGE.replace("/*DATA*/", json.dumps(data)))
    n_seed = sum(len(p["seedF"]) for p in data["phrases"])
    print(f"annotator: {len(data['phrases'])} phrases, {n_seed} F-seed marks -> {OUT}\n"
          f"  http://127.0.0.1:8189/used2/asserted-proof/annotate/", flush=True)
    return 0


_PAGE = r"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Used2 — mark the syllables (ground truth)</title>
<style>
  body{margin:0;background:#0d1117;color:#e6edf3;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .wrap{max-width:1100px;margin:0 auto;padding:16px 18px 60px}
  h1{font-size:18px;margin:0 0 2px} .sub{color:#8b949e;margin:0 0 14px;font-size:13px}
  .bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:#161b22;border:1px solid #30363d;
       border-radius:10px;padding:10px 12px;margin:0 0 10px}
  button{background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:7px;padding:6px 11px;
          font-size:13px;cursor:pointer} button:hover{border-color:#58a6ff} button:disabled{opacity:.4;cursor:default}
  .prim{background:#1f6feb33;border-color:#1f6feb}
  .count{font-weight:700;font-size:15px} .muted{color:#8b949e} .ok{color:#3fb950}
  input[type=range]{width:90px;vertical-align:middle}
  canvas{width:100%;height:260px;display:block;background:#0b0f14;border:1px solid #30363d;border-radius:10px;
          touch-action:none}
  .legend{display:flex;gap:16px;font-size:12px;color:#8b949e;margin:8px 2px 0;flex-wrap:wrap}
  .sw{display:inline-block;width:12px;height:3px;vertical-align:middle;margin-right:5px;border-radius:2px}
  kbd{background:#21262d;border:1px solid #30363d;border-radius:4px;padding:0 5px;font-size:11px}
  #status{font-size:12px;margin-left:auto}
</style></head><body><div class="wrap">
  <h1>Used2 — mark the syllables</h1>
  <p class="sub">Click the waveform to drop a marker on each syllable's ATTACK; drag to nudge; select + <kbd>Delete</kbd> to remove.
     Press <kbd>Space</kbd> to hear it with clicks and adjust until dead-on. <kbd>[</kbd>/<kbd>]</kbd> change phrase.
     Autosaves as you go.</p>
  <div class="bar">
    <button id="prev">← prev</button>
    <span class="count"><span id="pidx"></span> / <span id="ptot"></span></span>
    <button id="next">next →</button>
    <span class="muted">syllables: <b id="ccount" class="count">0</b></span>
    <label class="muted"><input type="checkbox" id="done"> phrase done</label>
    <span id="status" class="muted"></span>
  </div>
  <div class="bar">
    <button id="play" class="prim">▶ play (Space)</button>
    <label class="muted"><input type="checkbox" id="loop" checked> loop</label>
    <label class="muted"><input type="checkbox" id="solo"> solo clicks</label>
    <span class="muted">mumble <input type="range" id="mvol" min="0" max="100" value="90"></span>
    <span class="muted">clicks <input type="range" id="cvol" min="0" max="100" value="70"></span>
    <button id="reset">reset to detector</button>
    <button id="clear">clear all</button>
  </div>
  <canvas id="cv" width="2000" height="520"></canvas>
  <div class="legend">
    <span><span class="sw" style="background:#e6edf3"></span>your marks (drag / click to add)</span>
    <span><span class="sw" style="background:#3fb950"></span>detector F (seed)</span>
    <span><span class="sw" style="background:#8b949e"></span>detector E</span>
    <span><span class="sw" style="background:#6e7681"></span>current grid C</span>
  </div>
</div>
<script>
const DATA = /*DATA*/;
const API = "/used2/asserted-proof/api/annotations";
const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
let buffer = null, actx = null, cur = 0, marks = {}, done = {}, sel = -1, drag = false;
let playing = false, srcNode = null, startAt = 0, playFrom = 0, raf = 0, saveTimer = 0;

function W(){ return cv.width; } function H(){ return cv.height; }
function ph(){ return DATA.phrases[cur]; }
function t2x(t){ const p = ph(); return (t - p.padStart) / (p.padEnd - p.padStart) * W(); }
function x2t(x){ const p = ph(); return p.padStart + x / W() * (p.padEnd - p.padStart); }

async function load(){
  const r = await fetch(DATA.audio); const ab = await r.arrayBuffer();
  actx = new (window.AudioContext||window.webkitAudioContext)();
  buffer = await actx.decodeAudioData(ab);
  let saved = null;
  try { const g = await (await fetch(API)).json(); saved = g && g.annotations; } catch(e){}
  DATA.phrases.forEach(p => {
    const k = String(p.index);
    marks[k] = (saved && saved.phrases && saved.phrases[k]) ? saved.phrases[k].slice() : p.seedF.slice();
    done[k] = !!(saved && saved.done && saved.done[k]);
  });
  render();
}

function peaks(){
  const p = ph(), sr = buffer.sampleRate, ch = buffer.getChannelData(0);
  const a = Math.floor(p.padStart*sr), b = Math.min(ch.length, Math.floor(p.padEnd*sr));
  const cols = W(), per = (b-a)/cols, out = [];
  for(let i=0;i<cols;i++){
    let lo=1, hi=-1; const s=a+Math.floor(i*per), e=a+Math.floor((i+1)*per);
    for(let j=s;j<e;j++){ const v=ch[j]; if(v<lo)lo=v; if(v>hi)hi=v; }
    out.push([lo,hi]);
  }
  return out;
}

function render(){
  const p = ph(); ctx.clearRect(0,0,W(),H());
  // active span highlight
  ctx.fillStyle = "#161b22";
  ctx.fillRect(t2x(p.startS),0,t2x(p.endS)-t2x(p.startS),H());
  // waveform
  const pk = peaks(), mid = H()*0.42, amp = H()*0.36;
  ctx.strokeStyle = "#2f81f7"; ctx.beginPath();
  for(let i=0;i<pk.length;i++){ ctx.moveTo(i, mid-pk[i][1]*amp); ctx.lineTo(i, mid-pk[i][0]*amp); }
  ctx.stroke();
  // RMS envelope guide
  if(DATA.env.length){
    ctx.strokeStyle = "#8b949e55"; ctx.beginPath(); let started=false;
    for(let i=0;i<W();i++){ const t=x2t(i), fi=Math.floor(t/DATA.hopS); const v=DATA.env[fi]||0;
      const y=mid - Math.min(1, v*6)*amp; if(!started){ctx.moveTo(i,y);started=true;} else ctx.lineTo(i,y); }
    ctx.stroke();
  }
  // reference rows (read-only): C, E
  drawRefs(p.refC, H()*0.90, "#6e7681"); drawRefs(p.refE, H()*0.83, "#8b949e");
  // editable marks
  const m = marks[String(p.index)]||[];
  m.forEach((t,i)=>{ const x=t2x(t);
    ctx.strokeStyle = i===sel ? "#ffd33d" : "#e6edf3"; ctx.lineWidth = i===sel?3:2;
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,mid+amp*0.7); ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.arc(x,10,i===sel?6:4,0,7); ctx.fill();
  });
  ctx.lineWidth = 1;
  // playhead
  if(playing){ const t=playFrom+(actx.currentTime-startAt); const x=t2x(t);
    ctx.strokeStyle="#f85149"; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H()); ctx.stroke(); }
  // hud
  document.getElementById('pidx').textContent = (cur+1);
  document.getElementById('ptot').textContent = DATA.phrases.length;
  document.getElementById('ccount').textContent = m.length;
  const dc = document.getElementById('done'); dc.checked = done[String(p.index)];
  document.getElementById('prev').disabled = cur===0;
  document.getElementById('next').disabled = cur===DATA.phrases.length-1;
}
function drawRefs(arr, y, col){ ctx.strokeStyle=col; arr.forEach(t=>{ const x=t2x(t);
  ctx.beginPath(); ctx.moveTo(x,y-7); ctx.lineTo(x,y+7); ctx.stroke(); }); }

function nearest(x){ const m=marks[String(ph().index)]||[]; let bi=-1, bd=9;
  m.forEach((t,i)=>{ const d=Math.abs(t2x(t)-x); if(d<bd){bd=d;bi=i;} }); return bd<8?bi:-1; }

cv.addEventListener('pointerdown', e=>{
  const r=cv.getBoundingClientRect(), x=(e.clientX-r.left)/r.width*W();
  const hit=nearest(x);
  if(hit>=0){ sel=hit; drag=true; cv.setPointerCapture(e.pointerId); }
  else { const p=ph(); let t=x2t(x); t=Math.max(p.startS, Math.min(p.endS, t));
    const m=marks[String(p.index)]; m.push(+t.toFixed(4)); m.sort((a,b)=>a-b);
    sel=m.indexOf(+t.toFixed(4)); scheduleSave(); }
  render();
});
cv.addEventListener('pointermove', e=>{ if(!drag)return;
  const r=cv.getBoundingClientRect(), x=(e.clientX-r.left)/r.width*W(); const p=ph();
  let t=Math.max(p.startS, Math.min(p.endS, x2t(x))); marks[String(p.index)][sel]=+t.toFixed(4); render(); });
cv.addEventListener('pointerup', e=>{ if(drag){ drag=false; const m=marks[String(ph().index)];
  const v=m[sel]; m.sort((a,b)=>a-b); sel=m.indexOf(v); scheduleSave(); render(); } });

function delSel(){ if(sel<0)return; marks[String(ph().index)].splice(sel,1); sel=-1; scheduleSave(); render(); }
document.addEventListener('keydown', e=>{
  if(e.target.tagName==='INPUT') return;
  if(e.key===' '){ e.preventDefault(); toggle(); }
  else if(e.key==='Delete'||e.key==='Backspace'){ e.preventDefault(); delSel(); }
  else if(e.key===']'){ if(cur<DATA.phrases.length-1){cur++;sel=-1;stop();render();} }
  else if(e.key==='['){ if(cur>0){cur--;sel=-1;stop();render();} }
});
document.getElementById('prev').onclick=()=>{ if(cur>0){cur--;sel=-1;stop();render();} };
document.getElementById('next').onclick=()=>{ if(cur<DATA.phrases.length-1){cur++;sel=-1;stop();render();} };
document.getElementById('reset').onclick=()=>{ marks[String(ph().index)]=ph().seedF.slice(); sel=-1; scheduleSave(); render(); };
document.getElementById('clear').onclick=()=>{ marks[String(ph().index)]=[]; sel=-1; scheduleSave(); render(); };
document.getElementById('done').onchange=e=>{ done[String(ph().index)]=e.target.checked; scheduleSave(); };

function toggle(){ playing?stop():play(); }
document.getElementById('play').onclick=toggle;
function play(){
  const p=ph(); stop(); if(actx.state==='suspended')actx.resume();
  playFrom=p.padStart; startAt=actx.currentTime+0.06;
  const dur=p.padEnd-p.padStart;
  srcNode=actx.createBufferSource(); srcNode.buffer=buffer;
  const mg=actx.createGain(); mg.gain.value=(document.getElementById('solo').checked?0:1)*document.getElementById('mvol').value/100;
  srcNode.connect(mg).connect(actx.destination);
  srcNode.start(startAt, p.padStart, dur);
  const cvol=document.getElementById('cvol').value/100;
  (marks[String(p.index)]||[]).forEach(t=>{
    const when=startAt+(t-p.padStart); const o=actx.createOscillator(), g=actx.createGain();
    o.frequency.value=2000; o.connect(g).connect(actx.destination);
    g.gain.setValueAtTime(cvol,when); g.gain.exponentialRampToValueAtTime(0.0001,when+0.03);
    o.start(when); o.stop(when+0.04);
  });
  srcNode.onended=()=>{ if(playing && document.getElementById('loop').checked){ play(); } else { stop(); } };
  playing=true; document.getElementById('play').textContent='■ stop (Space)';
  const tick=()=>{ if(!playing)return; render(); raf=requestAnimationFrame(tick); }; tick();
}
function stop(){ if(srcNode){ try{srcNode.onended=null;srcNode.stop();}catch(e){} srcNode=null; }
  playing=false; cancelAnimationFrame(raf); document.getElementById('play').textContent='▶ play (Space)';
  const b=document.getElementById('play'); render(); }

function scheduleSave(){ const s=document.getElementById('status'); s.textContent='saving…'; s.className='muted';
  clearTimeout(saveTimer); saveTimer=setTimeout(save,600); }
async function save(){
  const payload={take:"source-backhalf-48k.wav", takeS:DATA.takeS,
    createdAt:new Date().toISOString(), phrases:marks, done:done};
  try{ const r=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const j=await r.json(); const s=document.getElementById('status');
    if(j.ok){ s.textContent='saved ✓'; s.className='ok'; } else { s.textContent='save error: '+(j.error||'?'); s.className='muted'; }
  }catch(e){ document.getElementById('status').textContent='save failed'; }
}
load();
</script></body></html>"""


if __name__ == "__main__":
    sys.exit(build())
