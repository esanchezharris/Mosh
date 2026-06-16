// Shared LLM helpers for the eval/arena scripts: load the dotenv files (keys by
// reference, never logged), resolve a provider, and call an OpenAI-compatible
// chat endpoint. Mirrors src/brain/BrainProxy.cpp's provider resolution.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export function loadEnvFiles(uiRoot: string): void {
  const load = (p: string) => {
    if (!existsSync(p)) return;
    for (const raw of readFileSync(p, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.replace(/^export\s+/, "").match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i);
      if (m && m[2].trim() && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  };
  load(resolve(uiRoot, ".env.local"));
  load(resolve(homedir(), ".config/mosh/env"));
}

export type Provider = { id: string; baseUrl: string; key: string; model: string };

export function resolveProvider(want?: string): Provider | null {
  const e = (k: string) => process.env[k] ?? "";
  const cands: Provider[] = [
    { id: "deepseek", baseUrl: e("DEEPSEEK_BASE_URL"), key: e("DEEPSEEK_API_KEY"), model: e("DEEPSEEK_MODEL") },
    { id: "openai", baseUrl: e("OPENAI_BASE_URL"), key: e("OPENAI_API_KEY"), model: e("OPENAI_MODEL") },
    { id: "xai", baseUrl: e("XAI_BASE_URL"), key: e("XAI_API_KEY"), model: e("XAI_MODEL") },
    { id: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", key: e("GEMINI_API_KEY"), model: e("MOSH_AGENT_MODEL") || "gemini-2.5-flash" },
  ];
  const ok = (p: Provider) => Boolean(p.baseUrl && p.key && p.model);
  const w = want || process.env.MOSHI_BRAIN_PROVIDER;
  return (w && cands.find((p) => p.id === w && ok(p))) || cands.find(ok) || null;
}

const isReasoning = (m: string) => /^(gpt-5|gpt-6|o[0-9])/.test(m) || /reason|thinking/.test(m);

export async function callLLM(p: Provider, messages: { role: string; content: string }[]): Promise<string> {
  const body: Record<string, unknown> = { model: p.model, messages };
  if (isReasoning(p.model)) body.max_completion_tokens = 1500;
  else { body.max_tokens = 1200; body.temperature = 0.5; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
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
