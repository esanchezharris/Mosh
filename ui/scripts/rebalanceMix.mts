// Rebalance the Stage-2 mix for epoch-scale exposure (§P7 amendment,
// docs/bench/PROGRAM_STAGE1_2026-07.md): the r2 HALT's root cause was 3 head
// commands owning 80.6% of s2-mix-v2, making a full epoch wall-clock
// infeasible at batch 1 (≈14 days). A flat per-command cap collapses the mix
// to ~14k rows so every row gets ≥1 look in ~3 days. HUH rows are re-capped
// with grounding NEGATIVES prioritized over generic vague-request HUH (the §B
// negative-defer signal), both seeded. NO dedupe — v2 is already deduped and
// its rare-row oversample duplicates are intentional.
//
// Negative rows are identified by exact line hash against synth/negs-*.jsonl
// (assembleMix wrote source lines verbatim, so hashes match byte-for-byte).
//
//   cd ui && npx tsx scripts/rebalanceMix.mts \
//     [--in ../service/sft/.sft-data/s2-mix-v2] [--negs ../service/sft/.sft-data/synth] \
//     [--out ../service/sft/.sft-data/s2-mix-v3] \
//     [--cap-per-command 400] [--neg-cap 200] [--generic-huh-cap 50] [--seed 1]

import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { isHuhRow, rebalanceSelect, rowCommandNames, type ChatRow, type MixRowMeta, type RebalanceStats } from "../src/sft/mixAssembly";
import { argFlag } from "./lib/realEngine.mts";

const inDir = resolve(argFlag("in") ?? join("..", "service", "sft", ".sft-data", "s2-mix-v2"));
const negsDir = resolve(argFlag("negs") ?? join("..", "service", "sft", ".sft-data", "synth"));
const outDir = resolve(argFlag("out") ?? join("..", "service", "sft", ".sft-data", "s2-mix-v3"));
const capPerCommand = Number(argFlag("cap-per-command", "400"));
const negCap = Number(argFlag("neg-cap", "200"));
const genericHuhCap = Number(argFlag("generic-huh-cap", "50"));
const seed = Number(argFlag("seed", "1"));

const lineHash = (line: string): string => createHash("sha256").update(line).digest("hex");

// Grounding-negative identity: exact line hashes from the negs chunk files.
const negHashes = new Set<string>();
for (const f of readdirSync(negsDir).filter((f) => /^negs-.*\.jsonl$/.test(f)).sort()) {
  for (const line of readFileSync(join(negsDir, f), "utf8").split("\n")) {
    if (line.trim()) negHashes.add(lineHash(line));
  }
}
console.log(`negative line hashes: ${negHashes.size}`);

mkdirSync(outDir, { recursive: true });

async function rebalanceFile(name: string): Promise<{ stats: RebalanceStats; inputSha: string; outputSha: string }> {
  const lines: string[] = [];
  const metas: MixRowMeta[] = [];
  const inputHasher = createHash("sha256");
  const rl = createInterface({ input: createReadStream(join(inDir, name)), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    inputHasher.update(line).update("\n");
    const row = JSON.parse(line) as ChatRow;
    lines.push(line);
    metas.push({ commands: rowCommandNames(row), huh: isHuhRow(row), negative: negHashes.has(lineHash(line)) });
  }
  const { keep, stats } = rebalanceSelect(metas, { capPerCommand, negCap, genericHuhCap, seed });
  const kept = lines.filter((_, i) => keep[i]); // original file order
  writeFileSync(join(outDir, name), kept.join("\n") + "\n");
  console.log(`${name}: ${stats.input} -> ${stats.kept} (huh neg ${stats.huhNegKept}/${stats.huhNegSeen}, generic ${stats.huhGenericKept}/${stats.huhGenericSeen}, other ${stats.otherKept})`);
  return {
    stats,
    inputSha: inputHasher.digest("hex"),
    outputSha: lineHash(kept.join("\n") + "\n"),
  };
}

const train = await rebalanceFile("train.jsonl");
const valid = await rebalanceFile("valid.jsonl");

const manifest = {
  amendedFrom: inDir,
  params: { capPerCommand, negCap, genericHuhCap, seed },
  negsFiles: readdirSync(negsDir).filter((f) => /^negs-.*\.jsonl$/.test(f)).sort(),
  negHashes: negHashes.size,
  input: { "train.jsonl": train.inputSha, "valid.jsonl": valid.inputSha },
  stats: { "train.jsonl": train.stats, "valid.jsonl": valid.stats },
  sha256: { "train.jsonl": train.outputSha, "valid.jsonl": valid.outputSha },
};
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`manifest -> ${join(outDir, "manifest.json")}`);
