// Qualitative live-drive — point the locally-trained model (mlx_lm.server) at a few
// FRESH, hand-written producer instructions (not from the eval set) and show the
// {intent, commands} it emits + whether they clean-apply through the mock backend.
// Tangible proof the local model drives the DAW, generalizing past templated phrasing.
//
//   "$SFT_PY" -m mlx_lm server --model service/sft/.fused/sft-v1 --port 8080 &
//   cd ui && OPENAI_BASE_URL=http://127.0.0.1:8080/v1 OPENAI_MODEL=<served-id> \
//            OPENAI_API_KEY=local npm run drive-local
//   # (falls back to ui/.env.local; use --model to override the served id)

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { __resetMockForTests, mockExecute, mockSnapshot } from "../src/bridge.mock";
import { validateCommand } from "../src/agent/commands";
import { buildSystemPrompt, DEFAULT_RULES, parseReply } from "../src/agent/brainCore";
import { runBound } from "../src/gepa/metric";
import type { Snapshot, CommandResult } from "../src/types";
import type { BoundCommand } from "../src/import/emit";

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  const p = resolve(process.cwd(), ".env.local");
  if (existsSync(p)) for (const line of readFileSync(p, "utf8").split("\n")) {
    const s = line.trim(); if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("="); if (i < 0) continue;
    const k = s.slice(0, i).trim(); let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k && !env[k]) env[k] = v;
  }
  return env;
}
const env = loadEnv();
const flag = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const base = env.OPENAI_BASE_URL || "http://127.0.0.1:8080/v1";
const model = flag("model") || env.OPENAI_MODEL || "local";
const key = env.OPENAI_API_KEY || "local";
const isReasoning = /^(gpt-5|gpt-6|o[0-9])/.test(model);

async function call(messages: { role: string; content: string }[]): Promise<string> {
  const payload: Record<string, unknown> = { model, messages, response_format: { type: "json_object" } };
  if (isReasoning) payload.max_completion_tokens = 800; else { payload.max_tokens = 800; payload.temperature = 0; }
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
  });
  const j = (await r.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[] };
  return j.choices?.[0]?.message?.content ?? "";
}

// Each scenario: a setup that builds the session the model sees + a fresh instruction.
const T = "$t0";
const SCENARIOS: { setup: BoundCommand[]; utterance: string }[] = [
  { setup: [{ command: "create_track", args: { name: "Keys", type: "audio" }, bind: "t0" }],
    utterance: "yo drop a quick piano idea on the Keys track" },
  { setup: [{ command: "create_track", args: { name: "808", type: "audio" }, bind: "t0" }],
    utterance: "the 808 is way too loud, pull it back" },
  { setup: [], utterance: "let's run this at 92 bpm" },
  { setup: [{ command: "create_track", args: { name: "Hats", type: "audio" }, bind: "t0" }],
    utterance: "push the hats over to the right a bit" },
  { setup: [{ command: "create_track", args: { name: "Lead", type: "audio" }, bind: "t0" },
            { command: "add_midi_clip", args: { trackId: T, start: 0, length: 4 }, bind: "c0" }],
    utterance: "write me a little melody in that lead clip" },
  { setup: [], utterance: "make it sound professional" }, // should DEFER (HUH)
];

console.log(`▶ drive-local — model=${model} base=${base}\n`);
let clean = 0, acted = 0;
for (const sc of SCENARIOS) {
  __resetMockForTests();
  await mockExecute<CommandResult>({ command: "new_project", args: {} });
  await runBound(sc.setup, new Map<string, string>());
  const snap = await mockSnapshot<Snapshot>();
  const reply = await call([
    { role: "system", content: buildSystemPrompt(DEFAULT_RULES, snap) },
    { role: "user", content: sc.utterance },
  ]);
  const parsed = parseReply(reply);
  const cmds = parsed.commands ?? [];
  let ok = 0;
  for (const c of cmds) {
    if (validateCommand(c.command, c.args ?? {})) continue;
    const r = await mockExecute<CommandResult>({ command: c.command, args: c.args ?? {} });
    if (r.ok) ok++;
  }
  if (cmds.length) acted++;
  if (cmds.length && ok === cmds.length) clean++;
  const names = cmds.map((c) => c.command);
  const summary = cmds.length ? `${names.slice(0, 6).join(", ")}${names.length > 6 ? `, …(${names.length})` : ""}  [${ok}/${cmds.length} clean]` : "(defer)";
  console.log(`  🗣  ${sc.utterance}`);
  console.log(`  🤖  intent=${parsed.intent ?? "?"}  →  ${summary}\n`);
}
console.log(`acted on ${acted}/${SCENARIOS.length} (1 is a deliberate defer); clean-apply ${clean}/${acted}`);
