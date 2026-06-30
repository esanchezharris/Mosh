// ── GRPO-readiness proof: the recipe reward gives a VALID, non-zero gradient on REAL rollouts ─
// For one prompt, draw K independent beat-build rollouts from the real cloud brain (the policy's
// sampling distribution) under two directives — baseline ("") vs the GEPA-OPTIMIZED_DIRECTIVE —
// and score each rollout's DNA with the deterministic verifier (no render). Report the reward
// distribution + GRPO-style advantages (reward − group mean). This is the analog of the audio
// proveGradient, but the reward is the VALID deterministic verifier (probe showed audio pull ρ≈0).
//
// Non-zero std ⇒ non-zero advantages ⇒ the GRPO gradient EXISTS. optimized-mean > baseline-mean
// ⇒ the policy improvement GEPA found on the prompt generalizes to fresh rollouts.
//
//   AUDITION_CLOUD=1 npx tsx scripts/recipeRewardGradient.mts -- --genre dark_trap --k 6

import { buildRecipe, type BrainFn } from "../src/agent/beatBuilder";
import { beatSpecById } from "../src/agent/beatSpecs";
import { verifyRecipe, type Recipe } from "../src/agent/recipeVerifier";
import { OPTIMIZED_DIRECTIVE } from "../src/agent/beatDirective";

const arg = (k: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const GENRE = arg("genre", "dark_trap");
const K = parseInt(arg("k", "6"), 10);
const TEMP = parseFloat(arg("temp", "0.7"));
const CLOUD = process.argv.includes("--cloud") || process.env.AUDITION_CLOUD === "1";
const PORT = process.env.AUDITION_PORT ?? "8081";
const GKEY = process.env.GEMINI_API_KEY ?? "";
const CLOUD_MODEL = process.env.MOSH_AGENT_MODEL ?? "gemini-2.5-flash";
const ENDPOINT = CLOUD ? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions" : `http://127.0.0.1:${PORT}/v1/chat/completions`;

const brain: BrainFn = async (messages, opts) => {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const body: Record<string, unknown> = { messages, max_tokens: 2048, temperature: TEMP };
  if (CLOUD) { headers["Authorization"] = `Bearer ${GKEY}`; body.model = CLOUD_MODEL; body.extra_body = { google: { thinking_config: { thinking_budget: 0 } } }; if (opts.json) body.response_format = { type: "json_object" }; }
  const r = await fetch(ENDPOINT, { method: "POST", headers, body: JSON.stringify(body) });
  const j = await r.json();
  return j.choices?.[0]?.message?.content ?? "";
};

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };

async function rollouts(directive: string): Promise<number[]> {
  const spec = beatSpecById(GENRE)!;
  const out: number[] = [];
  for (let i = 0; i < K; i++) {
    const r = await buildRecipe(spec, brain, { maxRetries: 1, refineTempo: false, extraSystem: directive });
    const recipe: Recipe = { tempo: r.tempo, key: r.key, bars: r.bars, tracks: r.tracks };
    out.push(verifyRecipe(recipe).total);
  }
  return out;
}

async function main() {
  console.log(`recipe-reward gradient: genre=${GENRE} K=${K} temp=${TEMP} (real ${CLOUD ? "cloud" : "local"} rollouts)\n`);
  const base = await rollouts("");
  const opt = await rollouts(OPTIMIZED_DIRECTIVE);
  const report = (name: string, xs: number[]) => {
    const m = mean(xs), s = std(xs);
    const adv = xs.map((x) => +(x - m).toFixed(3));
    console.log(`${name.padEnd(10)} mean ${m.toFixed(3)} std ${s.toFixed(3)}  min ${Math.min(...xs).toFixed(3)} max ${Math.max(...xs).toFixed(3)}`);
    console.log(`           rewards    [${xs.map((x) => x.toFixed(3)).join(", ")}]`);
    console.log(`           advantages [${adv.join(", ")}]`);
    return { mean: m, std: s };
  };
  const b = report("baseline", base);
  const o = report("optimized", opt);
  const gradientOk = b.std > 1e-6 && o.std > 1e-6;
  console.log(`\nGRADIENT: baseline std ${b.std.toFixed(3)}, optimized std ${o.std.toFixed(3)} → ${gradientOk ? "NON-ZERO (usable GRPO advantages)" : "FLAT (no gradient)"}`);
  console.log(`POLICY GAIN (fresh rollouts): optimized mean ${o.mean.toFixed(3)} − baseline ${b.mean.toFixed(3)} = ${(o.mean - b.mean >= 0 ? "+" : "")}${(o.mean - b.mean).toFixed(3)}`);
}

main();
