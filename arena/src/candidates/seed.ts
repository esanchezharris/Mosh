// ── The seed wall: hand-authored candidates (Opus, in-session) so the Arena is full of
// beautiful, judgeable looks on day one — before any model API is wired. Each is a
// complete self-contained candidate over the shared kit/fixtures, so a winner ports clean.

import referenceFrag from "../reference/referenceShader.glsl?raw";
import { ANCHORS } from "../reference/params";
import { shellMock } from "./shellMock";
import { MOSHI_SEEDS } from "./moshi";
import type { Candidate } from "../models/types";

// ── whole-shell look CSS (layered on shellMock's common skeleton) ──────────────

// ELEVATE · "Obsidian" — the identity, made exquisite: glass chrome, a lit play button,
// hairline highlights, richer clip depth. Nothing reinvented, everything considered.
const OBSIDIAN = `
:root{--wave:var(--v2-accent)}
.s-top{background:linear-gradient(180deg,rgba(20,20,22,.72),rgba(10,10,12,.4));backdrop-filter:blur(16px);border-bottom-color:rgba(255,255,255,.06)}
.s-brand{text-shadow:0 0 18px rgba(204,255,54,.18)}
.s-pill{background:rgba(18,18,20,.7);box-shadow:inset 0 1px 0 rgba(255,255,255,.05)}
.s-tb.play{box-shadow:0 0 18px rgba(204,255,54,.5),0 2px 6px rgba(0,0,0,.4)}
.s-stage{background:linear-gradient(180deg,rgba(26,26,28,.7),rgba(16,16,18,.7));box-shadow:0 30px 70px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.04)}
.s-clip{box-shadow:0 4px 16px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.07)}
.s-clip-0{background:linear-gradient(180deg,rgba(40,44,40,.8),rgba(22,24,22,.8))}
.s-licon{box-shadow:0 0 14px rgba(204,255,54,.1)}
.s-orb{box-shadow:0 0 40px rgba(204,255,54,.28),inset 0 0 0 1px rgba(255,255,255,.08)}
.s-comp{background:linear-gradient(180deg,rgba(36,36,40,.9),rgba(22,22,26,.9));backdrop-filter:blur(12px)}
.s-comp:focus-within,.s-comp{transition:box-shadow .3s}
`;

// BOLDER · "Aurora Glass" — a living aurora breathes behind frosted-glass panels; lime
// stays the hero but the surfaces turn to glass and light. MOSH, dialed to cinematic.
const AURORA = `
:root{--wave:#d7ff5e}
.s{background:#050608}
.s::before{content:"";position:absolute;inset:-20%;z-index:0;pointer-events:none;filter:blur(60px);opacity:.55;
 background:radial-gradient(40% 50% at 20% 20%,rgba(204,255,54,.5),transparent 60%),
  radial-gradient(45% 55% at 80% 30%,rgba(64,180,255,.4),transparent 60%),
  radial-gradient(50% 60% at 55% 90%,rgba(255,80,180,.35),transparent 60%);
 animation:drift 14s ease-in-out infinite alternate}
@keyframes drift{from{transform:translate(-4%,-2%) scale(1)}to{transform:translate(5%,3%) scale(1.12)}}
.s-top,.s-body{position:relative;z-index:1}
.s-top{background:rgba(10,12,16,.35);backdrop-filter:blur(22px) saturate(1.2);border-bottom-color:rgba(255,255,255,.1)}
.s-brand em{color:#d7ff5e;text-shadow:0 0 20px rgba(215,255,94,.6)}
.s-stage,.s-card,.s-comp,.s-pill{background:rgba(18,20,26,.42)!important;backdrop-filter:blur(26px) saturate(1.15);border-color:rgba(255,255,255,.14)!important}
.s-stage{box-shadow:0 30px 80px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.08)}
.s-clip{border-color:rgba(215,255,94,.35);box-shadow:0 0 22px rgba(215,255,94,.12),0 6px 20px rgba(0,0,0,.4)}
.s-heads{background:rgba(14,16,20,.5)}
.s-tb.play{background:#d7ff5e;box-shadow:0 0 26px rgba(215,255,94,.7)}
.s-ph{background:#eaffab;box-shadow:0 0 18px #d7ff5e}
.s-orb{background:radial-gradient(circle at 38% 34%,#eaffab,#7a2bff 78%);box-shadow:0 0 48px rgba(215,255,94,.4)}
.s-invite{box-shadow:0 0 20px rgba(215,255,94,.5)}
`;

