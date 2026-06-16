// Live intent→command eval against ONE provider (the default), using the shared
// golden suite (evalSuite.ts) — the quick gate version of the multi-model matrix
// (scripts/evalMatrix.mts). SKIPPED unless MOSH_BRAIN_EVAL=1 and a provider is
// configured, so the default `npm test` stays free and offline.
//
//   npm run brain-eval                       # default provider (MOSHI_BRAIN_PROVIDER)
//   MOSHI_BRAIN_PROVIDER=openai npm run brain-eval
//
// Keys come from ui/.env.local / ~/.config/mosh/env (loaded below) — never logged.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { systemPrompt } from "./prompt";
import { EVAL_CASES, EVAL_SNAPSHOT, EVAL_PLUGINS, scoreReply } from "./evalSuite";

const UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.replace(/^export\s+/, "").match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (m && m[2].trim() && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
loadEnvFile(resolve(UI_ROOT, ".env.local"));
loadEnvFile(resolve(homedir(), ".config/mosh/env"));

type Provider = { id: string; baseUrl: string; key: string; model: string };
function resolveProvider(): Provider | null {
  const e = (k: string) => process.env[k] ?? "";
  const cands: Provider[] = [
    { id: "deepseek", baseUrl: e("DEEPSEEK_BASE_URL"), key: e("DEEPSEEK_API_KEY"), model: e("DEEPSEEK_MODEL") },
    { id: "openai", baseUrl: e("OPENAI_BASE_URL"), key: e("OPENAI_API_KEY"), model: e("OPENAI_MODEL") },
    { id: "xai", baseUrl: e("XAI_BASE_URL"), key: e("XAI_API_KEY"), model: e("XAI_MODEL") },
    { id: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", key: e("GEMINI_API_KEY"), model: e("MOSH_AGENT_MODEL") || "gemini-2.5-flash" },
  ];
  const complete = (p: Provider) => p.baseUrl && p.key && p.model;
  const want = process.env.MOSHI_BRAIN_PROVIDER;
  return (want && cands.find((p) => p.id === want && complete(p))) || cands.find(complete) || null;
}

const provider = resolveProvider();
const RUN = process.env.MOSH_BRAIN_EVAL === "1" && provider !== null;
if (!RUN) {
  // eslint-disable-next-line no-console
  console.warn("[brain-eval] skipped — set MOSH_BRAIN_EVAL=1 and configure a provider (ui/.env.local). For all models: npm run eval-matrix");
}

const isReasoning = (m: string) => /^(gpt-5|gpt-6|o[0-9])/.test(m) || /reason|thinking/.test(m);

async function callLLM(p: Provider, sys: string, user: string): Promise<string> {
  const body: Record<string, unknown> = { model: p.model, messages: [{ role: "system", content: sys }, { role: "user", content: user }] };
  if (isReasoning(p.model)) body.max_completion_tokens = 1200;
  else { body.max_tokens = 1000; body.temperature = 0.3; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45_000);
  try {
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content ?? "";
  } finally { clearTimeout(timer); }
}

describe.skipIf(!RUN)(`brain eval (live · ${provider?.id ?? "none"} · ${provider?.model ?? ""})`, () => {
  const sys = systemPrompt(EVAL_SNAPSHOT, EVAL_PLUGINS);
  for (const c of EVAL_CASES) {
    it(`${c.id} — "${c.ask}"`, async () => {
      const s = scoreReply(c, await callLLM(provider!, sys, c.ask));
      expect(s.hallucination, `hallucinated commands: [${s.emitted.join(", ")}]`).toBe(false);
      expect(s.pass, `want: ${c.want}; got [${s.emitted.join(", ")}] intent=${s.intent}`).toBe(true);
    }, 50_000);
  }
});
