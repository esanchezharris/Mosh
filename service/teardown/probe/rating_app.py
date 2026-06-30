#!/usr/bin/env python3
"""Generate a self-contained, BLIND rating webpage (index.html) inside a probe pack.

Rating 88 clips by editing a CSV in a text editor is miserable → fatigue → bad/abandoned data.
This writes a single index.html (no server, no deps — just open it) that plays each clip, takes a
1–7 tap (or number key), handles the A/B pairs, persists progress to localStorage, and exports the
filled RATINGS.csv / AB_PAIRS.csv. It reads ONLY clip filenames + the public A/B pairs
(.ab_public.json) — never .mapping.json — so it stays blind to the machine scores.

  python rating_app.py --pack ~/mosh-reward-probe
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

HTML = r"""<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Mosh reward probe — blind rating</title>
<style>
:root{color-scheme:dark}
body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:760px;margin:0 auto;padding:18px;background:#16161a;color:#e8e8ea}
h1{font-size:19px;margin:.2em 0}.sub{color:#9a9aa2;font-size:13px;margin-bottom:14px}
.bar{position:sticky;top:0;background:#16161acc;backdrop-filter:blur(6px);padding:10px 0;border-bottom:1px solid #2a2a31;z-index:9;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.bar b{color:#7ee787}
button{font:inherit;background:#26262e;color:#e8e8ea;border:1px solid #3a3a44;border-radius:7px;padding:5px 10px;cursor:pointer}
button:hover{background:#30303a}
.row{border:1px solid #2a2a31;border-radius:9px;padding:10px 12px;margin:9px 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.row.done{border-color:#2c4a32;background:#19211b}
.idx{font-weight:700;width:42px;color:#c9c9d2}
.play{min-width:64px}
.rate{display:flex;gap:4px}
.rate b{width:30px;text-align:center;padding:6px 0;border:1px solid #3a3a44;border-radius:6px;cursor:pointer;user-select:none}
.rate b.sel{background:#2f81f7;border-color:#2f81f7;color:#fff;font-weight:700}
.notes{flex:1;min-width:120px;background:#1d1d24;border:1px solid #2a2a31;border-radius:6px;color:#e8e8ea;padding:5px 8px}
.ab{border:1px solid #3a2a44;border-radius:9px;padding:10px 12px;margin:9px 0}
.ab.done{border-color:#4a2c4a;background:#211921}
.win{padding:6px 12px}.win.sel{background:#a371f7;border-color:#a371f7;color:#fff;font-weight:700}
.hint{color:#8a8a92;font-size:12px}.export{background:#238636;border-color:#238636;color:#fff}
section h2{font-size:16px;margin:22px 0 6px;border-top:1px solid #2a2a31;padding-top:14px}
</style></head><body>
<h1>Mosh reward-validity probe — blind rating</h1>
<div class=sub>Loudness-matched short loops in random order. Judge the MUSIC (groove, timbre,
coherence), not volume. Rate fast, on instinct. Keyboard: focus a clip, press <b>1–7</b>; Space replays.</div>
<div class=bar>
  <span>Rated <b id=rc>0</b>/__NCLIPS__ &nbsp; A/B <b id=ac>0</b>/__NPAIRS__</span>
  <button class=export id=exp1>⬇ Export RATINGS.csv</button>
  <button class=export id=exp2>⬇ Export AB_PAIRS.csv</button>
  <button id=copy>📋 Copy both as text</button>
  <button id=reset>reset</button>
</div>
<section><h2>Rate every clip (1 = worst … 7 = best)</h2><div id=clips></div></section>
<section><h2>A/B — which sounds musically better?</h2><div id=abs></div></section>
<textarea id=blob style="width:100%;height:120px;margin-top:12px;display:none;background:#1d1d24;color:#e8e8ea;border:1px solid #2a2a31;border-radius:6px"></textarea>
<script>
const CLIPS=__CLIPS__, PAIRS=__PAIRS__, KEY="moshprobe:"+location.pathname;
let S=JSON.parse(localStorage.getItem(KEY)||'{"r":{},"n":{},"w":{}}');
const save=()=>localStorage.setItem(KEY,JSON.stringify(S));
const $=s=>document.querySelector(s);
function counts(){$("#rc").textContent=Object.keys(S.r).length;$("#ac").textContent=Object.keys(S.w).length;}
// single-playback toggle: clicking play ▶ starts (pausing any other), clicking again ⏸ pauses; resumes from position.
let CUR=null;
function wirePlay(btn,au,label){
  au.onplay=()=>btn.textContent="⏸ "+label;
  au.onpause=()=>btn.textContent="▶ "+label;
  au.onended=()=>{au.currentTime=0;btn.textContent="▶ "+label;};
  btn.onclick=()=>{ if(au.paused){ if(CUR&&CUR!==au)CUR.pause(); CUR=au; au.play(); } else au.pause(); };
  return ()=>btn.onclick();  // toggle fn for keyboard
}
const clipsEl=$("#clips");
CLIPS.forEach(id=>{
  const row=document.createElement("div");row.className="row"+(S.r[id]?" done":"");row.tabIndex=0;row.dataset.id=id;
  const au=new Audio("clips/"+id+".wav");
  const rate=document.createElement("div");rate.className="rate";
  let html=`<span class=idx>${id}</span><button class=play>▶ play</button>`;
  row.innerHTML=html;
  const toggle=wirePlay(row.querySelector(".play"),au,"play");
  for(let k=1;k<=7;k++){const b=document.createElement("b");b.textContent=k;if(S.r[id]==k)b.classList.add("sel");
    b.onclick=()=>{S.r[id]=k;save();[...rate.children].forEach(c=>c.classList.remove("sel"));b.classList.add("sel");row.classList.add("done");counts();};
    rate.appendChild(b);}
  const nt=document.createElement("input");nt.className="notes";nt.placeholder="notes (optional)";nt.value=S.n[id]||"";
  nt.oninput=()=>{S.n[id]=nt.value;save();};
  row.appendChild(rate);row.appendChild(nt);
  row.addEventListener("keydown",e=>{if(e.key>="1"&&e.key<="7"){S.r[id]=+e.key;save();[...rate.children].forEach((c,i)=>c.classList.toggle("sel",i+1==+e.key));row.classList.add("done");counts();}else if(e.key===" "){e.preventDefault();toggle();}});
  clipsEl.appendChild(row);
});
const absEl=$("#abs");
PAIRS.forEach(p=>{
  const d=document.createElement("div");d.className="ab"+(S.w[p.pair]?" done":"");
  d.innerHTML=`<span class=idx>#${p.pair}</span> <button class=play data-f="${p.A}">▶ A (${p.A})</button> <button class=play data-f="${p.B}">▶ B (${p.B})</button> &nbsp;`;
  const a=document.createElement("button");a.className="win"+(S.w[p.pair]=="A"?" sel":"");a.textContent="A better";
  const b=document.createElement("button");b.className="win"+(S.w[p.pair]=="B"?" sel":"");b.textContent="B better";
  a.onclick=()=>{S.w[p.pair]="A";save();a.classList.add("sel");b.classList.remove("sel");d.classList.add("done");counts();};
  b.onclick=()=>{S.w[p.pair]="B";save();b.classList.add("sel");a.classList.remove("sel");d.classList.add("done");counts();};
  d.appendChild(a);d.appendChild(b);
  d.querySelectorAll(".play").forEach(btn=>{const au=new Audio("clips/"+btn.dataset.f+".wav");wirePlay(btn,au,(btn.dataset.f===p.A?"A":"B")+" ("+btn.dataset.f+")");});
  absEl.appendChild(d);
});
function ratingsCSV(){let o="index,rating,notes\n";CLIPS.forEach(id=>{const n=(S.n[id]||"").replace(/[,\n]/g," ");o+=`${id},${S.r[id]||""},${n}\n`;});return o;}
function abCSV(){let o="pair,A,B,winner\n";PAIRS.forEach(p=>{o+=`${p.pair},${p.A},${p.B},${S.w[p.pair]||""}\n`;});return o;}
function dl(name,txt){const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([txt],{type:"text/csv"}));a.download=name;a.click();}
$("#exp1").onclick=()=>dl("RATINGS.csv",ratingsCSV());
$("#exp2").onclick=()=>dl("AB_PAIRS.csv",abCSV());
$("#copy").onclick=()=>{const t=$("#blob");t.style.display="block";t.value="==== RATINGS.csv ====\n"+ratingsCSV()+"\n==== AB_PAIRS.csv ====\n"+abCSV();t.select();};
$("#reset").onclick=()=>{if(confirm("Clear all your ratings?")){S={r:{},n:{},w:{}};save();location.reload();}};
counts();
</script></body></html>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack", default="~/mosh-reward-probe")
    a = ap.parse_args()
    pack = Path(a.pack).expanduser()
    clips = sorted(p.stem for p in (pack / "clips").glob("*.wav"))
    pairs = json.loads((pack / ".ab_public.json").read_text()) if (pack / ".ab_public.json").exists() else []
    html = (HTML.replace("__CLIPS__", json.dumps(clips))
                .replace("__PAIRS__", json.dumps(pairs))
                .replace("__NCLIPS__", str(len(clips)))
                .replace("__NPAIRS__", str(len(pairs))))
    (pack / "index.html").write_text(html)
    print(f"wrote {pack/'index.html'} ({len(clips)} clips, {len(pairs)} A/B pairs)")


if __name__ == "__main__":
    main()
