// SFT dataset builder — CLI.
//
//   cd ui && npm run build-sft -- --corpus ~/mosh-demo-projects --out ../service/sft/.sft-data/sft-v1
//   cd ui && npm run build-sft -- --corpus DIR --corpus DIR2 --tuples ~/Library/Mosh/session/tuples.jsonl \
//                                 --out OUT --split 80/10/10 --seed 1 --huh 0.08
//
// Walks DAW-project corpora into chat-format SFT JSONL via the byte-identical
// production prompt (ui/src/sft/buildDataset). Importer slices are the bulk
// (content-bearing); harvested tuples (if present) are folded into train; a small
// HUH/defer slice is added so the model learns when NOT to act. Writes
// train/valid/test.jsonl + test.eval.jsonl (verifier eval set) + manifest.json to
// a gitignored dir. Real volume needs the user's large local corpus.

import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, basename, extname } from "node:path";
import { createHash } from "node:crypto";
import { importPath } from "../src/import/importFile";
import { emitCommands } from "../src/import/emit";
import {
  sliceProgramFull, renderExample, tupleToExample, huhExamples, snapshotForSetup,
  splitBySource, toJsonl, evalJsonl, type RawExample, type RenderedExample,
} from "../src/sft/buildDataset";
import type { Snapshot } from "../src/types";
import type { Tuple } from "../src/harvest/tupleSchema";

const flag = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const flags = (n: string) => process.argv.flatMap((a, i) => (a === `--${n}` ? [process.argv[i + 1]] : []));

const corpora = flags("corpus");
if (corpora.length === 0) corpora.push(resolve(process.env.HOME ?? "", "mosh-demo-projects"));
const tuplesPath = flag("tuples");
const outDir = flag("out") || join(resolve(process.cwd(), ".."), "service", "training", "gepa", "generated", "sft");
const [trR, vaR, teR] = (flag("split", "80/10/10") as string).split("/").map(Number);
const seed = Number(flag("seed", "1"));
const huhFrac = Number(flag("huh", "0.08"));
const maxPerFile = Number(flag("max", "1000"));

function findProjects(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...findProjects(p));
    else if (/\.(rpp|als|flp)$/i.test(extname(name)) || /\.(rpp|als|flp)$/i.test(name)) out.push(p);
  }
  return out;
}

console.log(`▶ build-sft — corpora: ${corpora.join(", ")}`);

// ── importer slices ───────────────────────────────────────────────────────────
const raws: RawExample[] = [];
const files: string[] = [];
for (const dir of corpora) {
  for (const f of findProjects(dir)) {
    try {
      const program = emitCommands(importPath(f));
      const sliced = sliceProgramFull(program, basename(f), { max: maxPerFile });
      raws.push(...sliced);
      files.push(f);
      console.log(`  ${basename(f)}: ${sliced.length} tasks`);
    } catch (e) { console.error(`  ⚠ ${basename(f)}: ${String((e as Error)?.message ?? e)}`); }
  }
}

// render importer slices (drops any that don't cleanly apply)
const rendered: RenderedExample[] = [];
const rawById = new Map<string, RawExample>(); // id → raw (for the verifier eval set)
for (const r of raws) {
  const ex = await renderExample(r);
  if (ex) { rendered.push(ex); rawById.set(r.id, r); }
}
const renderedRaws = [...rawById.values()];
console.log(`  rendered ${rendered.length}/${raws.length} importer examples (dropped ${raws.length - rendered.length})`);

// ── tuples (train-only; near-zero today) ──────────────────────────────────────
const tupleExamples: RenderedExample[] = [];
if (tuplesPath && existsSync(tuplesPath)) {
  const lines = readFileSync(tuplesPath, "utf8").split("\n").filter((s) => s.trim());
  lines.forEach((l, i) => { try { const ex = tupleToExample(JSON.parse(l) as Tuple, i); if (ex) tupleExamples.push(ex); } catch { /* skip */ } });
  console.log(`  tuples: ${tupleExamples.length} clean examples from ${basename(tuplesPath)}`);
}

// ── HUH / defer slice ─────────────────────────────────────────────────────────
const huhTarget = Math.round(rendered.length * huhFrac);
const huhSnaps: Snapshot[] = [];
for (const r of renderedRaws) {
  if (huhSnaps.length >= huhTarget) break;
  const snap = await snapshotForSetup(r.startCommands);
  if (snap && snap.tracks.length > 0) huhSnaps.push(snap);
}
const huh = huhExamples(huhSnaps, huhTarget);
console.log(`  HUH/defer: ${huh.length} examples`);

// ── split (importer slices grouped by source) + assemble ──────────────────────
const split = splitBySource(rendered, [trR, vaR, teR], seed);
// tuples + HUH go to train (tuples are scarce; HUH spread mostly to train, a few to valid)
split.train.push(...tupleExamples, ...huh.slice(0, Math.ceil(huh.length * 0.8)));
split.valid.push(...huh.slice(Math.ceil(huh.length * 0.8)));

// eval set = exactly the importer-slice test examples (by id), which carry the
// startCommands the verifier needs to rebuild state. (tuples/HUH have no raw.)
const evalRaws = split.test.map((e) => rawById.get(e.id)).filter((r): r is RawExample => !!r);

// ── write ─────────────────────────────────────────────────────────────────────
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "train.jsonl"), toJsonl(split.train));
writeFileSync(join(outDir, "valid.jsonl"), toJsonl(split.valid));
writeFileSync(join(outDir, "test.jsonl"), toJsonl(split.test));
writeFileSync(join(outDir, "test.eval.jsonl"), evalJsonl(evalRaws));

const datasetVersion = `sft-${createHash("sha256").update(files.sort().join("|") + `:${seed}:${trR}/${vaR}/${teR}`).digest("hex").slice(0, 12)}`;
const manifest = {
  datasetVersion,
  createdFrom: corpora,
  sourceFiles: files.map((f) => ({ path: f, sha256: createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 16) })),
  counts: { train: split.train.length, valid: split.valid.length, test: split.test.length, evalSet: evalRaws.length, importer: rendered.length, tuples: tupleExamples.length, huh: huh.length },
  split: { ratios: [trR, vaR, teR], seed },
};
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log("\n================= SFT DATASET =================");
console.log(`version : ${datasetVersion}`);
console.log(`train   : ${split.train.length}   valid: ${split.valid.length}   test: ${split.test.length}   eval-set: ${evalRaws.length}`);
console.log(`sources : ${files.length} project file(s)`);
console.log(`\nwrote to ${outDir}/ : train.jsonl, valid.jsonl, test.jsonl, test.eval.jsonl, manifest.json`);
if (split.train.length === 0) console.error("\n⚠ empty train set — point --corpus at a directory of .rpp/.als/.flp projects.");
