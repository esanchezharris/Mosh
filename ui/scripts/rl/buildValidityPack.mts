// Reward-VALIDITY + PREFERENCE pack (the frontier panel's unanimous #1).
//
// Does the deterministic recipe verifier actually track the owner's taste? We never re-ran the
// blind probe on it (we did on the audio reward → ρ≈0). This builds the experiment: generate beats
// spanning a verifier-score spread (GEPA-optimized ≈0.99, plain ≈0.85, degraded ≈0.4–0.7), RENDER
// each to audio, and present a BLIND 1–7 + A/B rating page that records each clip's verifier score.
// Owner rates → analyzeValidity computes ρ(rating, verifier) + the decisive auto-vs-degraded check
// + preference pairs (to train a Bradley-Terry taste model). Verifier-high must = owner-likes, or it's
// a competence gate only (panel's point) and we learn taste from the prefs instead.
//
//   AUDITION_CLOUD=1 npx tsx scripts/rl/buildValidityPack.mts --out ~/mosh-validity --per 2

import { writeFileSync, mkdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { __resetMockForTests, mockExecute } from "../../src/bridge.mock";
import { buildRecipe, type BrainFn, type Note } from "../../src/agent/beatBuilder";
import { BEAT_SPECS } from "../../src/agent/beatSpecs";
import { verifyRecipe, type Recipe } from "../../src/agent/recipeVerifier";
import { OPTIMIZED_DIRECTIVE } from "../../src/agent/beatDirective";
import type { CommandResult } from "../../src/types";

const arg = (k: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const OUT = arg("out", join(process.env.HOME!, "mosh-validity"));
const PER = parseInt(arg("per", "2"), 10);          // seeds per (genre, tier)
const MOSH_BIN = process.env.MOSH_BIN ?? "/Applications/Mosh.app/Contents/MacOS/Mosh";
const CONC = parseInt(arg("conc", "5"), 10);

// provider-aware brain (GPT 5.4 mini when keyed) — mirrors the other rl scripts
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "", GKEY = process.env.GEMINI_API_KEY ?? "";
const PROVIDER = (process.env.MOSH_BRAIN_PROVIDER || (OPENAI_KEY ? "openai" : "gemini")).toLowerCase();
const MODEL = PROVIDER === "openai" ? (process.env.OPENAI_MODEL || "gpt-5.4-mini") : (process.env.MOSH_AGENT_MODEL || "gemini-2.5-flash");
const REASONING = PROVIDER === "openai" && /^(gpt-5|gpt-6|o[0-9])/.test(MODEL);
const ENDPOINT = PROVIDER === "openai" ? `${process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"}/chat/completions` : "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
function makeBrain(temp: number): BrainFn {
  return async (messages, opts) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${PROVIDER === "openai" ? OPENAI_KEY : GKEY}` };
    const body: Record<string, unknown> = { model: MODEL, messages };
    if (PROVIDER === "openai") { if (REASONING) { body.max_completion_tokens = 2048; body.reasoning_effort = process.env.OPENAI_REASONING_EFFORT || "low"; } else { body.max_tokens = 2048; body.temperature = temp; } }
    else { body.max_tokens = 2048; body.temperature = temp; body.extra_body = { google: { thinking_config: { thinking_budget: 0 } } }; }
    if (opts.json) body.response_format = { type: "json_object" };
    const r = await fetch(ENDPOINT, { method: "POST", headers, body: JSON.stringify(body) });
    return (await r.json())?.choices?.[0]?.message?.content ?? "";
  };
}

const clone = (r: Recipe): Recipe => JSON.parse(JSON.stringify(r));
// degradations are AUDIBLE but in-time/in-structure (test taste, not brokenness)
function flattenVel(r: Recipe): Recipe { const c = clone(r); for (const t of c.tracks) for (const n of t.notes) n.velocity = 100; return c; }        // robotic
function cloneBar2(r: Recipe): Recipe { const c = clone(r); for (const t of c.tracks) { const b1 = t.notes.filter((n) => n.start < 4); t.notes = [...b1, ...b1.map((n) => ({ ...n, start: n.start + 4 }))]; } return c; } // no development

type Cand = { id: string; genre: string; tier: string; recipe: Recipe; score: number };

async function pool<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (true) { const i = next++; if (i >= items.length) break; out[i] = await fn(items[i], i); } }));
  return out;
}

/** recipe → native run-script lines (create_track/add_midi_clip/add_note with capture+${ref}) + export_audio */
function renderRecipe(r: Recipe, wav: string, session: string): boolean {
  const lines: any[] = [{ command: "set_tempo", args: { bpm: r.tempo } }];
  let v = 0;
  for (const t of r.tracks) {
    if (!t.notes.length) continue;
    const tv = `v${v++}`, cv = `v${v++}`;
    const len = Math.ceil(Math.max(...t.notes.map((n) => n.start + n.length)));
    lines.push({ command: "create_track", args: { name: t.name, type: t.role === "drums" ? "drum" : "instrument" }, capture: { [tv]: "trackId" } });
    lines.push({ command: "add_midi_clip", args: { trackId: `\${${tv}}`, start: 0, length: len }, capture: { [cv]: "clipId" } });
    for (const n of t.notes) lines.push({ command: "add_note", args: { clipId: `\${${cv}}`, pitch: n.pitch, start: n.start, length: n.length, velocity: n.velocity } });
  }
  lines.push({ command: "export_audio", args: { file: wav, format: "wav", bitDepth: 16 } });
  const sf = wav.replace(/\.wav$/, ".script.jsonl");
  writeFileSync(sf, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  spawnSync(MOSH_BIN, ["--run-script"], { env: { ...process.env, MOSH_RUN_SCRIPT: sf, MOSH_SELFTEST_SESSION: session }, encoding: "utf8", timeout: 180000 });
  try { return statSync(wav).size > 44 * 1024; } catch { return false; }  // Mosh can exit non-0 yet write the WAV → trust the file
}

async function main() {
  mkdirSync(join(OUT, "clips"), { recursive: true });
  const cands: Cand[] = [];
  // generate base recipes (optimized + plain) per genre×seed, then derive degraded tiers from plain
  const jobs = BEAT_SPECS.flatMap((s) => Array.from({ length: PER }, (_, i) => ({ spec: s, seed: i })));
  const gens = await pool(jobs, CONC, async ({ spec, seed }) => {
    const opt = await buildRecipe(spec, makeBrain(0.7), { maxRetries: 1, refineTempo: false, extraSystem: OPTIMIZED_DIRECTIVE });
    const plain = await buildRecipe(spec, makeBrain(0.8), { maxRetries: 1, refineTempo: false });
    const toR = (b: any): Recipe => ({ tempo: b.tempo, key: b.key, bars: b.bars, tracks: b.tracks });
    return { spec, seed, opt: toR(opt), plain: toR(plain) };
  });
  for (const g of gens) {
    const tiers: [string, Recipe][] = [
      ["optimized", g.opt],
      ["plain", g.plain],
      ["flat", flattenVel(g.plain)],
      ["flat_clone", cloneBar2(flattenVel(g.plain))],
    ];
    for (const [tier, recipe] of tiers) cands.push({ id: `${g.spec.id}_${g.seed}_${tier}`, genre: g.spec.id, tier, recipe, score: verifyRecipe(recipe).total });
  }

  // shuffle deterministically (no Math.random in this env) by score-hash so the pack is blind
  cands.sort((a, b) => (a.id.length * 31 + a.id.charCodeAt(2)) - (b.id.length * 31 + b.id.charCodeAt(2)));

  const mapping: any[] = [];
  let ok = 0;
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    const idx = String(i + 1).padStart(3, "0");
    const rendered = renderRecipe(c.recipe, join(OUT, "clips", `${idx}.wav`), `validity_${idx}`);
    if (rendered) ok++;
    mapping.push({ index: idx, rendered, cand_id: c.id, genre: c.genre, tier: c.tier, verifier: +c.score.toFixed(4), dims: verifyRecipe(c.recipe).dims });
    console.log(`  ${idx} ${c.tier.padEnd(11)} verifier ${c.score.toFixed(3)} render ${rendered ? "OK" : "FAIL"}`);
  }
  writeFileSync(join(OUT, ".mapping.json"), JSON.stringify({ n: cands.length, mapping }, null, 1));
  // A/B pairs spanning tiers (optimized-vs-flat, plain-vs-flat_clone, optimized-vs-plain)
  const byTier = (t: string) => mapping.filter((m) => m.tier === t).map((m) => m.index);
  const pairs: [string, string][] = [];
  const O = byTier("optimized"), P = byTier("plain"), F = byTier("flat"), FC = byTier("flat_clone");
  for (let i = 0; i < Math.min(O.length, F.length); i++) pairs.push([O[i], F[i]]);
  for (let i = 0; i < Math.min(P.length, FC.length); i++) pairs.push([P[i], FC[i]]);
  for (let i = 0; i < Math.min(O.length, P.length); i++) pairs.push([O[i], P[i]]);
  writeFileSync(join(OUT, ".ab.json"), JSON.stringify(pairs, null, 1));
  writeFileSync(join(OUT, "index.html"), html(cands.length, pairs));
  console.log(`\n${ok}/${cands.length} rendered → ${OUT}  | ${pairs.length} A/B pairs | open ${join(OUT, "index.html")}`);
  console.log(`verifier spread: ${mapping.map((m) => m.verifier).sort((a, b) => a - b).map((x) => x.toFixed(2)).join(" ")}`);
}

function html(n: number, pairs: [string, string][]): string {
  return `<!doctype html><meta charset=utf8><title>Mosh validity pack</title>
<style>body{font:15px system-ui;max-width:760px;margin:24px auto;padding:0 16px}.c{border:1px solid #ccc;border-radius:8px;padding:10px 14px;margin:8px 0}button{font:14px system-ui;padding:6px 12px;margin:2px;cursor:pointer}.r button.sel{background:#2a6;color:#fff}h2{margin-top:28px}</style>
<h1>Mosh — reward validity pack</h1><p>Rate each beat 1–7 (gut reaction), then pick a winner in each A/B. Blind. <b>Download CSV</b> at the bottom and send both files back.</p>
<div id=clips></div><h2>A/B pairs</h2><div id=ab></div>
<p><button onclick=dl()>⬇ Download RATINGS.csv</button> <button onclick=dlab()>⬇ Download AB.csv</button></p>
<script>
const N=${n}, PAIRS=${JSON.stringify(pairs)};
const KEY="moshvalidity";
const st=JSON.parse(localStorage.getItem(KEY)||"{}"); st.r=st.r||{}; st.ab=st.ab||{};
function save(){localStorage.setItem(KEY,JSON.stringify(st))}
function mkAudio(idx){const a=document.createElement("audio");a.controls=true;fetch("clips/"+idx+".wav").then(r=>r.blob()).then(b=>a.src=URL.createObjectURL(b));return a}
const cd=document.getElementById("clips");
for(let i=1;i<=N;i++){const idx=String(i).padStart(3,"0");const d=document.createElement("div");d.className="c";
 d.innerHTML="<b>"+idx+"</b> ";d.appendChild(mkAudio(idx));const row=document.createElement("div");row.className="r";
 for(let v=1;v<=7;v++){const b=document.createElement("button");b.textContent=v;if(st.r[idx]==v)b.className="sel";
  b.onclick=()=>{st.r[idx]=v;save();[...row.children].forEach(x=>x.className="");b.className="sel"};row.appendChild(b)}
 d.appendChild(row);cd.appendChild(d)}
const ad=document.getElementById("ab");
PAIRS.forEach((p,i)=>{const d=document.createElement("div");d.className="c";d.innerHTML="<b>Pair "+(i+1)+"</b>";
 const wrap=document.createElement("div");["A","B"].forEach((lab,k)=>{const s=document.createElement("div");s.textContent=lab;s.appendChild(mkAudio(p[k]));wrap.appendChild(s)});d.appendChild(wrap);
 const row=document.createElement("div");row.className="r";["A","B"].forEach(lab=>{const b=document.createElement("button");b.textContent="Prefer "+lab;if(st.ab[i]==lab)b.className="sel";
  b.onclick=()=>{st.ab[i]=lab;save();[...row.children].forEach(x=>x.className="");b.className="sel"};row.appendChild(b)});d.appendChild(row);ad.appendChild(d)})
function dl(){let c="index,rating\\n";for(let i=1;i<=N;i++){const idx=String(i).padStart(3,"0");c+=idx+","+(st.r[idx]||"")+"\\n"}download("RATINGS.csv",c)}
function dlab(){let c="pair,A,B,winner\\n";PAIRS.forEach((p,i)=>{c+=(i+1)+","+p[0]+","+p[1]+","+(st.ab[i]||"")+"\\n"});download("AB.csv",c)}
function download(name,txt){const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([txt]));a.download=name;a.click()}
</script>`;
}
main();
