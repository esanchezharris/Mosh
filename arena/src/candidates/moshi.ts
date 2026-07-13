// ── Moshi + Stage seed candidates. Each mounts the REAL creature (window.Moshi, injected
// via usesMoshi) and explores a different vision of how Moshi lives in the interface —
// across prominence / role / placement / embodiment, the invariant-core+patina model,
// AND the body-morph alternative the owner is torn about. Ground truth, not placeholders.

import type { Candidate } from "../models/types";

const FAIL = `<style>.mfail{display:grid;place-items:center;height:100%;color:var(--v2-faint);font:11px var(--font-mono)}</style>`;

// mount helper (string): create Moshi on host #id, drive it, graceful WebGL fallback.
const mount = (id: string, opts: Record<string, unknown>, drive = "") => `
  (function(){var h=document.getElementById('${id}');if(!h)return;
   try{var m=window.Moshi(h, ${JSON.stringify(opts)});${drive}}
   catch(e){h.className='mfail';h.textContent='Moshi (WebGL) unavailable';}})();`;

const energyLoop = "function L(){var t=(window.__mosh&&window.__mosh.time)||0;m.set('energy',0.32+0.28*Math.abs(Math.sin(t*1.3)));requestAnimationFrame(L);}requestAnimationFrame(L);";

// 1 — DOCK COMPANION (elevate): today's right-rail presence, made premium.
const DOCK = `${FAIL}<style>
.m{position:absolute;inset:0;display:grid;grid-template-columns:1fr 340px;background:var(--v2-bg);color:var(--v2-text);font-family:var(--font-body)}
.work{padding:44px;display:flex;flex-direction:column;gap:14px;opacity:.42}
.work .lane{height:70px;border:1px solid var(--v2-line);border-radius:12px;background:linear-gradient(180deg,var(--v2-surface-2),var(--v2-surface))}
.rail{border-left:1px solid var(--v2-line);padding:22px;display:flex;flex-direction:column;gap:16px}
.card{border:1px solid var(--v2-line);border-radius:22px;background:var(--v2-surface);padding:18px;box-shadow:var(--v2-shadow)}
.head{display:flex;justify-content:space-between;align-items:center;font-size:14px;color:var(--v2-dim);margin-bottom:10px}
.live{display:inline-flex;gap:7px;align-items:center;font-size:12px;color:var(--v2-accent)}
.live .led{width:8px;height:8px;border-radius:50%;background:var(--v2-accent);box-shadow:0 0 10px var(--v2-accent)}
#h1{width:100%;height:280px;border-radius:18px;overflow:hidden;background:radial-gradient(circle at 50% 42%,rgba(204,255,54,.1),transparent 70%);box-shadow:inset 0 0 0 1px rgba(204,255,54,.4),0 0 40px rgba(204,255,54,.14)}
.cap{text-align:center;font-family:var(--font-display);font-weight:800;font-size:26px;color:var(--v2-accent);margin-top:14px}
.st{text-align:center;font-size:13px;color:var(--v2-dim);margin-top:6px}
</style>
<div class="m">
 <div class="work"><div class="lane"></div><div class="lane"></div><div class="lane"></div><div class="lane"></div><div class="lane"></div></div>
 <div class="rail"><div class="card">
  <div class="head"><span style="font-family:var(--font-display);font-weight:800;font-size:15px;color:var(--v2-text)">Mosh</span><span class="live"><span class="led"></span>Live</span></div>
  <div id="h1"></div><div class="cap">vibe</div><div class="st">listening · ready when you are</div>
 </div></div>
</div>
<script>${mount("h1", { personality: "TAR", seed: 0.5, quality: "ps2", style: "toon", interactive: true }, "m.setState('LISTENING');m.set('mood',0.74);" + energyLoop)}<\/script>`;

