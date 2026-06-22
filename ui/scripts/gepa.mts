// GEPA rung-1 driver — optimize Moshi's RULES block against the verifier reward.
//
//   cd ui && npm run gepa                              (griffin fixture, OpenAI, 2 rounds)
//   cd ui && npm run gepa -- --rounds 3 --max 12 ~/mosh-demo-projects/rpp/foo.rpp
//
// Builds a SYNTHETIC eval set by slicing importer programs (real .rpp/.als) into
// gradeable tasks, then runs the reflective optimizer (src/gepa) with REAL
// OpenAI-compatible calls for both the brain-under-test and the reflection LM.
// Writes the optimized rules + an honest baseline-vs-optimized report to a
// gitignored dir. No keys → prints how to add one and exits. Cost is metered LLM
// calls (bounded by --rounds × eval-set size); keep the defaults small.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { importPath } from "../src/import/importFile";
import { emitCommands } from "../src/import/emit";
import { sliceProgram, type EvalExample } from "../src/gepa/evalset";
import { optimizeRules } from "../src/gepa/optimize";
import { DEFAULT_RULES } from "../src/agent/brainCore";
import type { ChatMessage } from "../src/harvest/genTurns";

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  const path = resolve(process.cwd(), ".env.local");
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const i = s.indexOf("=");
      if (i < 0) continue;
      const k = s.slice(0, i).trim();
      let v = s.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, "").trim();
      if (k && !env[k]) env[k] = v;
    }
  }
  return env;
}
const flag = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };

const env = loadEnv();
const DEFAULTS: Record<string, { url: string; model: string; keyVar: string }> = {
  openai: { url: env.OPENAI_BASE_URL || "https://api.openai.com/v1", model: env.OPENAI_MODEL || "gpt-5.4-mini", keyVar: "OPENAI_API_KEY" },
  deepseek: { url: env.DEEPSEEK_BASE_URL || "https://api.deepseek.com", model: env.DEEPSEEK_MODEL || "deepseek-v4-flash", keyVar: "DEEPSEEK_API_KEY" },
  xai: { url: env.XAI_BASE_URL || "https://api.x.ai/v1", model: env.XAI_MODEL || "grok-4.3", keyVar: "XAI_API_KEY" },
};
const provider = (flag("provider") || env.MOSHI_BRAIN_PROVIDER || "openai").toLowerCase();
const cfg = DEFAULTS[provider];
if (!cfg) { console.error(`Unknown provider "${provider}"`); process.exit(1); }
const model = flag("model") || cfg.model;
const key = env[cfg.keyVar];
if (!key) { console.error(`No ${cfg.keyVar} (env or ui/.env.local). export ${cfg.keyVar}=... then re-run.`); process.exit(1); }

const rounds = Number(flag("rounds", "2"));
const maxEx = Number(flag("max", "12"));
const fixtures = process.argv.slice(2).filter((a) => /\.(rpp|als|flp)$/i.test(a));
if (fixtures.length === 0) fixtures.push(resolve(process.env.HOME ?? "", "mosh-demo-projects/rpp/griffin-with-external-files.rpp"));

const isReasoning = provider === "openai" && /^(gpt-5|gpt-6|o[0-9])/.test(model);
let calls = 0;
async function chat(messages: ChatMessage[], json: boolean): Promise<string> {
  calls++;
  const payload: Record<string, unknown> = { model, messages };
  if (json) payload.response_format = { type: "json_object" };
  if (isReasoning) payload.max_completion_tokens = json ? 800 : 700;
  else { payload.max_tokens = json ? 800 : 700; payload.temperature = json ? 0 : 0.5; }
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const r = await fetch(`${cfg.url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const j = (await r.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[]; error?: unknown };
    if (!r.ok) { console.error(`  ⚠ ${typeof j.error === "string" ? j.error : `HTTP ${r.status}`}`); return ""; }
    return j.choices?.[0]?.message?.content ?? "";
  } catch (e) { console.error(`  ⚠ ${String((e as Error)?.message ?? e)}`); return ""; }
  finally { clearTimeout(to); }
}
const callBrain = (m: ChatMessage[]) => chat(m, true);
const reflect = (prompt: string) => chat([{ role: "user", content: prompt }], false);

// ── build the eval set ────────────────────────────────────────────────────────
const all: EvalExample[] = [];
for (const f of fixtures) {
  try {
    const program = emitCommands(importPath(f));
    all.push(...sliceProgram(program, basename(f), { max: maxEx }));
  } catch (e) { console.error(`  ⚠ ${f}: ${String((e as Error)?.message ?? e)}`); }
}
if (all.length === 0) { console.error("No eval examples produced (check fixtures / FLP venv)."); process.exit(1); }
const examples = all.slice(0, maxEx);
const val = examples.filter((_, i) => i % 3 === 0);
const train = examples.filter((_, i) => i % 3 !== 0);

console.log(`▶ gepa — provider=${provider} model=${model} rounds=${rounds}`);
console.log(`  eval set: ${examples.length} tasks (${train.length} train / ${val.length} val) from ${fixtures.map((f) => basename(f)).join(", ")}\n`);

// --weak: seed with the rules MINUS the id-typing line, to demonstrate whether
// GEPA can re-derive a real fix from a weaker baseline (validation, not default).
const weak = process.argv.includes("--weak");
const seedRules = weak ? DEFAULT_RULES.split("\n").filter((l) => !/STRING id/.test(l)).join("\n") : DEFAULT_RULES;
if (weak) console.log("  (--weak: seeded WITHOUT the id-typing rule)\n");

const res = await optimizeRules({ seedRules, train, val, callBrain, reflect, rounds, onProgress: (m) => console.log("  " + m) });

const outDir = flag("out") || join(resolve(process.cwd(), ".."), "service", "training", "gepa", "generated");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "optimized_prompt.txt"), res.bestRules + "\n");
writeFileSync(join(outDir, "eval_results.json"), JSON.stringify({ provider, model, rounds, examples: examples.length, ...res }, null, 2) + "\n");

const improved = res.bestVal > res.baselineVal;
console.log("\n================= GEPA RESULT =================");
console.log(`baseline val score : ${res.baselineVal.toFixed(3)}`);
console.log(`best val score     : ${res.bestVal.toFixed(3)}  ${improved ? `(+${(res.bestVal - res.baselineVal).toFixed(3)} ✓ improved)` : "(no improvement)"}`);
console.log(`rounds accepted    : ${res.rounds.filter((r) => r.accepted).length}/${res.rounds.length}`);
console.log(`LLM calls          : ${calls}`);
console.log(`\nwrote:\n  ${join(outDir, "optimized_prompt.txt")}\n  ${join(outDir, "eval_results.json")}`);
if (improved) console.log(`\nTo adopt: replace DEFAULT_RULES in ui/src/agent/brainCore.ts with the optimized block, then run \`npm test\`.`);
