// SFT eval — score whatever model OPENAI_BASE_URL points at (cloud baseline OR a
// local mlx_lm.server serving the fine-tuned adapter) on the frozen test eval set,
// using the SAME verifier reward as GEPA (clean-apply × gold-command-name recall).
//
//   # baseline (cloud brain):
//   cd ui && npm run eval-sft -- --eval ../service/sft/.sft-data/sft-v1/test.eval.jsonl --tag baseline
//   # fine-tuned (after: mlx_lm.server --model ...fused... --port 8080; export OPENAI_BASE_URL=http://127.0.0.1:8080/v1 ...):
//   cd ui && npm run eval-sft -- --eval ... --tag finetuned
//
// Writes eval_results.<tag>.json next to the eval set. Run both tags over the SAME
// eval file → the Phase-4 DoD: baseline-vs-fine-tuned clean-apply.

import { readFileSync, existsSync, writeFileSync, openSync, writeSync, closeSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { evaluate, buildExamplePrompt, scoreReply } from "../src/gepa/metric";
import { DEFAULT_RULES } from "../src/agent/brainCore";
import { RULES_WITH_EXAMPLES } from "../src/agent/fewshot";
import { SMALL_MODEL_RULES, SMALL_MODEL_RULES_WITH_EXAMPLES, smallModelCatalogPrompt } from "../src/agent/smallModel";
import type { EvalExample } from "../src/gepa/evalset";
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
const key = env[cfg.keyVar] || "local"; // local mlx server needs no real key
const tag = flag("tag", "eval") as string;
// --rules selects the prompt ARM: rules block + (optionally) a swapped command
// catalog. "plain"/"default" = the production prompt; "examples" = the few-shot
// bank (mirrors moshiBench's flag); "pruned"/"pruned-examples" = small-model mode
// (docs/bench/SMALL_MODEL_MODE_2026-07.md). Unknown values are a HARD ERROR — a
// typo silently running the control arm would invalidate a whole A/B run.
const ARMS: Record<string, { rules: string; catalog?: string }> = {
  default: { rules: DEFAULT_RULES },
  plain: { rules: DEFAULT_RULES },
  examples: { rules: RULES_WITH_EXAMPLES },
  pruned: { rules: SMALL_MODEL_RULES, catalog: smallModelCatalogPrompt() },
  "pruned-examples": { rules: SMALL_MODEL_RULES_WITH_EXAMPLES, catalog: smallModelCatalogPrompt() },
};
const rulesArm = flag("rules", "default") as string;
const arm = ARMS[rulesArm];
if (!arm) { console.error(`Unknown --rules "${rulesArm}" (expected ${Object.keys(ARMS).join(" | ")})`); process.exit(1); }
const RULES = arm.rules;
const CATALOG = arm.catalog;

// Per-family rollup for eval sets with `evalA#<command>#<i>`-style ids (the
// per-command floor surface). Corpus-hash ids (frozen300) don't match → omitted.
function perFamilyRollup(perExample: { id: string; score: number; deferred: boolean }[]): Record<string, { n: number; mean: number; deferrals: number }> {
  const fams = new Map<string, { n: number; sum: number; deferrals: number }>();
  for (const e of perExample) {
    const m = /^evalA#([a-z_]+)#/.exec(e.id);
    if (!m) continue;
    const f = fams.get(m[1]) ?? { n: 0, sum: 0, deferrals: 0 };
    f.n++; f.sum += e.score; if (e.deferred) f.deferrals++;
    fams.set(m[1], f);
  }
  return Object.fromEntries(
    [...fams].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, { n: v.n, mean: v.sum / v.n, deferrals: v.deferrals }]),
  );
}
function printPerFamily(perFamily: Record<string, { n: number; mean: number; deferrals: number }>): void {
  const rows = Object.entries(perFamily);
  if (rows.length === 0) return;
  console.log(`\nper-family (worst first):`);
  rows.sort((a, b) => a[1].mean - b[1].mean);
  for (const [name, f] of rows) console.log(`  ${name.padEnd(26)} mean ${f.mean.toFixed(3)}  n=${f.n}  deferrals=${f.deferrals}`);
}
const evalPath = flag("eval");
if (!evalPath || !existsSync(evalPath)) { console.error(`--eval <test.eval.jsonl> required (got ${evalPath})`); process.exit(1); }

