// Assemble the Stage-2 training mix (s2-mix) per the pre-registered rules
// (docs/bench/PROGRAM_STAGE1_2026-07.md §P2): base corpus train + all synthesis
// chunk files + negatives, populate-class rows capped (seeded), content-deduped.
// Valid split = the base corpus valid untouched (synthesis rows are train-only:
// they are all generated against a handful of fixture sessions and would
// inflate validation). Eval-profile synthesis outputs (eval-*.jsonl) are
// EXCLUDED by pattern — they belong to frozen-eval-v2 §A only.
//
// STREAMING: the base train.jsonl exceeds Node's single-string ceiling
// (ERR_STRING_TOO_LONG on readFileSync), so sources are read line-by-line and
// non-populate rows are appended to the output as they pass dedupe; only the
// populate-class candidate lines are held for the seeded cap sample.
//
//   cd ui && npx tsx scripts/assembleMix.mts --base ../service/sft/.sft-data/s1-bt \
//     [--synth ../service/sft/.sft-data/synth] [--out ../service/sft/.sft-data/s2-mix] \
//     [--cap 2000] [--seed 1]

import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, createReadStream, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { isPopulateClassRow, rowCommandNames, seededSample, type ChatRow } from "../src/sft/mixAssembly";
import { argFlag } from "./lib/realEngine.mts";

const base = resolve(argFlag("base") ?? join("..", "service", "sft", ".sft-data", "s1-bt"));
const synthDir = resolve(argFlag("synth") ?? join("..", "service", "sft", ".sft-data", "synth"));
const outDir = resolve(argFlag("out") ?? join("..", "service", "sft", ".sft-data", "s2-mix"));
const cap = Number(argFlag("cap", "2000"));
const seed = Number(argFlag("seed", "1"));

mkdirSync(outDir, { recursive: true });
const trainPath = join(outDir, "train.jsonl");
writeFileSync(trainPath, "");

const seen = new Set<string>();
const populateLines: string[] = [];
const perCommand: Record<string, number> = {};
const sources: Record<string, number> = {};
let input = 0, deduped = 0, written = 0;
let buffer: string[] = [];

function flush(): void {
  if (buffer.length) { appendFileSync(trainPath, buffer.join("\n") + "\n"); buffer = []; }
}
function countRow(row: ChatRow): void {
  for (const n of new Set(rowCommandNames(row))) perCommand[n] = (perCommand[n] ?? 0) + 1;
}

async function ingest(path: string, label: string): Promise<void> {
  let n = 0;
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    input++; n++;
    const h = createHash("sha256").update(line).digest("hex");
    if (seen.has(h)) { deduped++; continue; }
    seen.add(h);
    const row = JSON.parse(line) as ChatRow;
    if (isPopulateClassRow(row)) { populateLines.push(line); continue; }
    countRow(row);
    buffer.push(line);
    written++;
    if (buffer.length >= 5000) flush();
  }
  sources[label] = n;
}

await ingest(join(base, "train.jsonl"), join(basename(base), "train.jsonl"));
for (const f of readdirSync(synthDir).filter((f) => f.endsWith(".jsonl") && !f.startsWith("eval-")).sort()) {
  await ingest(join(synthDir, f), `synth/${f}`);
}

const keptPopulate = seededSample(populateLines, cap, seed);
for (const line of keptPopulate) { countRow(JSON.parse(line) as ChatRow); buffer.push(line); written++; }
flush();

copyFileSync(join(base, "valid.jsonl"), join(outDir, "valid.jsonl"));

const fileSha = (p: string) => {
  const h = createHash("sha256");
  // hash in chunks (train.jsonl can exceed the single-buffer read too)
  const fd = readFileSync(p); // Buffer read is fine up to ~2GB; train ≈ 1.5GB
  h.update(fd);
  return h.digest("hex");
};
const manifest = {
  base, synthDir, populateCap: cap, seed, sources,
  stats: { input, deduped, populateSeen: populateLines.length, populateKept: keptPopulate.length, output: written, perCommand },
  sha256: { "train.jsonl": fileSha(trainPath), "valid.jsonl": fileSha(join(outDir, "valid.jsonl")) },
};
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`mix: ${input} in → ${written} out (deduped ${deduped}, populate ${populateLines.length}→${keptPopulate.length})`);
console.log(`commands covered: ${Object.keys(perCommand).length}`);
console.log(`→ ${trainPath}`);