// ELEVATE · "Cream" — the light theme, made premium: warm paper page, floating dark
// panels, soft warm shadows. (Rendered with theme:'light' so the kit swaps grounds.)
const CREAM = `
:root{--wave:var(--v2-accent)}
.s{background:var(--v2-bg)}
.s-top{background:transparent;border-bottom-color:var(--v2-ground-line)}
.s-brand{color:var(--v2-ground-text)}
.s-brand em{color:#5a7a12}
.s-pill{background:var(--v2-ground-card);border-color:var(--v2-ground-line);box-shadow:0 2px 10px rgba(70,56,28,.08)}
.s-time{color:var(--v2-ground-text)}.s-time small{color:var(--v2-ground-dim)}
.s-tab{color:var(--v2-ground-dim)}
.s-nav{background:var(--v2-ground-card);border-color:var(--v2-ground-line);color:var(--v2-ground-dim)}
.s-stage{box-shadow:0 26px 60px rgba(70,56,28,.16)}
.s-comp{box-shadow:0 14px 34px rgba(70,56,28,.14)}
.s-av i{border-color:var(--v2-ground)}
`;

// ── focused component candidates ───────────────────────────────────────────────

const COMPOSER = `<style>
.wrap{position:absolute;inset:0;display:grid;place-items:center;background:var(--v2-bg);padding:26px}
.cx{width:min(560px,100%);display:flex;flex-direction:column;gap:12px}
.chips{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
.chip{font-size:11px;padding:7px 12px;border-radius:999px;border:1px solid var(--v2-line);color:var(--v2-dim);background:var(--v2-surface);letter-spacing:.02em}
.chip b{color:var(--v2-accent);font-weight:600}
.bar{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:18px;border:1px solid var(--v2-line);
 background:linear-gradient(180deg,var(--v2-surface-2),var(--v2-surface));box-shadow:var(--v2-shadow),inset 0 1px 0 rgba(255,255,255,.05)}
.orb{position:relative;width:40px;height:40px;border-radius:12px;display:grid;place-items:center;flex:none;
 background:var(--v2-accent-soft);color:var(--v2-accent);font-size:19px}
.orb::after{content:"";position:absolute;inset:-4px;border-radius:16px;border:1.5px solid var(--v2-accent);opacity:.5;animation:ring 2.4s ease-out infinite}
@keyframes ring{0%{transform:scale(.8);opacity:.7}100%{transform:scale(1.25);opacity:0}}
.field{flex:1;display:flex;flex-direction:column;gap:2px}
.field .lab{font-size:9px;letter-spacing:.16em;color:var(--v2-faint);text-transform:uppercase}
.field input{background:transparent;border:0;outline:0;color:var(--v2-text);font:inherit;font-size:15px}
.field input::placeholder{color:var(--v2-faint)}
.mic{width:34px;height:34px;border-radius:11px;border:1px solid var(--v2-line);background:var(--v2-surface-sunken);color:var(--v2-dim);font-size:14px;display:grid;place-items:center}
.go{width:38px;height:38px;border-radius:12px;border:0;background:var(--v2-accent);color:var(--v2-accent-ink);font-size:16px;font-weight:700}
.cap{text-align:center;font-family:var(--font-mono);font-size:9.5px;letter-spacing:.14em;color:var(--v2-accent);text-transform:uppercase}
</style>
<div class="wrap"><div class="cx">
 <div class="cap">● listening · mosh is with you</div>
 <div class="bar">
  <div class="orb">✦</div>
  <div class="field"><span class="lab">Prompt</span><input placeholder="add a half-time break and swap the pad for something warmer"/></div>
  <div class="mic">🎙</div><button class="go">↑</button>
 </div>
 <div class="chips"><span class="chip"><b>✦</b> Finish this section</span><span class="chip"><b>✦</b> Re-imagine the drums</span><span class="chip"><b>✦</b> Write a hook</span></div>
</div></div>`;

