// Simple-helper brain benchmark — live matrix runner.
//
//   npm run brain-bench            (from ui/)
//
// Loads ui/.env.local, builds the EXACT production system prompt over a fixed
// session fixture, sends every golden case to each configured provider/model's
// OpenAI-compatible /chat/completions, scores each reply deterministically
// (src/agent/brainScore.ts), and prints a ranked table + the winner to wire as the
// default. No keys → prints how to add one and exits. temperature=0 for repeatability.
//
// Mirrors the dev proxy's request shape (ui/vite.config.ts moshiBrain): same
// endpoint, auth, response_format, and the reasoning-model (max_completion_tokens)
// branch — so the benchmark measures what the app would actually send.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { systemPrompt } from "../src/agent/brainCore";
import { scoreReply } from "../src/agent/brainScore";
import { CASES, FIXTURE } from "../src/agent/brainCases";

type Provider = { name: string; url: string; key: string; model: string };

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
      if (k) env[k] = v;
    }
  }
  return env;
}

const env = loadEnv();
const PROVIDERS: Provider[] = [
  { name: "deepseek", url: env.DEEPSEEK_BASE_URL, key: env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_MODEL },
  { name: "openai", url: env.OPENAI_BASE_URL, key: env.OPENAI_API_KEY, model: env.OPENAI_MODEL },
  { name: "xai", url: env.XAI_BASE_URL, key: env.XAI_API_KEY, model: env.XAI_MODEL },
].filter((p) => p.url && p.key && p.model) as Provider[];

if (PROVIDERS.length === 0) {
  console.error("No brain provider configured. Paste a key into ui/.env.local (see ui/.env.example):");
  console.error("  MOSHI_BRAIN_PROVIDER=deepseek");
  console.error("  DEEPSEEK_BASE_URL=https://api.deepseek.com");
  console.error("  DEEPSEEK_API_KEY=sk-...");
  console.error("  DEEPSEEK_MODEL=deepseek-v4-flash");
  process.exit(1);
}

const SYSTEM = systemPrompt(FIXTURE);

async function callModel(p: Provider, userText: string): Promise<{ content: string; ms: number; error?: string }> {
  const isReasoning = p.name === "openai" && /^(gpt-5|gpt-6|o[0-9])/.test(p.model);
  const payload: Record<string, unknown> = {
    model: p.model,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: userText },
    ],
    response_format: { type: "json_object" },
  };
  if (isReasoning) payload.max_completion_tokens = 800;
  else { payload.max_tokens = 800; payload.temperature = 0; }

  const t0 = Date.now();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const r = await fetch(`${p.url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const j = (await r.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string } }[];
      error?: unknown;
    };
    const ms = Date.now() - t0;
    if (!r.ok) return { content: "", ms, error: typeof j.error === "string" ? j.error : `HTTP ${r.status}` };
    return { content: j.choices?.[0]?.message?.content ?? "", ms };
  } catch (e) {
    return { content: "", ms: Date.now() - t0, error: String((e as Error)?.message ?? e) };
  } finally {
    clearTimeout(to);
  }
}

type Row = { provider: string; model: string; pass: number; parsed: number; total: number; meanMs: number };

const rows: Row[] = [];
for (const p of PROVIDERS) {
  console.log(`\n▶ ${p.name} (${p.model}) — ${CASES.length} cases`);
  let pass = 0, parsed = 0, msSum = 0;
  for (const c of CASES) {
    const { content, ms, error } = await callModel(p, c.request);
    msSum += ms;
    if (error) {
      console.log(`  ✗ ${c.id.padEnd(14)} ${String(ms).padStart(5)}ms  — request error: ${error}`);
      continue;
    }
    const sc = scoreReply(content, c);
    if (sc.parsed) parsed++;
    if (sc.pass) pass++;
    console.log(`  ${sc.pass ? "✓" : "✗"} ${c.id.padEnd(14)} ${String(ms).padStart(5)}ms${sc.pass ? "" : "  — " + sc.notes.join("; ")}`);
  }
  rows.push({ provider: p.name, model: p.model, pass, parsed, total: CASES.length, meanMs: Math.round(msSum / CASES.length) });
}

rows.sort((a, b) => b.pass - a.pass || a.meanMs - b.meanMs);

const pct = (n: number, d: number) => `${Math.round((100 * n) / d)}%`;
console.log("\n================= RESULTS =================");
console.log(`${"provider".padEnd(10)} ${"model".padEnd(22)} ${"pass".padEnd(10)} ${"parsed".padEnd(7)} mean`);
for (const r of rows) {
  console.log(
    `${r.provider.padEnd(10)} ${r.model.padEnd(22)} ${`${pct(r.pass, r.total)} (${r.pass}/${r.total})`.padEnd(10)} ${pct(r.parsed, r.total).padEnd(7)} ${r.meanMs}ms`,
  );
}

const win = rows[0];
console.log(`\n🏆 winner: ${win.provider} / ${win.model}  —  ${win.pass}/${win.total} pass, ${win.meanMs}ms mean`);
console.log("\nTo make it the default, set in ui/.env.local (and ui/.env.example):");
console.log(`  MOSHI_BRAIN_PROVIDER=${win.provider}`);
console.log(`\n(scored deterministically by src/agent/brainScore.ts over ${CASES.length} simple-helper cases, temperature=0)`);
