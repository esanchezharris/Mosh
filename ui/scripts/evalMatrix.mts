// Multi-model agentic eval matrix. Discovers each configured provider's real models,
// runs the shared golden suite (src/agent/evalSuite.ts) across all of them, scores
// deterministically, and writes a ranked scorecard to eval/. This is the autonomous
// "machine bar" — read the scorecard, then spend ears only on the models that pass.
//
//   npm run eval-matrix              # all configured providers, ~3 models each
//   EVAL_MODELS_PER_PROVIDER=5 npm run eval-matrix
//   EVAL_ONLY=openai,xai npm run eval-matrix
//
// Keys are read from ui/.env.local and ~/.config/mosh/env by reference; never logged.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { systemPrompt } from "../src/agent/prompt";
import { EVAL_CASES, EVAL_SNAPSHOT, EVAL_PLUGINS, scoreReply } from "../src/agent/evalSuite";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const OUT_DIR = resolve(ROOT, "eval");

// ── env: load the dotenv-style files into process.env (no value ever printed) ──
function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.replace(/^export\s+/, "").match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim().replace(/^["']|["']$/g, "");
    if (val && !process.env[key]) process.env[key] = val;
  }
}
loadEnvFile(resolve(ROOT, "ui/.env.local"));
loadEnvFile(resolve(homedir(), ".config/mosh/env"));

const env = (k: string) => process.env[k] ?? "";

// ── provider catalog ──────────────────────────────────────────────────────
type Provider = { id: string; baseUrl: string; key: string; defaultModel: string; pick: RegExp; exclude: RegExp };

function providers(): Provider[] {
  const all: (Provider | null)[] = [
    env("DEEPSEEK_API_KEY") && env("DEEPSEEK_BASE_URL")
      ? { id: "deepseek", baseUrl: env("DEEPSEEK_BASE_URL"), key: env("DEEPSEEK_API_KEY"), defaultModel: env("DEEPSEEK_MODEL"), pick: /deepseek|chat|reason/i, exclude: /embed|vl|ocr/i }
      : null,
    env("OPENAI_API_KEY") && env("OPENAI_BASE_URL")
      ? { id: "openai", baseUrl: env("OPENAI_BASE_URL"), key: env("OPENAI_API_KEY"), defaultModel: env("OPENAI_MODEL"), pick: /^(gpt|o\d|chatgpt)/i, exclude: /embed|audio|tts|whisper|image|dall|realtime|search|moderation|transcribe|babbage|davinci|instruct|computer/i }
      : null,
    env("XAI_API_KEY") && env("XAI_BASE_URL")
      ? { id: "xai", baseUrl: env("XAI_BASE_URL"), key: env("XAI_API_KEY"), defaultModel: env("XAI_MODEL"), pick: /grok/i, exclude: /image|vision/i }
      : null,
    env("GEMINI_API_KEY")
      ? { id: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", key: env("GEMINI_API_KEY"), defaultModel: env("MOSH_AGENT_MODEL") || "gemini-2.5-flash", pick: /gemini/i, exclude: /embed|aqa|vision|image|tts|live|exp|thinking|computer|robotics|audio|native|1\.0|1\.5|2\.0/i }
      : null,
  ];
  const only = (env("EVAL_ONLY") || "").split(",").map((s) => s.trim()).filter(Boolean);
  return all.filter((p): p is Provider => !!p).filter((p) => only.length === 0 || only.includes(p.id));
}

const MAX_MODELS = Number(env("EVAL_MODELS_PER_PROVIDER") || 3);
const CONCURRENCY = Number(env("EVAL_CONCURRENCY") || 6);

async function discoverModels(p: Provider): Promise<string[]> {
  const def = p.defaultModel.replace(/^models\//, "");
  let ids: string[] = [];
  try {
    const res = await fetch(`${p.baseUrl}/models`, { headers: { Authorization: `Bearer ${p.key}` } });
    if (res.ok) {
      const j = (await res.json()) as { data?: { id: string }[] };
      ids = (j.data ?? []).map((m) => m.id.replace(/^models\//, ""));
    }
  } catch { /* fall back to the default model */ }

  const cands = ids.filter((id) => p.pick.test(id) && !p.exclude.test(id));
  // prefer cheaper/faster variants for the alternates, keep it deterministic
  const rank = (id: string) => (/mini|flash|small|lite|nano|haiku|fast/.test(id) ? 0 : 1);
  const alternates = cands
    .filter((id) => id !== def)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const chosen = [def, ...alternates].filter((v, i, a) => v && a.indexOf(v) === i).slice(0, MAX_MODELS);
  return chosen;
}

const isReasoning = (m: string) => /^(gpt-5|gpt-6|o[0-9])/.test(m) || /reason|thinking/.test(m);

async function callLLM(p: Provider, model: string, sys: string, user: string): Promise<{ content?: string; ms: number; error?: string }> {
  const t0 = Date.now();
  const base: Record<string, unknown> = { model, messages: [{ role: "system", content: sys }, { role: "user", content: user }] };
  if (isReasoning(model)) base.max_completion_tokens = 1200;
  else { base.max_tokens = 1000; base.temperature = 0.3; }

  const post = async (withJsonMode: boolean) => {
    const body = withJsonMode ? { ...base, response_format: { type: "json_object" } } : base;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45_000);
    try {
      const res = await fetch(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      return { status: res.status, text };
    } finally { clearTimeout(timer); }
  };

  try {
    let r = await post(true);
    if (r.status === 400 || r.status === 422) r = await post(false); // some models reject json mode
    const ms = Date.now() - t0;
    if (r.status < 200 || r.status >= 300) return { ms, error: `HTTP ${r.status}: ${r.text.slice(0, 140)}` };
    const j = JSON.parse(r.text) as { choices?: { message?: { content?: string } }[] };
    return { content: j.choices?.[0]?.message?.content ?? "", ms };
  } catch (e) {
    return { ms: Date.now() - t0, error: String((e as Error).message || e).slice(0, 140) };
  }
}

// ── tiny concurrency pool ──────────────────────────────────────────────────
async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  }));
}