const TRANSPORT = `<style>
.wrap{position:absolute;inset:0;display:grid;place-items:center;background:var(--v2-bg);padding:24px}
.tp{display:flex;align-items:center;gap:16px;padding:12px 18px;border-radius:18px;border:1px solid var(--v2-line);
 background:linear-gradient(180deg,rgba(30,30,34,.5),rgba(16,16,20,.6));backdrop-filter:blur(22px);box-shadow:var(--v2-shadow)}
.grp{display:flex;align-items:center;gap:8px}
.b{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;border:1px solid var(--v2-line);background:var(--v2-surface-sunken);color:var(--v2-text);font-size:12px}
.play{width:46px;height:46px;background:var(--v2-accent);color:var(--v2-accent-ink);border-color:transparent;font-size:16px;box-shadow:0 0 24px rgba(204,255,54,.45)}
.rec{color:var(--v2-rec);border-color:rgba(255,59,92,.4)}
.time{display:flex;flex-direction:column;line-height:1;padding:0 6px;border-left:1px solid var(--v2-line);border-right:1px solid var(--v2-line);margin:0 2px}
.time b{font-family:var(--font-mono);font-size:22px;letter-spacing:.03em}
.time span{font-family:var(--font-mono);font-size:8.5px;letter-spacing:.2em;color:var(--v2-faint);margin-top:3px}
.bpm{display:flex;flex-direction:column;align-items:center;gap:2px}
.bpm b{font-family:var(--font-mono);font-size:16px}
.bpm span{font-size:8px;letter-spacing:.18em;color:var(--v2-faint)}
.scrub{width:150px;height:26px;border-radius:8px;border:1px solid var(--v2-line);position:relative;overflow:hidden;background:var(--v2-surface-sunken)}
.scrub canvas{width:100%;height:100%;display:block}
.scrub .ph{position:absolute;top:0;bottom:0;width:2px;background:var(--v2-accent);box-shadow:0 0 8px var(--v2-accent)}
</style>
<div class="wrap"><div class="tp">
 <div class="grp"><div class="b">⏮</div><div class="b play">▶</div><div class="b">◼</div><div class="b rec">●</div></div>
 <div class="time"><b>005·2·01</b><span>BAR · BEAT · TICK</span></div>
 <div class="scrub"><canvas data-wave data-seed="1.6"></canvas><div class="ph"></div></div>
 <div class="bpm"><b>122</b><span>BPM</span></div>
</div></div>
<script>
(function(){var cv=document.querySelector('canvas[data-wave]');if(cv){var ctx=cv.getContext('2d');var dpr=Math.min(devicePixelRatio||1,2);
 function d(){var w=cv.clientWidth,h=cv.clientHeight;cv.width=w*dpr;cv.height=h*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
  ctx.fillStyle=getComputedStyle(document.documentElement).getPropertyValue('--v2-accent').trim();
  for(var x=0;x<w;x++){var t=x/w;var a=Math.min(1,Math.abs(Math.sin(t*20)+0.5*Math.sin(t*47))* (0.4+0.6*Math.abs(Math.sin(t*25))));var hh=a*h*0.42;ctx.fillRect(x,h/2-hh,1,hh*2);}}
 d();addEventListener('resize',d);}
 var ph=document.querySelector('.scrub .ph'),sc=document.querySelector('.scrub');
 function f(){var p=(window.__mosh&&window.__mosh.playhead)||0;if(ph&&sc)ph.style.left=(p*sc.clientWidth)+'px';requestAnimationFrame(f);}requestAnimationFrame(f);
})();
<\/script>`;

// ── new "bolder" waveform shader (not the reference): a mirrored neon ribbon from amp ──
const NEON_RIBBON = `#version 300 es
precision highp float;
out vec4 O;
uniform vec2 uRes; uniform float uTime,uPlayhead,uPlaying,uNCols,uBeats,uWake,uThick,uGrain,uGlass;
uniform int uMode,uCount,uColorMode;
uniform sampler2D uData;
uniform vec3 uLow,uMid,uHigh,uGlow,uBg;
float amp01(float x){ if(uMode==0){return texture(uData,vec2(x,.5)).r;}
  // midi/drums: coarse energy from nearest event count band
  return .35+.35*sin(x*24.+uTime); }
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  float a=amp01(uv.x);
  float mid=.5;
  float edge=a*.46*(.4+uThick);
  float d=abs(uv.y-mid);
  float body=smoothstep(edge+.006,edge-.006,d);
  float core=smoothstep(edge*.5+.02,0.,d);
  vec3 tint=mix(uLow,uHigh,uv.x);
  vec3 col=uBg;
  col+=body*tint*(.55+.9*a);
  col+=core*mix(tint,vec3(1.),.5)*.6;
  float ph=smoothstep(2.5/uRes.x,0.,abs(uv.x-uPlayhead));
  col+=ph*uGlow*(.5+.6*uWake);
  col+=(fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5)-.5)*.045*(.5+uGrain);
  O=vec4(pow(max(col,0.),vec3(.92)),1.);
}`;

