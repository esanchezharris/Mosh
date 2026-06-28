// Rung-2 audio reward bridge — the TS side. Same CLI shape as scoreRollouts.mts
// (--eval/--rollouts/--out), so the GRPO trainer shells THIS instead by changing one
// script name. Per rollout it builds the id-correct native render program
// (buildRenderProgram: startCommands→capture/${VAR}, reply ids remapped, +export_audio),
// handles deferrals here (no commands → reward 0, no render), then hands the renderable
// batch to the warm Python scorer (service/rl/score_audio_cli.py → Oracle render +
// teardown Reward) and merges the results back into the exact rewards.jsonl schema.
//
//   npx tsx scripts/rl/scoreRolloutsAudio.mts --eval rl_train.eval.jsonl \
//       --rollouts step.rollouts.jsonl --out step.rewards.jsonl
//
// Env: TEARDOWN_PY (teardown venv), MOSH_BIN (else /Applications/Mosh.app),
//      MOSH_RL_REWARD_MODE=floor|musical (default floor). Run with cwd=ui (as grpo.py does).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { buildRenderProgram } from "../../src/rl/buildRenderProgram";
import type { EvalExample } from "../../src/gepa/evalset";

const flag = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };

const evalPath = flag("eval");
const rolloutsPath = flag("rollouts");
const outPath = flag("out");
if (!evalPath || !existsSync(evalPath)) { console.error(`--eval required (got ${evalPath})`); process.exit(1); }
if (!rolloutsPath || !existsSync(rolloutsPath)) { console.error(`--rollouts required (got ${rolloutsPath})`); process.exit(1); }
if (!outPath) { console.error("--out required"); process.exit(1); }

const REPO = resolve(process.cwd(), "..");
const SERVICE = join(REPO, "service");

/** TEARDOWN_PY from the env, else parsed from service/teardown/.teardown.env. */
function teardownPy(): string {
  if (process.env.TEARDOWN_PY) return process.env.TEARDOWN_PY;
  const envFile = join(SERVICE, "teardown", ".teardown.env");
  if (existsSync(envFile)) {
    const m = readFileSync(envFile, "utf8").match(/TEARDOWN_PY="?([^"\n]+)"?/);
    if (m) return m[1];
  }
  throw new Error("TEARDOWN_PY not set and service/teardown/.teardown.env missing — run setup-teardown.sh");
}

const byId = new Map<string, EvalExample>();
for (const l of readFileSync(evalPath, "utf8").split("\n")) {
  const s = l.trim(); if (!s) continue;
  const ex = JSON.parse(s) as EvalExample;
  byId.set(ex.id, ex);
}
const rollouts = readFileSync(rolloutsPath, "utf8").split("\n").filter((s) => s.trim())
  .map((l) => JSON.parse(l) as { exId: string; sampleId: string; content: string });

const work = join(dirname(resolve(outPath)), "audio");
mkdirSync(work, { recursive: true });

type Reward = { sampleId: string; reward: number; deferred: boolean; feedback: string };
const deferredOut: Reward[] = [];
const batch: { sampleId: string; program: unknown[]; wav: string }[] = [];

for (const r of rollouts) {
  const ex = byId.get(r.exId);
  if (!ex) { deferredOut.push({ sampleId: r.sampleId, reward: 0, deferred: true, feedback: `unknown exId ${r.exId}` }); continue; }
  const wav = join(work, `${r.sampleId}.wav`);
  const prog = await buildRenderProgram(ex, r.content ?? "", wav);
  if (prog.deferred) {
    deferredOut.push({ sampleId: r.sampleId, reward: 0, deferred: true, feedback: `DEFERRED on "${ex.utterance}"` });
  } else {
    batch.push({ sampleId: r.sampleId, program: prog.lines, wav });
  }
}

const scored: Reward[] = [];
if (batch.length > 0) {
  const batchPath = join(work, "batch.jsonl");
  const partialPath = join(work, "rewards.partial.jsonl");
  writeFileSync(batchPath, batch.map((b) => JSON.stringify(b)).join("\n") + "\n");
  const mode = process.env.MOSH_RL_REWARD_MODE === "musical" ? "musical" : "floor";
  execFileSync(
    teardownPy(),
    [join(SERVICE, "rl", "score_audio_cli.py"), "--batch", batchPath, "--out", partialPath,
      "--reward", mode, "--cache", join(work, "render_cache.json")],
    { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, PYTHONPATH: SERVICE } },
  );
  for (const l of readFileSync(partialPath, "utf8").split("\n")) {
    const s = l.trim(); if (!s) continue;
    scored.push(JSON.parse(s) as Reward);
  }
}

// merge, preserving the rollout order grpo.py expects (it maps by sampleId, so order is cosmetic)
const bySample = new Map<string, Reward>([...deferredOut, ...scored].map((r) => [r.sampleId, r]));
const out = rollouts.map((r) => bySample.get(r.sampleId) ?? { sampleId: r.sampleId, reward: 0, deferred: true, feedback: "missing" });
writeFileSync(outPath, out.map((o) => JSON.stringify(o)).join("\n") + "\n");
console.log(`scored ${rollouts.length} rollouts (${batch.length} rendered, ${deferredOut.length} deferred) → ${outPath}`);
