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
import { isHuhRow, isPopulateClassRow, oversampleRare, rowCommandNames, seededSample, type ChatRow } from "../src/sft/mixAssembly";
import { argFlag } from "./lib/realEngine.mts";

const base = resolve(argFlag("base") ?? join("..", "service", "sft", ".sft-data", "s1-bt"));
const synthDir = resolve(argFlag("synth") ?? join("..", "service", "sft", ".sft-data", "synth"));
const outDir = resolve(argFlag("out") ?? join("..", "service", "sft", ".sft-data", "s2-mix"));
const cap = Number(argFlag("cap", "2000"));
// Post-dedupe HUH cap (defensive; r1's real HUH level was ~1.1% post-dedupe).
const huhCap = Number(argFlag("huh-cap", "900"));
// r1 exit-gate lesson: rare commands (undo 53 rows) collapse to degenerate JSON
// against 61k-row gravity — oversample rows of any command below the threshold.
const osBelow = Number(argFlag("oversample-below", "100"));
const osFactor = Number(argFlag("oversample-factor", "4"));
const seed = Number(argFlag("seed", "1"));

mkdirSync(outDir, { recursive: true });
const trainPath = join(outDir, "train.jsonl");
writeFileSync(trainPath, "");

const seen = new Set<string>();
const populateLines: string[] = [];
const huhLines: string[] = [];
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
    if (isHuhRow(row)) { huhLines.push(line); continue; }
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
const keptHuh = seededSample(huhLines, huhCap, seed + 1);
for (const line of [...keptHuh, ...keptPopulate]) { countRow(JSON.parse(line) as ChatRow); buffer.push(line); written++; }
flush();

// oversample rare commands over the FULL post-cap output (streamed back in)
let boosted: Record<string, number> = {};
if (osFactor > 1) {
  const all: ChatRow[] = [];
  const rl2 = createInterface({ input: createReadStream(trainPath), crlfDelay: Infinity });
  const lines: string[] = [];
  for await (const line of rl2) { if (line.trim()) { lines.push(line); all.push(JSON.parse(line) as ChatRow); } }
  const res = oversampleRare(all, osBelow, osFactor);
  boosted = res.boosted;
  const extraLines: string[] = [];
  // extras reference row objects; re-serialize via index mapping (same order as `all`)
  let k = 0;
  for (let i = 0; i < all.length; i++) {
    const names = new Set(rowCommandNames(all[i]));
    const rare = Object.keys(boosted);
    if (![...names].some((n) => rare.includes(n))) continue;
    for (let c = 1; c < osFactor; c++) extraLines.push(lines[i]);
    k++;
  }
  if (extraLines.length) {
    appendFileSync(trainPath, extraLines.join("\n") + "\n");
    for (const line of extraLines) { countRow(JSON.parse(line) as ChatRow); written++; }
  }
  console.log(`oversampled ${k} rare-command rows ×${osFactor} (+${extraLines.length} rows) across ${Object.keys(boosted).length} commands`);
}

copyFileSync(join(base, "valid.jsonl"), join(outDir, "valid.jsonl"));

const fileSha = (p: string) => {
  const h = createHash("sha256");
  // hash in chunks (train.jsonl can exceed the single-buffer read too)
  const fd = readFileSync(p); // Buffer read is fine up to ~2GB; train ≈ 1.5GB
  h.update(fd);
  return h.digest("hex");
};
const manifest = {
  base, synthDir, populateCap: cap, huhCap, oversample: { below: osBelow, factor: osFactor, boosted }, seed, sources,
  stats: { input, deduped, populateSeen: populateLines.length, populateKept: keptPopulate.length, huhSeen: huhLines.length, huhKept: keptHuh.length, output: written, perCommand },
  sha256: { "train.jsonl": fileSha(trainPath), "valid.jsonl": fileSha(join(outDir, "valid.jsonl")) },
};
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`mix: ${input} in → ${written} out (deduped ${deduped}, populate ${populateLines.length}→${keptPopulate.length}, huh ${huhLines.length}→${keptHuh.length})`);
console.log(`commands covered: ${Object.keys(perCommand).length}`);
console.log(`→ ${trainPath}`);