const NEON_PARAMS = { ...ANCHORS["SPECTRAL INK"].p, low: "#ff2e97", mid: "#8a5cff", high: "#22d3ee", glow: "#ff6fd8", bg: "#070510", thick: 0.9, wake: 0.85, grain: 0.18 };

export const SEED: Candidate[] = [
  { id: "seed-shell-obsidian", title: "Obsidian", target: "shell", pass: "elevate", kind: "html", model: "opus-insession", theme: "dark", source: shellMock(OBSIDIAN), createdAt: 0, notes: "glass chrome, lit play, richer clip depth — the identity made exquisite" },
  { id: "seed-shell-aurora", title: "Aurora Glass", target: "shell", pass: "bolder", kind: "html", model: "opus-insession", theme: "dark", source: shellMock(AURORA), createdAt: 0, notes: "living aurora behind frosted glass; lime stays the hero" },
  { id: "seed-shell-cream", title: "Paper", target: "shell", pass: "elevate", kind: "html", model: "opus-insession", theme: "light", source: shellMock(CREAM), createdAt: 0, notes: "the cream light theme, made premium" },
  { id: "seed-composer", title: "Agent Composer", target: "composer", pass: "elevate", kind: "html", model: "opus-insession", theme: "dark", source: COMPOSER, createdAt: 0, notes: "the smart centerpiece: listening ring, suggestion chips" },
  { id: "seed-transport", title: "Glass Transport", target: "transport", pass: "bolder", kind: "html", model: "opus-insession", theme: "dark", source: TRANSPORT, createdAt: 0, notes: "frosted transport cluster with live scrubber" },
  { id: "seed-wave-mercury", title: "Liquid Mercury", target: "waveform", pass: "elevate", kind: "glsl", model: "opus-insession", source: referenceFrag, params: ANCHORS["LIQUID MERCURY"].p, createdAt: 0, notes: "chrome liquid, rhythm-swelled" },
  { id: "seed-wave-spectral", title: "Spectral Ink", target: "waveform", pass: "elevate", kind: "glsl", model: "opus-insession", source: referenceFrag, params: ANCHORS["SPECTRAL INK"].p, createdAt: 0, notes: "3-band color, beats read clearly" },
  { id: "seed-wave-riso", title: "Riso Glass", target: "waveform", pass: "bolder", kind: "glsl", model: "opus-insession", source: referenceFrag, params: ANCHORS["RISO GLASS"].p, createdAt: 0, notes: "print halftone × refraction" },
  { id: "seed-wave-neon", title: "Neon Ribbon", target: "waveform", pass: "bolder", kind: "glsl", model: "opus-insession", source: NEON_RIBBON, params: NEON_PARAMS, createdAt: 0, notes: "a new shader: mirrored neon ribbon from amplitude" },
  // clip material on NON-audio tracks — same material rules, different geometry (his note)
  { id: "seed-clip-midi", title: "Spectral · MIDI chords", target: "waveform", pass: "elevate", kind: "glsl", model: "opus-insession", source: referenceFrag, params: ANCHORS["SPECTRAL INK"].p, fixtureMode: 1, createdAt: 0, notes: "same material on MIDI — chords weld into gooey SDF blobs" },
  { id: "seed-clip-drums", title: "Mercury · Drums", target: "waveform", pass: "elevate", kind: "glsl", model: "opus-insession", source: referenceFrag, params: ANCHORS["LIQUID MERCURY"].p, fixtureMode: 2, createdAt: 0, notes: "same material on drums — hits as metaballs" },
  ...MOSHI_SEEDS,
];
