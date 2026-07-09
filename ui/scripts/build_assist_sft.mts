// Fold the engine-verified assist-feature demonstrations into SFT training data for the
// NEXT job (does NOT touch the running r4 / s2-mix-v4 dataset). Emits mlx_lm chat JSONL
// ({messages:[system,user,assistant]}) in the SAME shape buildDataset.ts produces:
//   - system  = buildSystemPrompt(DEFAULT_RULES, fixtureSnapshot)  ← byte-identical to prod
//   - user    = the plain-English ask
//   - assistant = the exact parseReply contract {intent, commands}, engine-verified
// Each example is self-checked (validateCommand + parseReply round-trip) before writing.
//
//   from ui/:  npx tsx scripts/build_assist_sft.mts
//   → service/sft/assist_demonstrations.jsonl  (merge into the next dataset build)

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSystemPrompt, DEFAULT_RULES, parseReply } from "../src/agent/brainCore";
import { validateCommand } from "../src/agent/commands";
import type { Snapshot } from "../src/types";

const REPO = resolve(process.cwd(), "..");
const A = resolve(REPO, "service/sft/assist_fixtures");
const ledger = JSON.parse(readFileSync(resolve(A, "ledger.json"), "utf8")) as {
  rows: { key: string; cluster: string; ask: string; ok: boolean; commands: { command: string; args: Record<string, unknown> }[] }[];
};
const roles = JSON.parse(readFileSync(resolve(A, "fixture_roles.json"), "utf8")) as Record<string, string>;
const snap = JSON.parse(readFileSync(resolve(A, "fixture_snap.json"), "utf8")) as Snapshot;
const SYSTEM = buildSystemPrompt(DEFAULT_RULES, snap);

// ${MEL_C} → the fixture's real engine id, so the trained target references the same
// ids the rendered system prompt shows (the model learns ask → concrete commands).
function concretize(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") {
      const m = v.match(/^\$\{(\w+)\}$/);
      out[k] = m && roles[m[1]] ? roles[m[1]] : v;
    } else out[k] = v;
  }
  return out;
}

const lines: string[] = [];
let skipped = 0;
for (const row of ledger.rows) {
  if (!row.ok) { skipped++; continue; }
  const commands = row.commands.map((c) => ({ command: c.command, args: concretize(c.args) }));
  const bad = commands.map((c) => validateCommand(c.command, c.args)).filter(Boolean);
  if (bad.length) { console.warn(`skip ${row.key}: ${bad.join("; ")}`); skipped++; continue; }
  const assistant = JSON.stringify({ intent: "ACK_GOT_IT", commands });
  const round = parseReply(assistant);
  if (!round.commands || round.commands.length !== commands.length) { console.warn(`skip ${row.key}: parseReply round-trip mismatch`); skipped++; continue; }
  lines.push(JSON.stringify({ messages: [
    { role: "system", content: SYSTEM },
    { role: "user", content: row.ask },
    { role: "assistant", content: assistant },
  ] }));
}

const out = resolve(REPO, "service/sft/assist_demonstrations.jsonl");
writeFileSync(out, lines.join("\n") + "\n");
console.log(`wrote ${lines.length} verified assist demonstrations (${skipped} skipped) → ${out}`);
console.log("clusters:", [...new Set(ledger.rows.map((r) => r.cluster))].join(", "));
