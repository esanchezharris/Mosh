// Build the Rung-1 GRPO prompt set: a balanced, leakage-free pool of eval-shaped
// tasks (RL-train) plus the frozen gate, each dumped as the EXACT chat prompts the
// policy will answer (system = buildSystemPrompt, user = utterance — byte-identical
// to SFT training/eval so reward numbers stay comparable).
//
//   cd ui && npx tsx scripts/rl/buildRlPrompts.mts \
//     --gate ../service/sft/.sft-data/v2/test.eval.jsonl \
//     --pool ../service/sft/.sft-data/v2-daw/test.eval.jsonl \
//     --pool ../service/sft/.sft-data/v2-midi/test.eval.jsonl \
//     --pool ../service/sft/.sft-data/daw/test.eval.jsonl \
//     --pool ../service/sft/.sft-data/midi/test.eval.jsonl \
//     --out ../service/sft/.rl-data/rl-v1 [--per-shape 250] [--max 0] [--seed 1]
//
// Writes into <out>/:
//   rl_train.eval.jsonl     EvalExample[]   (for the reward scorer)
//   rl_train.prompts.jsonl  {id, messages}  (for the mlx trainer's generation)
//   gate.eval.jsonl         EvalExample[]   (frozen held-out, copied through)
//   gate.prompts.jsonl      {id, messages}  (for periodic gate eval generation)
//   manifest.json

import { readFileSync, existsSync, mkdirSync, writeFileSync, openSync, writeSync, closeSync } from "node:fs";
import { resolve, join } from "node:path";
import { buildExamplePrompt } from "../../src/gepa/metric";
import { DEFAULT_RULES } from "../../src/agent/brainCore";
import { buildRlPromptSet } from "../../src/rl/prompts";
import type { EvalExample } from "../../src/gepa/evalset";

const flag = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const flags = (n: string) => process.argv.flatMap((a, i) => (a === `--${n}` ? [process.argv[i + 1]] : []));

const loadEval = (p: string): EvalExample[] =>
  readFileSync(p, "utf8").split("\n").filter((s) => s.trim()).map((l) => JSON.parse(l) as EvalExample);

const gatePath = flag("gate");
const poolPaths = flags("pool");
const outDir = flag("out");
if (!gatePath || !existsSync(gatePath)) { console.error(`--gate <test.eval.jsonl> required (got ${gatePath})`); process.exit(1); }
if (poolPaths.length === 0) { console.error("at least one --pool <test.eval.jsonl> required"); process.exit(1); }
if (!outDir) { console.error("--out <dir> required"); process.exit(1); }

const perShapeCap = Number(flag("per-shape", "250")) || 250;
const max = Number(flag("max", "0")) || 0;
const seed = Number(flag("seed", "1")) || 1;

const gate = loadEval(gatePath);
const pools: EvalExample[] = [];
for (const p of poolPaths) { if (existsSync(p)) pools.push(...loadEval(p)); else console.warn(`  ⚠ pool not found: ${p}`); }

const { examples: rlTrain, stats } = buildRlPromptSet(pools, gate, { perShapeCap, max, seed });
console.log(`▶ build-rl-prompts — pool ${stats.poolSize} → kept ${rlTrain.length} (dropped ${stats.droppedLeakage} leakage, ${stats.droppedDup} dup; ${stats.gateSources} gate sources excluded)`);
console.log(`  per-shape: ${JSON.stringify(stats.perShape)}`);
console.log(`  gate: ${gate.length} frozen held-out tasks`);

mkdirSync(outDir, { recursive: true });

async function dumpPrompts(path: string, exs: EvalExample[]): Promise<void> {
  const fd = openSync(path, "w");
  for (const ex of exs) writeSync(fd, JSON.stringify({ id: ex.id, messages: await buildExamplePrompt(DEFAULT_RULES, ex) }) + "\n");
  closeSync(fd);
}
const dumpEval = (path: string, exs: EvalExample[]) =>
  writeFileSync(path, exs.map((e) => JSON.stringify({ id: e.id, utterance: e.utterance, startCommands: e.startCommands, goldCommandNames: e.goldCommandNames })).join("\n") + "\n");

dumpEval(join(outDir, "rl_train.eval.jsonl"), rlTrain);
dumpEval(join(outDir, "gate.eval.jsonl"), gate);
await dumpPrompts(join(outDir, "rl_train.prompts.jsonl"), rlTrain);
await dumpPrompts(join(outDir, "gate.prompts.jsonl"), gate);

const manifest = {
  builtFrom: { gate: resolve(gatePath), pools: poolPaths.map((p) => resolve(p)) },
  counts: { rlTrain: rlTrain.length, gate: gate.length },
  balance: { perShapeCap, perShape: stats.perShape, droppedLeakage: stats.droppedLeakage, droppedDup: stats.droppedDup },
  seed,
};
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`\nwrote ${outDir}/ : rl_train.eval.jsonl, rl_train.prompts.jsonl, gate.eval.jsonl, gate.prompts.jsonl, manifest.json`);
