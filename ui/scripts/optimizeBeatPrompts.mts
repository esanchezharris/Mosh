// ── GEPA-style optimizer: evolve the beat-build directive against the recipe verifier ─
// The terrarium loop, deterministic-reward edition. A CANDIDATE is a short "directive"
// appended to the beat-build note-system prompt (buildBeat's extraSystem). The eval_fn is
// the hardened recipeVerifier (no audio, no GPU). Each round: evaluate the best directive
// over genres×seeds, collect the verifier's NAMED flaws, ask the reflection model to
// rewrite the directive to fix them (K diverse proposals), evaluate all, keep the best.
//
// SCALING (the bet: more candidates × more eval × more rounds → better prompts → better
// beats, like scaling LLMs): --candidates K  --seeds M  --rounds R  --genres a,b,c.
//
//   AUDITION_CLOUD=1 npm run tsx scripts/optimizeBeatPrompts.mts -- --rounds 4 --candidates 4 --seeds 2

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildRecipe, type BrainFn } from "../src/agent/beatBuilder";
import { BEAT_SPECS, beatSpecById } from "../src/agent/beatSpecs";
import { verifyRecipe, type Recipe, type Verdict } from "../src/agent/recipeVerifier";

const arg = (k: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const ROUNDS = parseInt(arg("rounds", "4"), 10);
const K = parseInt(arg("candidates", "4"), 10);
const SEEDS = parseInt(arg("seeds", "2"), 10);
const CONC = parseInt(arg("conc", "6"), 10);
const GENRES = (arg("genres", "") || BEAT_SPECS.map((s) => s.id).join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const OUT = arg("out", "/private/tmp/claude-501/beat-gepa");
const CLOUD = process.argv.includes("--cloud") || process.env.AUDITION_CLOUD === "1";
const PORT = process.env.AUDITION_PORT ?? "8081";
// Provider-agnostic brain. GPT 5.4 mini (the owner's chosen brain) the moment an OPENAI_API_KEY
// exists; else Gemini (the currently-keyed cloud brain); else the local mlx server. The whole
// loop is brain-agnostic — dropping OPENAI_API_KEY into the env switches it to gpt-5.4-mini, no
// code change. Override with MOSH_BRAIN_PROVIDER=openai|gemini.
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const GKEY = process.env.GEMINI_API_KEY ?? "";
const PROVIDER = !CLOUD ? "local" : (process.env.MOSH_BRAIN_PROVIDER || (OPENAI_KEY ? "openai" : "gemini")).toLowerCase();
const OPENAI_BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const MODEL = PROVIDER === "openai" ? (process.env.OPENAI_MODEL || "gpt-5.4-mini") : (process.env.MOSH_AGENT_MODEL || "gemini-2.5-flash");
const REASONING = PROVIDER === "openai" && /^(gpt-5|gpt-6|o[0-9])/.test(MODEL);
const ENDPOINT = PROVIDER === "openai" ? `${OPENAI_BASE}/chat/completions`
  : PROVIDER === "gemini" ? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
  : `http://127.0.0.1:${PORT}/v1/chat/completions`;
console.log(`brain: provider=${PROVIDER}${PROVIDER !== "local" ? ` model=${MODEL}` : ""}`);

// brain factory bound to a temperature (so concurrent builds don't race a shared temp)
function makeBrain(temp: number): BrainFn {
  return async (messages, opts) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const body: Record<string, unknown> = { messages, model: MODEL };
    if (PROVIDER === "openai") {
      headers["Authorization"] = `Bearer ${OPENAI_KEY}`;
      if (REASONING) body.max_completion_tokens = 2048; else { body.max_tokens = 2048; body.temperature = temp; }  // gpt-5 family: no custom temp, max_completion_tokens
    } else if (PROVIDER === "gemini") {
      headers["Authorization"] = `Bearer ${GKEY}`;
      body.max_tokens = 2048; body.temperature = temp;
      body.extra_body = { google: { thinking_config: { thinking_budget: 0 } } };
    } else { body.max_tokens = 2048; body.temperature = temp; }  // local mlx server
    if (opts.json) body.response_format = { type: "json_object" };
    const r = await fetch(ENDPOINT, { method: "POST", headers, body: JSON.stringify(body) });
    const j = await r.json();
    return j.choices?.[0]?.message?.content ?? "";
  };
}
const reflectBrain = makeBrain(1.0);

// simple concurrency pool (cap concurrent beat-builds → friendly to rate limits)
async function pool<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) { const i = next++; if (i >= items.length) break; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// uniform deployment temperature (overridable) — beat quality is very temp-sensitive, so
// eval/optimize in the regime we'd ship rather than averaging in garbage from hot seeds
const TEMP = parseFloat(arg("temp", "0.6"));
const SEED_TEMPS = Array.from({ length: 8 }, () => TEMP);

let TEMP_OVERRIDE: number | null = null; // set by the sweep
async function buildAndScore(specId: string, directive: string, seed: number): Promise<Verdict> {
  const spec = beatSpecById(specId)!;
  // mock-free build → parallel-safe (no shared bridge.mock state). buildRecipe returns the
  // note content directly with verifier-ready roles, so we hand it straight to verifyRecipe.
  const r = await buildRecipe(spec, makeBrain(TEMP_OVERRIDE ?? SEED_TEMPS[seed % SEED_TEMPS.length]), { maxRetries: 1, refineTempo: false, extraSystem: directive });
  const recipe: Recipe = { tempo: r.tempo, key: r.key, bars: r.bars, tracks: r.tracks };
  return verifyRecipe(recipe);
}

type Eval = { directive: string; mean: number; dims: Record<string, number>; flaws: { reason: string; n: number }[]; totals: number[] };

const std = (xs: number[]) => { if (xs.length < 2) return 0; const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };

async function evalDirective(directive: string, nSeeds = SEEDS): Promise<Eval> {
  const jobs = GENRES.flatMap((g) => Array.from({ length: nSeeds }, (_, s) => ({ g, s })));
  const verdicts = await pool(jobs, CONC, ({ g, s }) => buildAndScore(g, directive, s));
  const totals = verdicts.map((v) => v.total);
  const mean = verdicts.reduce((a, v) => a + v.total, 0) / verdicts.length;
  const dimKeys = Object.keys(verdicts[0].dims);
  const dims: Record<string, number> = {};
  for (const k of dimKeys) dims[k] = verdicts.reduce((a, v) => a + (v.dims as any)[k], 0) / verdicts.length;
  const freq = new Map<string, number>();
  for (const v of verdicts) for (const r of v.reasons) { const key = r.split("(")[0].trim(); freq.set(key, (freq.get(key) ?? 0) + 1); }
  const flaws = [...freq.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n);
  return { directive, mean, dims, flaws, totals };
}

const RUBRIC = [
  "The verifier rewards (each 0..1, and dynamics·variation·contour are MULTIPLICATIVE gates):",
  "- dynamics: velocity RANGE per part (accents + ghost notes; NOT all one velocity)",
  "- variation: bar 2 must DEVELOP, not be a clone of bar 1 (vary pitches/rhythm across bars)",
  "- contour: melodies use ≥3 pitch CLASSES, stepwise motion (small intervals, not octave leaps), and many rhythmic onsets (not one held chord)",
  "- drums: kick anchors beat 1 but is NOT on every slot; snare on beats 2&4 with NO kick on the same beat; hats ~8/bar (not 16)",
  "- key: every melodic note in the given key; grid: notes on the 16th grid",
].join("\n");

async function reflect(directive: string, ev: Eval, variant: number): Promise<string> {
  const flaws = ev.flaws.slice(0, 6).map((f) => `- ${f.reason} (in ${f.n} parts)`).join("\n") || "- (few explicit flaws; push the weakest dimensions higher)";
  const weak = Object.entries(ev.dims).sort((a, b) => a[1] - b[1]).slice(0, 4).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ");
  const sys = "You tune a short DIRECTIVE appended to a beat-making AI's note-writing instructions. Output ONLY the new directive text (concise imperative bullet points, ≤10 lines), nothing else.";
  const user = [
    `Current directive:\n${directive || "(none)"}`,
    `\nWith it, beats scored mean ${ev.mean.toFixed(3)} on a deterministic music verifier. Weakest dims: ${weak}.`,
    `Most common flaws:\n${flaws}`,
    `\n${RUBRIC}`,
    `\nRewrite the directive to FIX these flaws and raise the score. Be specific and musical (e.g. exact velocity ranges, "make bar 2 differ", "never place a kick on beats 2 or 4"). ${variant % 2 ? "Be aggressive and rethink the approach." : "Refine the current directive."} Output ONLY the directive.`,
  ].join("\n");
  const raw = await reflectBrain([{ role: "system", content: sys }, { role: "user", content: user }], { json: false });
  return raw.replace(/^```[a-z]*\n?/i, "").replace(/```$/i, "").trim().slice(0, 1200);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  // --sweep → find the deployment temperature: eval baseline at several temps and exit
  if (process.argv.includes("--sweep")) {
    console.log(`temperature sweep (${GENRES.length * SEEDS} beats each):`);
    for (const t of [0.4, 0.55, 0.7, 0.85, 1.0]) {
      TEMP_OVERRIDE = t;
      const e = await evalDirective("");
      console.log(`temp ${t.toFixed(2)}: mean ${e.mean.toFixed(4)}  ${Object.entries(e.dims).map(([k, v]) => `${k.slice(0, 3)} ${v.toFixed(2)}`).join(" ")}`);
    }
    return;
  }
  // --directive "<text>" → mechanism probe: eval baseline vs the given directive and exit
  const probe = arg("directive", "");
  if (process.argv.includes("--directive")) {
    console.log(`mechanism probe (${GENRES.length * SEEDS} beats each):`);
    const base = await evalDirective("");
    const cand = await evalDirective(probe);
    const d = (e: Eval) => Object.entries(e.dims).map(([k, v]) => `${k.slice(0, 3)} ${v.toFixed(2)}`).join(" ");
    console.log(`baseline   ${base.mean.toFixed(4)}  ${d(base)}`);
    console.log(`directive  ${cand.mean.toFixed(4)}  ${d(cand)}`);
    console.log(`Δ ${(cand.mean - base.mean >= 0 ? "+" : "")}${(cand.mean - base.mean).toFixed(4)} → mechanism ${cand.mean > base.mean + 0.01 ? "WORKS (directive moves the score)" : "weak/no effect"}`);
    return;
  }
  console.log(`GEPA beat-prompt optimizer: rounds=${ROUNDS} candidates=${K} seeds=${SEEDS} genres=${GENRES.join(",")} (${GENRES.length * SEEDS} beats/eval)\n`);
  let best = await evalDirective("");
  const trajectory: { round: number; mean: number; adopted: boolean }[] = [{ round: 0, mean: best.mean, adopted: true }];
  console.log(`round 0 (baseline, no directive): mean ${best.mean.toFixed(4)}  dims ${Object.entries(best.dims).map(([k, v]) => `${k.slice(0, 3)} ${v.toFixed(2)}`).join(" ")}`);

  for (let round = 1; round <= ROUNDS; round++) {
    const proposals = await Promise.all(Array.from({ length: K }, (_, v) => reflect(best.directive, best, v)));
    const evals = await pool(proposals, Math.max(1, Math.floor(CONC / 2)), (d) => evalDirective(d));
    const top = evals.reduce((a, b) => (b.mean > a.mean ? b : a));
    const adopted = top.mean > best.mean;
    console.log(`round ${round}: best candidate ${top.mean.toFixed(4)} (current ${best.mean.toFixed(4)}) → ${adopted ? "ADOPT" : "keep"}  [${evals.map((e) => e.mean.toFixed(3)).join(", ")}]`);
    if (adopted) best = top;
    trajectory.push({ round, mean: best.mean, adopted });
  }

  // honest two-sided held-out confirmation: re-eval BOTH baseline ("") and the optimized
  // directive on a LARGER fresh sample, so the reported Δ isn't seed-luck on one side only.
  const CONFIRM_SEEDS = parseInt(arg("confirm-seeds", String(SEEDS * 2)), 10);
  const baseC = await evalDirective("", CONFIRM_SEEDS);
  const bestC = await evalDirective(best.directive, CONFIRM_SEEDS);
  const fmt = (e: Eval) => `${e.mean.toFixed(4)} ±${std(e.totals).toFixed(3)}`;
  const dlt = bestC.mean - baseC.mean;
  console.log(`\nFINAL (held-out, n=${CONFIRM_SEEDS * GENRES.length} each side): baseline ${fmt(baseC)} → optimized ${fmt(bestC)}  Δ${dlt >= 0 ? "+" : ""}${dlt.toFixed(4)}`);
  console.log(`dims (optimized): ${Object.entries(bestC.dims).map(([k, v]) => `${k} ${v.toFixed(2)}`).join("  ")}`);
  console.log(`\n── optimized directive ──\n${best.directive}\n`);
  writeFileSync(join(OUT, "result.json"), JSON.stringify({
    baselineTrain: trajectory[0].mean, optimizedTrain: best.mean,
    baselineConfirm: baseC.mean, optimizedConfirm: bestC.mean,
    baselineStd: std(baseC.totals), optimizedStd: std(bestC.totals), delta: dlt,
    directive: best.directive, dims: bestC.dims, trajectory, config: { ROUNDS, K, SEEDS, CONFIRM_SEEDS, GENRES },
  }, null, 1));
  console.log(`→ ${join(OUT, "result.json")}`);
}

main();