type CaseResult = { caseId: string; pass: boolean; hallucination: boolean; emitted: string[]; ms: number; error?: string };
type ModelResult = { provider: string; model: string; results: CaseResult[] };

async function run() {
  const provs = providers();
  if (provs.length === 0) {
    console.error("No provider configured. Put keys in ui/.env.local or ~/.config/mosh/env (DEEPSEEK/OPENAI/XAI/GEMINI).");
    process.exit(2);
  }
  console.error(`Providers: ${provs.map((p) => p.id).join(", ")}  ·  ${EVAL_CASES.length} cases  ·  up to ${MAX_MODELS} models each\n`);

  const sys = systemPrompt(EVAL_SNAPSHOT, EVAL_PLUGINS);
  const matrix: ModelResult[] = [];

  for (const p of provs) {
    const models = await discoverModels(p);
    console.error(`${p.id}: ${models.join(", ")}`);
    for (const model of models) {
      const mr: ModelResult = { provider: p.id, model, results: [] };
      await pool(EVAL_CASES, CONCURRENCY, async (c) => {
        const out = await callLLM(p, model, sys, c.ask);
        if (out.error || out.content === undefined) {
          mr.results.push({ caseId: c.id, pass: false, hallucination: false, emitted: [], ms: out.ms, error: out.error ?? "no content" });
        } else {
          const s = scoreReply(c, out.content);
          mr.results.push({ caseId: c.id, pass: s.pass, hallucination: s.hallucination, emitted: s.emitted, ms: out.ms });
        }
      });
      const passes = mr.results.filter((r) => r.pass).length;
      console.error(`  ${model}: ${passes}/${EVAL_CASES.length}`);
      matrix.push(mr);
    }
  }
  return matrix;
}