// 2 — FLOATING FAMILIAR (bolder): a small companion that floats over the work, un-boxed.
const FLOATING = `${FAIL}<style>
.m{position:absolute;inset:0;background:var(--v2-bg);color:var(--v2-text);font-family:var(--font-body);overflow:hidden}
.grid{position:absolute;inset:40px;opacity:.5;display:flex;flex-direction:column;gap:12px}
.grid .lane{flex:1;border:1px solid var(--v2-line);border-radius:12px;background:var(--v2-surface)}
.familiar{position:absolute;right:70px;bottom:70px;width:200px;height:210px;filter:drop-shadow(0 18px 40px rgba(0,0,0,.6))}
#h2{position:absolute;inset:0}
.aura{position:absolute;inset:-40px;border-radius:50%;background:radial-gradient(circle,rgba(204,255,54,.22),transparent 68%);animation:breathe 4s ease-in-out infinite;pointer-events:none}
@keyframes breathe{0%,100%{transform:scale(.9);opacity:.7}50%{transform:scale(1.08);opacity:1}}
.bubble{position:absolute;right:250px;bottom:170px;background:var(--v2-surface-2);border:1px solid var(--v2-line);border-radius:14px 14px 4px 14px;padding:10px 14px;font-size:13px;color:var(--v2-text);box-shadow:var(--v2-shadow)}
.bubble b{color:var(--v2-accent)}
</style>
<div class="m">
 <div class="grid"><div class="lane"></div><div class="lane"></div><div class="lane"></div><div class="lane"></div></div>
 <div class="bubble">warmed the keys — <b>want it darker?</b></div>
 <div class="familiar"><div class="aura"></div><div id="h2"></div></div>
</div>
<script>${mount("h2", { personality: "BUBBLE", seed: 0.62, quality: "ps2", style: "toon", interactive: true }, "m.setState('LISTENING');m.set('mood',0.8);m.set('energy',0.5);" + energyLoop)}<\/script>`;

// 3 — WOVEN COMPOSER (elevate): Moshi IS the agent avatar, inside the prompt bar.
const WOVEN = `${FAIL}<style>
.m{position:absolute;inset:0;display:grid;place-items:center;background:var(--v2-bg);color:var(--v2-text);font-family:var(--font-body);padding:40px}
.wrap{width:min(760px,100%);display:flex;flex-direction:column;gap:14px}
.cap{text-align:center;font-family:var(--font-mono);font-size:11px;letter-spacing:.16em;color:var(--v2-accent);text-transform:uppercase}
.bar{display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:22px;border:1px solid var(--v2-line);background:linear-gradient(180deg,var(--v2-surface-2),var(--v2-surface));box-shadow:var(--v2-shadow)}
#h3{width:64px;height:64px;flex:none;border-radius:16px;overflow:hidden;background:radial-gradient(circle at 45% 40%,rgba(204,255,54,.12),transparent 70%);box-shadow:inset 0 0 0 1px rgba(204,255,54,.4)}
.field{flex:1}
.field .l{font-size:10px;letter-spacing:.16em;color:var(--v2-faint);text-transform:uppercase}
.field .t{font-size:17px;color:var(--v2-text)}
.go{width:42px;height:42px;border-radius:13px;border:0;background:var(--v2-accent);color:var(--v2-accent-ink);font-size:18px;font-weight:700}
.chips{display:flex;gap:8px;justify-content:center}
.chip{font-size:12px;padding:8px 13px;border-radius:999px;border:1px solid var(--v2-line);color:var(--v2-dim);background:var(--v2-surface)}
</style>
<div class="m"><div class="wrap">
 <div class="cap">● moshi is with you</div>
 <div class="bar"><div id="h3"></div>
  <div class="field"><div class="l">Prompt</div><div class="t">add a half-time break and swap the pad</div></div>
  <button class="go">↑</button></div>
 <div class="chips"><span class="chip">Finish this section</span><span class="chip">Re-imagine the drums</span><span class="chip">Write a hook</span></div>
</div></div>
<script>${mount("h3", { personality: "TAR", seed: 0.5, quality: "ps2+", style: "toon", interactive: false, resDiv: 1, maxW: 256, maxH: 256 }, "m.setState('LISTENING');m.set('mood',0.7);" + energyLoop)}<\/script>`;