let examples: EvalExample[] = readFileSync(evalPath, "utf8").split("\n").filter((s) => s.trim()).map((l) => JSON.parse(l) as EvalExample);
if (examples.length === 0) { console.error("empty eval set"); process.exit(1); }
// Cap the eval to a deterministic subsample (the full eval set can be ~12k → too
// many metered calls). Same seed → same subset for baseline vs finetuned.
const nCap = Number(flag("n", "0")) || 0;
if (nCap > 0 && examples.length > nCap) {
  const h = (s: string) => { let x = 5381; for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) >>> 0; return x; };
  examples = [...examples].sort((a, b) => h(a.id) - h(b.id)).slice(0, nCap);
}

// ── offline modes (robust to flaky remote serving) ──────────────────────────
// --dump FILE : write {id, messages} per example (the prompts a model should answer).
// --replies FILE : score pre-generated {id, content} replies (no live model needed).
const dumpPath = flag("dump");
if (dumpPath) {
  const fd = openSync(dumpPath, "w");
  for (const ex of examples) writeSync(fd, JSON.stringify({ id: ex.id, messages: await buildExamplePrompt(RULES, ex, CATALOG) }) + "\n");
  closeSync(fd);
  console.log(`dumped ${examples.length} prompts → ${dumpPath}`);
  process.exit(0);
}
const repliesPath = flag("replies");
if (repliesPath) {
  const replies = new Map<string, string>();
  for (const l of readFileSync(repliesPath, "utf8").split("\n").filter((s) => s.trim())) { const o = JSON.parse(l); replies.set(o.id, o.content ?? ""); }
  const perExample = [];
  for (const ex of examples) perExample.push(await scoreReply(ex, replies.get(ex.id) ?? ""));
  const mean = perExample.length ? perExample.reduce((s, e) => s + e.score, 0) / perExample.length : 0;
  const deferrals = perExample.filter((e) => e.deferred).length;
  const perFamily = perFamilyRollup(perExample);
  const out = { tag, mode: "offline", rules: rulesArm, examples: examples.length, cleanApply: mean, deferrals, ...(Object.keys(perFamily).length ? { perFamily } : {}), perExample };
  // next to the EVAL set (matching the live path + this file's header), not the
  // replies file — in the dump-remotely/score-locally flow they're in different dirs.
  const outPath = join(dirname(evalPath), `eval_results.${tag}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`================= EVAL RESULT =================`);
  console.log(`[${tag}] clean-apply score : ${mean.toFixed(3)}  (${deferrals} deferral(s) / ${examples.length})`);
  printPerFamily(perFamily);
  console.log(`wrote ${outPath}`);
  process.exit(0);
}

const isReasoning = provider === "openai" && /^(gpt-5|gpt-6|o[0-9])/.test(model);
let calls = 0;
// 2500, not 800: note-population targets routinely exceed 800 completion tokens, and a
// truncated reply is unparseable → scored as a (false) failure. Override with --max-tokens.
const maxTok = Number(flag("max-tokens", "2500")) || 2500;
// --no-think: disable a local thinking-model's reasoning via the chat template
// (mlx_lm.server forwards chat_template_kwargs; keeps the PROMPT byte-identical
// across arms, unlike a /no_think soft switch). Local-server-only — cloud APIs
// reject unknown fields, hence flag-gated.
const noThink = process.argv.includes("--no-think");
const callBrain = async (messages: ChatMessage[]): Promise<string> => {
  calls++;
  const payload: Record<string, unknown> = { model, messages, response_format: { type: "json_object" } };
  if (noThink) payload.chat_template_kwargs = { enable_thinking: false };
  if (isReasoning) payload.max_completion_tokens = maxTok; else { payload.max_tokens = maxTok; payload.temperature = 0; }
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
};

console.log(`▶ eval-sft [${tag}] — provider=${provider} model=${model} base=${cfg.url} rules=${rulesArm}`);
console.log(`  ${examples.length} eval task(s) from ${evalPath}\n`);

const report = await evaluate(RULES, examples, callBrain, CATALOG);
const perFamily = perFamilyRollup(report.perExample);
const out = { tag, provider, model, baseUrl: cfg.url, rules: rulesArm, examples: examples.length, cleanApply: report.mean, deferrals: report.deferrals, calls, ...(Object.keys(perFamily).length ? { perFamily } : {}), perExample: report.perExample };
const outPath = join(dirname(evalPath), `eval_results.${tag}.json`);
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

console.log("================= EVAL RESULT =================");
console.log(`[${tag}] clean-apply score : ${report.mean.toFixed(3)}  (${report.deferrals} deferral(s) / ${examples.length})`);
console.log(`LLM calls               : ${calls}`);
printPerFamily(perFamily);
console.log(`\nwrote ${outPath}`);
console.log(`\n(run with --tag baseline against the cloud brain, then --tag finetuned against the local mlx server, over the SAME --eval file, to get the DoD comparison.)`);