function aggregate(m: ModelResult) {
  const total = m.results.length;
  const passes = m.results.filter((r) => r.pass).length;
  const halluc = m.results.filter((r) => r.hallucination).length;
  const errors = m.results.filter((r) => r.error).length;
  const avgMs = Math.round(m.results.reduce((a, r) => a + r.ms, 0) / Math.max(1, total));
  const failed = m.results.filter((r) => !r.pass).map((r) => r.caseId);
  return { ...m, total, passes, passRate: passes / total, hallucRate: halluc / total, errors, avgMs, failed };
}

function report(matrix: ModelResult[], stamp: string): string {
  const rows = matrix.map(aggregate).sort((a, b) => b.passRate - a.passRate || a.hallucRate - b.hallucRate || a.avgMs - b.avgMs);
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  const lines: string[] = [];
  lines.push(`# Agentic eval scorecard — ${stamp}`);
  lines.push("");
  lines.push(`Golden suite of ${EVAL_CASES.length} natural-language asks scored deterministically (right command + sane args, no hallucinations). Ranked best-first.`);
  lines.push("");
  lines.push("| # | provider | model | pass | hallucinations | errors | avg ms |");
  lines.push("|---|----------|-------|------|----------------|--------|--------|");
  rows.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${r.provider} | \`${r.model}\` | **${pct(r.passRate)}** (${r.passes}/${r.total}) | ${pct(r.hallucRate)} | ${r.errors} | ${r.avgMs} |`);
  });
  lines.push("");

  // which cases are hardest (failed by the most models) — surfaces prompt/catalog
  // gaps vs model gaps. Only count models that actually RAN (a fully-errored model
  // is unavailable, not failing the case).
  const scored = rows.filter((r) => r.errors < r.total);
  const byCase = new Map<string, number>();
  for (const r of scored) for (const id of r.failed) byCase.set(id, (byCase.get(id) ?? 0) + 1);
  const hard = [...byCase.entries()].sort((a, b) => b[1] - a[1]).filter(([, c]) => c > 0);
  if (hard.length) {
    lines.push("## Hardest cases (failed by N of the scored models)");
    lines.push("");
    for (const [id, c] of hard) {
      const want = EVAL_CASES.find((x) => x.id === id)?.want ?? "";
      lines.push(`- \`${id}\` — failed by ${c}/${scored.length} models — _want: ${want}_`);
    }
    lines.push("");
  } else {
    lines.push("## Hardest cases");
    lines.push("");
    lines.push("None — every scored model passed every case. ✅");
    lines.push("");
  }

  // per-model failure detail so a human can see WHY before listening
  lines.push("## Failures by model");
  lines.push("");
  for (const r of rows) {
    if (r.failed.length === 0) { lines.push(`### ${r.provider} \`${r.model}\` — clean sweep ✅`); lines.push(""); continue; }
    lines.push(`### ${r.provider} \`${r.model}\` — ${r.failed.length} failed`);
    for (const id of r.failed) {
      const res = r.results.find((x) => x.caseId === id)!;
      const detail = res.error ? `error: ${res.error}` : `emitted [${res.emitted.join(", ") || "—"}]${res.hallucination ? " ⚠️ hallucinated" : ""}`;
      lines.push(`- \`${id}\`: ${detail}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

const matrix = await run();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(resolve(OUT_DIR, `report-${stamp}.json`), JSON.stringify(matrix.map(aggregate), null, 2));
const md = report(matrix, stamp);
writeFileSync(resolve(OUT_DIR, "report.md"), md);
console.error(`\n${"─".repeat(60)}\n`);
// print the ranked table to stdout
console.log(md.split("## Failures")[0]);
console.error(`Full report: eval/report.md  ·  raw: eval/report-${stamp}.json`);
