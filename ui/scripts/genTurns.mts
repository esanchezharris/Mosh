// Headless real-turn generator — CLI.
//
//   cd ui && npm run gen-turns                       (uses the bundled SESSION_ARC + OpenAI)
//   cd ui && npm run gen-turns -- --provider deepseek --corpus my.txt --out /tmp/gen
//
// Drives Moshi's REAL brain (the EXACT production systemPrompt + parser) over a
// session arc and writes schema-real training tuples — the SFT/GEPA data the
// pipeline needs. Reads keys from ui/.env.local OR the environment (the repo's
// keys live in the user's shell, so run it from an interactive shell). Writes a
// replayable mosh-log.jsonl + tuples.jsonl to a DEDICATED dir — never the live
// ~/Library/Mosh/session log. No keys → prints how to add one and exits.
//
// Mirrors the dev proxy's request shape (response_format json_object, the
// reasoning-model max_completion_tokens branch) so it measures what the app sends.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { generateTuples, type ChatMessage } from "../src/harvest/genTurns";
import { SESSION_ARC } from "../src/harvest/genCorpus";
import { isAgentCallable } from "../src/harvest/tupleSchema";

// ── env + args ──────────────────────────────────────────────────────────────
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
      if (k && !env[k]) env[k] = v; // real shell env wins over .env.local
    }
  }
  return env;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const env = loadEnv();
const DEFAULTS: Record<string, { url: string; model: string; keyVar: string }> = {
  openai: { url: env.OPENAI_BASE_URL || "https://api.openai.com/v1", model: env.OPENAI_MODEL || "gpt-5.4-mini", keyVar: "OPENAI_API_KEY" },
  deepseek: { url: env.DEEPSEEK_BASE_URL || "https://api.deepseek.com", model: env.DEEPSEEK_MODEL || "deepseek-v4-flash", keyVar: "DEEPSEEK_API_KEY" },
  xai: { url: env.XAI_BASE_URL || "https://api.x.ai/v1", model: env.XAI_MODEL || "grok-4.3", keyVar: "XAI_API_KEY" },
};

const provider = (arg("provider") || env.MOSHI_BRAIN_PROVIDER || "openai").toLowerCase();
const cfg = DEFAULTS[provider];
if (!cfg) {
  console.error(`Unknown provider "${provider}". Use one of: ${Object.keys(DEFAULTS).join(", ")}`);
  process.exit(1);
}
const model = arg("model") || cfg.model;
const key = env[cfg.keyVar];
const temperature = Number(arg("temp") ?? env.GEN_TEMPERATURE ?? "0");

if (!key) {
  console.error(`No ${cfg.keyVar} found (checked the environment and ui/.env.local).`);
  console.error(`Provide a key, e.g.  export ${cfg.keyVar}=sk-...   then re-run, or set one in ui/.env.local.`);
  process.exit(1);
}

const corpusFile = arg("corpus");
const utterances = corpusFile
  ? readFileSync(corpusFile, "utf8").split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"))
  : SESSION_ARC;

const repoRoot = resolve(process.cwd(), "..");
const outDir = arg("out") || join(repoRoot, "service", "training", "gepa", "generated");

// ── real brain call ─────────────────────────────────────────────────────────
const isReasoning = provider === "openai" && /^(gpt-5|gpt-6|o[0-9])/.test(model);
const callBrain = async (messages: ChatMessage[]): Promise<string> => {
  const payload: Record<string, unknown> = { model, messages, response_format: { type: "json_object" } };
  if (isReasoning) payload.max_completion_tokens = 800;
  else { payload.max_tokens = 800; payload.temperature = temperature; }
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const r = await fetch(`${cfg.url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const j = (await r.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[]; error?: unknown };
    if (!r.ok) {
      console.error(`  ⚠ request error: ${typeof j.error === "string" ? j.error : `HTTP ${r.status}`}`);
      return "";
    }
    const content = j.choices?.[0]?.message?.content ?? "";
    if (env.GEN_DEBUG) console.error(`    raw: ${content.replace(/\s+/g, " ").slice(0, 220)}`);
    return content;
  } catch (e) {
    console.error(`  ⚠ request failed: ${String((e as Error)?.message ?? e)}`);
    return "";
  } finally {
    clearTimeout(to);
  }
};

// ── run ─────────────────────────────────────────────────────────────────────
console.log(`▶ gen-turns — provider=${provider} model=${model} temp=${isReasoning ? "n/a" : temperature}`);
console.log(`  ${utterances.length} utterance(s) → ${outDir}\n`);

const deferrals: string[] = [];
const { logText, tuples } = await generateTuples(utterances, callBrain, {
  source: "brain_chat",
  cleanStart: true,
  logPath: "generated:genTurns",
  onTurn: ({ index, utterance, valid, ok }) => {
    const tag = valid === 0 ? "·· (no commands)" : `${ok}/${valid} ok`;
    if (valid === 0) deferrals.push(utterance);
    console.log(`  [${String(index + 1).padStart(2)}] ${tag.padEnd(16)} ${utterance}`);
  },
});

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "mosh-log.jsonl"), logText);
writeFileSync(join(outDir, "tuples.jsonl"), tuples.map((t) => JSON.stringify(t)).join("\n") + (tuples.length ? "\n" : ""));

// ── summary ─────────────────────────────────────────────────────────────────
const totalCmds = tuples.reduce((n, t) => n + t.commands.length, 0);
const okCmds = tuples.reduce((n, t) => n + t.commands.filter((c) => c.ok).length, 0);
const cleanTurns = tuples.filter((t) => t.outcome.appliedClean).length;
const vocab = new Set<string>();
for (const t of tuples) for (const c of t.commands) if (isAgentCallable(c.command)) vocab.add(c.command);

console.log("\n================= SUMMARY =================");
console.log(`tuples written : ${tuples.length} / ${utterances.length} utterances  (${deferrals.length} deferral(s))`);
console.log(`commands       : ${totalCmds} total, ${okCmds} ok  (${cleanTurns}/${tuples.length} turns fully clean)`);
console.log(`vocab covered  : ${vocab.size} distinct agent command(s)`);
console.log(`               : ${[...vocab].sort().join(", ")}`);
console.log(`\nwrote:\n  ${join(outDir, "tuples.jsonl")}\n  ${join(outDir, "mosh-log.jsonl")}`);
if (deferrals.length) console.log(`\ndeferred (no commands): ${deferrals.map((d) => `"${d}"`).join(", ")}`);