// 4 — WARDROBE OF SONGS (elevate): invariant core, per-song COAT → library thumbnails.
const WARDROBE = `${FAIL}<style>
.m{position:absolute;inset:0;background:var(--v2-bg);color:var(--v2-text);font-family:var(--font-body);padding:44px;display:flex;flex-direction:column;gap:20px}
.title{font-family:var(--font-display);font-weight:800;font-size:22px}
.title span{color:var(--v2-dim);font-weight:400;font-size:14px}
.row{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;flex:1}
.song{border:1px solid var(--v2-line);border-radius:18px;background:var(--v2-surface);overflow:hidden;display:flex;flex-direction:column}
.thumb{flex:1;position:relative;background:var(--v2-ink)}
.thumb>div{position:absolute;inset:0}
.meta{padding:12px 14px;border-top:1px solid var(--v2-line)}
.meta b{font-size:14px}.meta span{display:block;font-size:11px;color:var(--v2-faint);font-family:var(--font-mono);margin-top:2px}
</style>
<div class="m">
 <div class="title">Your library <span>— same Moshi, wearing each song's coat</span></div>
 <div class="row">
  <div class="song"><div class="thumb"><div id="w1"></div></div><div class="meta"><b>midnight drive</b><span>122 · F min · dark</span></div></div>
  <div class="song"><div class="thumb"><div id="w2"></div></div><div class="meta"><b>sunroom</b><span>96 · C maj · warm</span></div></div>
  <div class="song"><div class="thumb"><div id="w3"></div></div><div class="meta"><b>rink</b><span>150 · A min · chrome</span></div></div>
 </div>
</div>
<script>
${mount("w1", { personality: "TAR", seed: 0.5, quality: "ps2", style: "ps2", interactive: false })}
${mount("w2", { personality: "MOLTEN", seed: 0.3, quality: "ps2", style: "baked", interactive: false })}
${mount("w3", { personality: "CHROME", seed: 0.8, quality: "ps2", style: "ps2", interactive: false })}
<\/script>`;

// 5 — BODY MORPH (bolder): the ALTERNATIVE — the body itself mutates with the song.
const MORPH = `${FAIL}<style>
.m{position:absolute;inset:0;background:var(--v2-bg);color:var(--v2-text);font-family:var(--font-body);padding:44px;display:flex;flex-direction:column;gap:18px}
.title{font-family:var(--font-display);font-weight:800;font-size:22px}
.title em{font-style:normal;color:#ff8a3d}
.sub{font-size:13px;color:var(--v2-dim);max-width:640px;line-height:1.5}
.row{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;flex:1}
.stage{position:relative;border:1px solid var(--v2-line);border-radius:18px;overflow:hidden;background:var(--v2-ink)}
.stage>div{position:absolute;inset:0}
.tag{position:absolute;left:12px;bottom:12px;z-index:2;font-family:var(--font-mono);font-size:10px;color:var(--v2-dim);background:rgba(8,9,12,.7);padding:4px 8px;border-radius:6px;border:1px solid var(--v2-line)}
</style>
<div class="m">
 <div class="title">Or — Moshi's <em>body itself</em> grows with the song</div>
 <div class="sub">The alternative to the coat: your decisions reshape the creature. Riskier (can he get ugly? does he stay "him"?) — but visceral. Compare it head-to-head.</div>
 <div class="row">
  <div class="stage"><div id="mo1"></div><div class="tag">bar 1 · sparse</div></div>
  <div class="stage"><div id="mo2"></div><div class="tag">bar 32 · dense</div></div>
  <div class="stage"><div id="mo3"></div><div class="tag">final · maxed</div></div>
 </div>
</div>
<script>
${mount("mo1", { personality: "SILK", seed: 0.4, quality: "ps2", style: "toon", interactive: false }, "m.set('energy',0.15);m.set('mood',0.5);")}
${mount("mo2", { personality: "GHOST", seed: 0.55, quality: "ps2", style: "toon", interactive: false }, "m.set('energy',0.6);m.set('mood',0.7);m.setAnatomy&&m.setAnatomy('B');")}
${mount("mo3", { personality: "BREAKS", seed: 0.9, quality: "ps2", style: "ps2", interactive: false }, "m.set('energy',1);m.set('heat',0.8);m.setAnatomy&&m.setAnatomy('C');")}
<\/script>`;

