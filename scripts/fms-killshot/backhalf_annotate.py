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
    words = [{"word": str(w.get("word", "")).strip(),
              "start": round(float(w.get("start", 0)), 2),
              "conf": round(float(w.get("conf", 0) or 0), 2),
              "key": f"{flowspec._clean_tok(w.get('word'))}@{float(w.get('start', 0)):.2f}"}
             for w in evidence.get("words") or [] if str(w.get("word", "")).strip()]
    return {"takeS": round(take_s, 4), "hopS": float(evidence.get("hopS") or 0.01),
            "env": evidence.get("env") or [], "audio": "../back-half/source-backhalf-48k.wav",
            "words": words, "phrases": rows}


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
  .danger{border-color:#f8514966;color:#ffa198} .danger:hover{border-color:#f85149}
  .count{font-weight:700;font-size:15px} .muted{color:#8b949e} .ok{color:#3fb950}
  input[type=range]{width:90px;vertical-align:middle}
  canvas{width:100%;height:280px;display:block;background:#0b0f14;border:1px solid #30363d;border-radius:10px;
          touch-action:none;cursor:crosshair}
  .legend{display:flex;gap:16px;font-size:12px;color:#8b949e;margin:8px 2px 0;flex-wrap:wrap}
  .sw{display:inline-block;width:12px;height:3px;vertical-align:middle;margin-right:5px;border-radius:2px}
  kbd{background:#21262d;border:1px solid #30363d;border-radius:4px;padding:0 5px;font-size:11px}
  #status{font-size:12px;margin-left:auto}
</style></head><body><div class="wrap">
  <h1>Used2 — mark the syllables</h1>
  <p class="sub">Click empty waveform to add a marker on a syllable's ATTACK; grab the handle (the pill at top, or anywhere on the line) to drag.
     <kbd>←</kbd>/<kbd>→</kbd> nudge the selected marker (hold <kbd>Shift</kbd> for a bigger step), <kbd>Delete</kbd> removes it, <kbd>⌘Z</kbd> undoes,
     double-click a marker to delete. <kbd>Space</kbd> plays it with clicks; <kbd>[</kbd>/<kbd>]</kbd> change phrase. Autosaves.</p>
  <div class="bar">
    <button id="prev">← prev</button>
    <span class="count"><span id="pidx"></span> / <span id="ptot"></span></span>
    <button id="next">next →</button>
    <span class="muted">syllables: <b id="ccount" class="count">0</b></span>
    <button id="del" class="danger">🗑 delete selected</button>
    <button id="undo">↶ undo</button>
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
    <span>heard words at the bottom — <b>click a word to STRIKE it</b> (junk that must never be used verbatim; its sound still guides)</span>
  </div>
</div>
<script>
const DATA = /*DATA*/;
const API = "/used2/asserted-proof/api/annotations";
const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
// grab radius + handle size are in SCREEN px, scaled to internal px per render (the
// canvas is 2000px internal but displayed ~1000px, so raw internal px read tiny on screen)
const GRAB_SCREEN_PX = 18, HANDLE_HW = 11, HANDLE_H = 16;
const MARK_MARGIN = 0.12, NUDGE_S = 0.005, NUDGE_BIG_S = 0.02, UNDO_MAX = 100;
let buffer = null, actx = null, cur = 0, marks = {}, done = {}, sel = -1, drag = false;
let hoverIdx = -1, undoStack = [], struck = {}, wordBoxes = [];
let playing = false, srcNode = null, startAt = 0, playFrom = 0, raf = 0, saveTimer = 0;
let clickNodes = [];   // scheduled click oscillators — stop() must kill these too

function W(){ return cv.width; } function H(){ return cv.height; }
// internal px per screen px; floor the display size so a degenerate/zero layout
// (e.g. an unlaid-out iframe) can't blow the grab radius up to the whole canvas
function sx(){ const w=cv.getBoundingClientRect().width; return W()/(w>100?w:1000); }
function sy(){ const h=cv.getBoundingClientRect().height; return H()/(h>40?h:280); }
function ph(){ return DATA.phrases[cur]; }
function curKey(){ return String(ph().index); }
function t2x(t){ const p = ph(); return (t - p.padStart) / (p.padEnd - p.padStart) * W(); }
function x2t(x){ const p = ph(); return p.padStart + x / W() * (p.padEnd - p.padStart); }
// the old grid's phrase edges are exactly what we distrust, so allow a small margin past them
function clampT(t){ const p = ph(); return Math.max(p.startS - MARK_MARGIN,
  Math.min(p.endS + MARK_MARGIN, Math.max(p.padStart, Math.min(p.padEnd, t)))); }
function pushUndo(){ undoStack.push({k: curKey(), snap: (marks[curKey()]||[]).slice()});
  if(undoStack.length > UNDO_MAX) undoStack.shift(); }
function doUndo(){ const u = undoStack.pop(); if(!u) return;
  const idx = DATA.phrases.findIndex(p => String(p.index) === u.k);
  if(idx >= 0 && idx !== cur){ cur = idx; stop(); }
  marks[u.k] = u.snap.slice(); sel = -1; scheduleSave(); render(); }

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
  struck = (saved && saved.struck) ? Object.assign({}, saved.struck) : {};
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
  // heard ASR words — click a word to STRIKE it (never locked verbatim; sound still guides)
  wordBoxes = [];
  const wy = H()*0.975, kfx = sx(), kfy = sy();
  ctx.font = `${12*kfy}px -apple-system, sans-serif`;
  ctx.textBaseline = "middle";
  (DATA.words||[]).forEach(w => {
    if (w.start < p.padStart || w.start >= p.padEnd) return;
    const x = t2x(w.start), isStruck = !!struck[w.key];
    ctx.fillStyle = isStruck ? "#f8514999" : "#8b949e";
    ctx.fillText(w.word, x+2*kfx, wy);
    const tw = ctx.measureText(w.word).width;
    if (isStruck){ ctx.strokeStyle="#f85149"; ctx.lineWidth=1.5*kfx;
      ctx.beginPath(); ctx.moveTo(x+1*kfx, wy); ctx.lineTo(x+3*kfx+tw, wy); ctx.stroke(); }
    wordBoxes.push({x0:x-2*kfx, x1:x+4*kfx+tw, y0:wy-9*kfy, y1:wy+9*kfy, key:w.key});
  });
  // editable marks — a full-height grabbable line + a big handle pill at the top (sized
  // in screen px via sx/sy so it's an easy target on the downscaled canvas)
  const m = marks[String(p.index)]||[]; const kx=sx(), ky=sy();
  const hw=HANDLE_HW*kx, hh=HANDLE_H*ky, top=2*ky;
  m.forEach((t,i)=>{ const x=t2x(t); const on=i===sel, hv=i===hoverIdx;
    ctx.strokeStyle = on ? "#ffd33d" : "#e6edf3"; ctx.lineWidth = (on?2.5:1.5)*kx;
    ctx.beginPath(); ctx.moveTo(x, top+hh+2); ctx.lineTo(x, H()); ctx.stroke();
    ctx.fillStyle = on ? "#ffd33d" : (hv ? "#ffffff" : "#e6edf3");
    ctx.beginPath();
    if(ctx.roundRect) ctx.roundRect(x-hw, top, hw*2, hh, 5*kx); else ctx.rect(x-hw, top, hw*2, hh);
    ctx.fill();
    ctx.strokeStyle="#0d1117"; ctx.lineWidth=1*kx;   // grip lines so it reads as draggable
    for(const dx of [-3.5,0,3.5]){ ctx.beginPath(); ctx.moveTo(x+dx*kx, top+5*ky); ctx.lineTo(x+dx*kx, top+hh-5*ky); ctx.stroke(); }
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

function nearest(x){ const m=marks[curKey()]||[]; let bi=-1, bd=1e9; const g=GRAB_SCREEN_PX*sx();
  m.forEach((t,i)=>{ const d=Math.abs(t2x(t)-x); if(d<bd){bd=d;bi=i;} }); return bd<=g?bi:-1; }
function evx(e){ const r=cv.getBoundingClientRect(); return (e.clientX-r.left)/r.width*W(); }

function evy(e){ const r=cv.getBoundingClientRect(); return (e.clientY-r.top)/r.height*H(); }
function wordHit(x, y){ return wordBoxes.find(b => x>=b.x0 && x<=b.x1 && y>=b.y0 && y<=b.y1); }

cv.addEventListener('pointerdown', e=>{
  const x=evx(e), y=evy(e);
  const wb = wordHit(x, y);
  if(wb){ if(struck[wb.key]) delete struck[wb.key]; else struck[wb.key]=true;
    scheduleSave(); render(); return; }   // striking a word never drops a marker
  const hit=nearest(x);
  if(hit>=0){ sel=hit; drag=true; pushUndo(); cv.setPointerCapture(e.pointerId); cv.style.cursor='grabbing'; }
  else { pushUndo(); const t=+clampT(x2t(x)).toFixed(4);
    const m=marks[curKey()]; m.push(t); m.sort((a,b)=>a-b); sel=m.indexOf(t); scheduleSave(); }
  render();
});
cv.addEventListener('pointermove', e=>{
  const x=evx(e);
  if(drag){ marks[curKey()][sel]=+clampT(x2t(x)).toFixed(4); render(); return; }
  const h=nearest(x); cv.style.cursor = h>=0 ? 'grab' : 'crosshair';
  if(h!==hoverIdx){ hoverIdx=h; render(); }
});
cv.addEventListener('pointerup', e=>{ if(drag){ drag=false; cv.style.cursor='grab';
  const m=marks[curKey()]; const v=m[sel]; m.sort((a,b)=>a-b); sel=m.indexOf(v); scheduleSave(); render(); } });
cv.addEventListener('dblclick', e=>{ const h=nearest(evx(e)); if(h>=0){ sel=h; delSel(); } });

function delSel(){ if(sel<0)return; pushUndo(); marks[curKey()].splice(sel,1); sel=-1; scheduleSave(); render(); }
function nudge(d){ if(sel<0)return; pushUndo(); const m=marks[curKey()];
  const v=+clampT(m[sel]+d).toFixed(4); m[sel]=v; m.sort((a,b)=>a-b); sel=m.indexOf(v); scheduleSave(); render(); }
document.addEventListener('keydown', e=>{
  if(e.target.tagName==='INPUT') return;
  if((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==='z'){ e.preventDefault(); doUndo(); return; }
  if(e.key===' '){ e.preventDefault(); toggle(); }
  else if(e.key==='Delete'||e.key==='Backspace'){ e.preventDefault(); delSel(); }
  else if(e.key==='ArrowLeft'){ e.preventDefault(); nudge(-(e.shiftKey?NUDGE_BIG_S:NUDGE_S)); }
  else if(e.key==='ArrowRight'){ e.preventDefault(); nudge(e.shiftKey?NUDGE_BIG_S:NUDGE_S); }
  else if(e.key===']'){ if(cur<DATA.phrases.length-1){cur++;sel=-1;hoverIdx=-1;stop();render();} }
  else if(e.key==='['){ if(cur>0){cur--;sel=-1;hoverIdx=-1;stop();render();} }
});
document.getElementById('prev').onclick=()=>{ if(cur>0){cur--;sel=-1;hoverIdx=-1;stop();render();} };
document.getElementById('next').onclick=()=>{ if(cur<DATA.phrases.length-1){cur++;sel=-1;hoverIdx=-1;stop();render();} };
document.getElementById('reset').onclick=()=>{ pushUndo(); marks[curKey()]=ph().seedF.slice(); sel=-1; scheduleSave(); render(); };
document.getElementById('clear').onclick=()=>{ pushUndo(); marks[curKey()]=[]; sel=-1; scheduleSave(); render(); };
document.getElementById('del').onclick=()=>delSel();
document.getElementById('undo').onclick=()=>doUndo();
document.getElementById('done').onchange=e=>{ done[curKey()]=e.target.checked; scheduleSave(); };

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
    o.start(when); o.stop(when+0.04); clickNodes.push(o);
  });
  srcNode.onended=()=>{ if(playing && document.getElementById('loop').checked){ play(); } else { stop(); } };
  playing=true; document.getElementById('play').textContent='■ stop (Space)';
  const tick=()=>{ if(!playing)return; render(); raf=requestAnimationFrame(tick); }; tick();
}
function stop(){ if(srcNode){ try{srcNode.onended=null;srcNode.stop();}catch(e){} srcNode=null; }
  clickNodes.forEach(o=>{ try{o.stop();}catch(e){} }); clickNodes=[];
  playing=false; cancelAnimationFrame(raf); document.getElementById('play').textContent='▶ play (Space)';
  render(); }

function scheduleSave(){ const s=document.getElementById('status'); s.textContent='saving…'; s.className='muted';
  clearTimeout(saveTimer); saveTimer=setTimeout(save,600); }
async function save(){
  const payload={take:"source-backhalf-48k.wav", takeS:DATA.takeS,
    createdAt:new Date().toISOString(), phrases:marks, done:done, struck:struck};
  try{ const r=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const j=await r.json(); const s=document.getElementById('status');
    if(j.ok){ s.textContent='saved ✓'; s.className='ok'; } else { s.textContent='save error: '+(j.error||'?'); s.className='muted'; }
  }catch(e){ document.getElementById('status').textContent='save failed'; }
}
window.addEventListener('resize', ()=>{ if(buffer) render(); });
// flush a pending debounced save if the tab hides/closes within the 600ms window
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='hidden' && saveTimer){
  clearTimeout(saveTimer); saveTimer=0;
  const payload={take:"source-backhalf-48k.wav", takeS:DATA.takeS,
    createdAt:new Date().toISOString(), phrases:marks, done:done, struck:struck};
  navigator.sendBeacon(API, new Blob([JSON.stringify(payload)], {type:'application/json'}));
}});
load();
</script></body></html>"""


if __name__ == "__main__":
    sys.exit(build())
