// The Python↔TS reward bridge for the GRPO loop. Reads a batch of policy rollouts
// (one per sampled completion) and scores each with the SAME clean-apply verifier the
// SFT eval uses (src/rl/score.ts → gepa/metric.scoreReply). Stdin/file in, file out;
// the mlx trainer shells this once per optimization step.
//
//   npx tsx scripts/rl/scoreRollouts.mts --eval rl_train.eval.jsonl \
//       --rollouts step.rollouts.jsonl --out step.rewards.jsonl
//
// rollouts.jsonl : {"exId": "...", "sampleId": "...", "content": "<model reply>"}
// rewards.jsonl  : {"sampleId": "...", "reward": 0.0-1.0, "deferred": bool}

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { scoreRollout } from "../../src/rl/score";
import type { EvalExample } from "../../src/gepa/evalset";

const flag = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };

const evalPath = flag("eval");
const rolloutsPath = flag("rollouts");
const outPath = flag("out");
if (!evalPath || !existsSync(evalPath)) { console.error(`--eval <rl_train.eval.jsonl> required (got ${evalPath})`); process.exit(1); }
if (!rolloutsPath || !existsSync(rolloutsPath)) { console.error(`--rollouts <jsonl> required (got ${rolloutsPath})`); process.exit(1); }
if (!outPath) { console.error("--out <rewards.jsonl> required"); process.exit(1); }

const byId = new Map<string, EvalExample>();
for (const l of readFileSync(evalPath, "utf8").split("\n")) {
  const s = l.trim(); if (!s) continue;
  const ex = JSON.parse(s) as EvalExample;
  byId.set(ex.id, ex);
}

const rollouts = readFileSync(rolloutsPath, "utf8").split("\n").filter((s) => s.trim()).map((l) => JSON.parse(l) as { exId: string; sampleId: string; content: string });

const out: string[] = [];
for (const r of rollouts) {
  const ex = byId.get(r.exId);
  if (!ex) { out.push(JSON.stringify({ sampleId: r.sampleId, reward: 0, deferred: true, feedback: `unknown exId ${r.exId}` })); continue; }
  const s = await scoreRollout(ex, r.content ?? "");
  out.push(JSON.stringify({ sampleId: r.sampleId, reward: s.reward, deferred: s.deferred, feedback: s.feedback }));
}
writeFileSync(outPath, out.join("\n") + "\n");
console.log(`scored ${rollouts.length} rollouts → ${outPath}`);