// 6 — AMBIENT STAGE (bolder, stage): the song's coat tints the whole surface; Moshi small.
const STAGE = `${FAIL}<style>
.m{position:absolute;inset:0;overflow:hidden;color:var(--v2-text);font-family:var(--font-body);background:#05060a}
.aura{position:absolute;inset:-15%;z-index:0;filter:blur(70px);opacity:.7;background:
 radial-gradient(40% 50% at 25% 30%,rgba(204,255,54,.4),transparent 60%),
 radial-gradient(45% 55% at 78% 26%,rgba(80,120,255,.35),transparent 60%),
 radial-gradient(50% 60% at 55% 88%,rgba(255,90,160,.3),transparent 60%);animation:drift 16s ease-in-out infinite alternate}
@keyframes drift{from{transform:translate(-3%,-2%) scale(1)}to{transform:translate(4%,3%) scale(1.12)}}
.frame{position:absolute;inset:34px;z-index:1;border:1px solid rgba(255,255,255,.12);border-radius:20px;background:rgba(10,12,18,.4);backdrop-filter:blur(26px);display:grid;grid-template-rows:auto 1fr;overflow:hidden}
.top{display:flex;align-items:center;gap:14px;padding:14px 20px;border-bottom:1px solid rgba(255,255,255,.1)}
.brand{font-family:var(--font-display);font-weight:800;font-size:16px}.brand em{font-style:normal;color:var(--v2-accent)}
.dial{margin-left:auto;display:flex;align-items:center;gap:8px;font-family:var(--font-mono);font-size:10px;color:rgba(255,255,255,.6)}
.dial .bar{width:90px;height:5px;border-radius:3px;background:rgba(255,255,255,.15);overflow:hidden}.dial .fill{height:100%;width:62%;background:var(--v2-accent)}
.lanes{padding:24px;display:flex;flex-direction:column;gap:12px}
.lanes .lane{flex:1;border:1px solid rgba(255,255,255,.1);border-radius:12px;background:rgba(255,255,255,.03)}
.corner{position:absolute;right:56px;bottom:56px;z-index:2;width:120px;height:126px;filter:drop-shadow(0 12px 30px rgba(0,0,0,.6))}
#h6{position:absolute;inset:0}
</style>
<div class="m">
 <div class="aura"></div>
 <div class="frame">
  <div class="top"><div class="brand">MOSH<em>·</em></div>
   <div class="dial">AMBIENCE<span class="bar"><span class="fill"></span></span>full</div></div>
  <div class="lanes"><div class="lane"></div><div class="lane"></div><div class="lane"></div><div class="lane"></div></div>
 </div>
 <div class="corner"><div id="h6"></div></div>
</div>
<script>${mount("h6", { personality: "DISCO", seed: 0.5, quality: "ps2", style: "toon", interactive: true }, "m.setState('LISTENING');m.set('mood',0.8);" + energyLoop)}<\/script>`;

export const MOSHI_SEEDS: Candidate[] = [
  { id: "seed-moshi-dock", title: "Dock Companion", target: "moshi", pass: "elevate", kind: "html", model: "opus-insession", theme: "dark", usesMoshi: true, source: DOCK, createdAt: 0, notes: "today's right-rail presence, made premium — invariant core in place" },
  { id: "seed-moshi-float", title: "Floating Familiar", target: "moshi", pass: "bolder", kind: "html", model: "opus-insession", theme: "dark", usesMoshi: true, source: FLOATING, createdAt: 0, notes: "un-boxed: a small companion that floats over the work + speaks" },
  { id: "seed-moshi-woven", title: "Woven Composer", target: "moshi", pass: "elevate", kind: "html", model: "opus-insession", theme: "dark", usesMoshi: true, source: WOVEN, createdAt: 0, notes: "Moshi IS the agent avatar, living inside the prompt bar" },
  { id: "seed-moshi-wardrobe", title: "Wardrobe of Songs", target: "moshi", pass: "elevate", kind: "html", model: "opus-insession", theme: "dark", usesMoshi: true, source: WARDROBE, createdAt: 0, notes: "invariant core + per-song coat → library thumbnails (3 real creatures)" },
  { id: "seed-moshi-morph", title: "Body Morph", target: "moshi", pass: "bolder", kind: "html", model: "opus-insession", theme: "dark", usesMoshi: true, source: MORPH, createdAt: 0, notes: "the alternative you're torn about: the body itself mutates with the song" },
  { id: "seed-stage-ambient", title: "Ambient Stage", target: "stage", pass: "bolder", kind: "html", model: "opus-insession", theme: "dark", usesMoshi: true, source: STAGE, createdAt: 0, notes: "the song's coat tints the whole surface; intensity dial; Moshi small in the corner" },
];
