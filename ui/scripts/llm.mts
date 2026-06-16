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

// All configured+usable providers, in priority order (a preferred id floated to front).
// Lets a caller FALL BACK across providers when one flakes (empty completion / 5xx).
export function resolveProviders(want?: string): Provider[] {
  const e = (k: string) => process.env[k] ?? "";
  const cands: Provider[] = [
    { id: "deepseek", baseUrl: e("DEEPSEEK_BASE_URL"), key: e("DEEPSEEK_API_KEY"), model: e("DEEPSEEK_MODEL") },
    { id: "openai", baseUrl: e("OPENAI_BASE_URL"), key: e("OPENAI_API_KEY"), model: e("OPENAI_MODEL") },
    { id: "xai", baseUrl: e("XAI_BASE_URL"), key: e("XAI_API_KEY"), model: e("XAI_MODEL") },
    { id: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", key: e("GEMINI_API_KEY"), model: e("MOSH_AGENT_MODEL") || "gemini-2.5-flash" },
  ];
  const ok = (p: Provider) => Boolean(p.baseUrl && p.key && p.model);
  const w = want || process.env.MOSHI_BRAIN_PROVIDER;
  const usable = cands.filter(ok);
  if (w) usable.sort((a, b) => (a.id === w ? -1 : 0) - (b.id === w ? -1 : 0));
  return usable;
}

export function resolveProvider(want?: string): Provider | null {
  return resolveProviders(want)[0] ?? null;
}

const isReasoning = (m: string) => /^(gpt-5|gpt-6|o[0-9])/.test(m) || /reason|thinking/.test(m);

export async function callLLM(p: Provider, messages: { role: string; content: string }[], opts?: { maxTokens?: number }): Promise<string> {
  const body: Record<string, unknown> = { model: p.model, messages };
  // Default budgets unchanged; callers needing a long structured reply (e.g. the
  // flywheel's multi-card distill) can raise it so the JSON isn't truncated mid-array.
  if (isReasoning(p.model)) body.max_completion_tokens = opts?.maxTokens ?? 1500;
  else { body.max_tokens = opts?.maxTokens ?? 1200; body.temperature = 0.5; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // Surface the failure (status + a short body snippet, NEVER the key) so callers
      // don't silently see an empty string on a 429/5xx/auth error.
      const snippet = await res.text().catch(() => "");
      console.error(`[llm] ${p.id}/${p.model} HTTP ${res.status}: ${snippet.slice(0, 200).replace(/\s+/g, " ")}`);
      return "";
    }
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = j.choices?.[0]?.message?.content ?? "";
    if (!content) console.error(`[llm] ${p.id}/${p.model} returned no content (empty completion)`);
    return content;
  } catch (e) {
    console.error(`[llm] ${p.id}/${p.model} request failed: ${(e as Error).message}`);
    return "";
  } finally { clearTimeout(timer); }
}
