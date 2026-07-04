// SFT dataset builder — CLI. Walks DAW-project + MIDI corpora into chat-format
// SFT JSONL via the byte-identical production prompt (ui/src/sft/buildDataset).
//
//   cd ui && npm run build-sft -- --corpus ~/mosh-corpus --out ../service/sft/.sft-data/sft-v2
//   # scale controls for big corpora (e.g. Lakh's 178k MIDI):
//   cd ui && npm run build-sft -- --corpus ~/mosh-corpus --sample 12000 --limit 60000 --out OUT
//
// Sources: importer slices (.flp/.als/.rpp/.mid/.midi) are the bulk; harvested
// tuples (if present) fold into train; a small HUH/defer slice teaches when not to
// act. Writes train/valid/test.jsonl + test.eval.jsonl + manifest.json (gitignored).

import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, writeFileSync, openSync, writeSync, closeSync } from "node:fs";
import { resolve, join, basename, extname } from "node:path";
import { createHash } from "node:crypto";
import { importPath } from "../src/import/importFile";
import { emitCommands } from "../src/import/emit";
import {
  sliceProgramFull, renderExample, tupleToExample, huhExamples, snapshotForSetup,
  splitBySource, type RawExample, type RenderedExample,
} from "../src/sft/buildDataset";
import { Backtranslator, BT_STYLES, makeBrainChat, loadDotEnv } from "../src/sft/backtranslate";

// Stream JSONL to disk in chunks — a single .map().join() over ~100k examples
// (each carrying a ~10KB system prompt) overflows V8's max string length.
function writeRows<T>(path: string, rows: T[], toLine: (r: T) => string): void {
  const fd = openSync(path, "w");
  const CHUNK = 2000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    let buf = "";
    for (let j = i; j < Math.min(i + CHUNK, rows.length); j++) buf += toLine(rows[j]) + "\n";
    writeSync(fd, buf);
  }
  closeSync(fd);
}
import type { Snapshot } from "../src/types";
import type { Tuple } from "../src/harvest/tupleSchema";

const flag = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const flags = (n: string) => process.argv.flatMap((a, i) => (a === `--${n}` ? [process.argv[i + 1]] : []));
const hashStr = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h; };

const corpora = flags("corpus");
if (corpora.length === 0) corpora.push(resolve(process.env.HOME ?? "", "mosh-demo-projects"));
const tuplesPath = flag("tuples");
const outDir = flag("out") || join(resolve(process.cwd(), ".."), "service", "training", "gepa", "generated", "sft");
const [trR, vaR, teR] = (flag("split", "80/10/10") as string).split("/").map(Number);
const seed = Number(flag("seed", "1"));
const huhFrac = Number(flag("huh", "0.015")); // was 0.05 — the 5% defer slice over-generalized into deferring on plain imperatives (2026-07 audit)
const maxPerFile = Number(flag("max", "1000"));
const sampleN = Number(flag("sample", "0")) || Infinity;  // cap files processed
const limitN = Number(flag("limit", "0")) || Infinity;    // cap rendered examples
const maxNotes = Number(flag("max-notes", "0")) || undefined; // cap a populate target's note count (default 64 in the slicer) — align "short pattern" targets with the fair-metric floor
// Back-translation: --backtranslate [budget] enables brain-synthesized natural
// utterances (the chosen brain rewrites each distinct templated SHAPE once → reused
// across the whole corpus). --bt-variants N = phrasings per shape. Cache persists to
// <out>/bt_cache.json so re-runs never re-pay. Off unless the flag is present.
const btEnabled = process.argv.includes("--backtranslate");
const btBudget = Number(flag("backtranslate", "60")) || 60; // max brain calls (≈ distinct shapes)
const btVariants = Number(flag("bt-variants", "3")) || 3;
// --bt-styles → one call per style per shape (terse↔verbose axis; program Stage 1.1).
// Budget then counts CALLS (shapes × styles), so size --backtranslate accordingly.
const btStyles = process.argv.includes("--bt-styles");

const EXT = /\.(rpp|als|flp|mid|midi)$/i;
function findProjects(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let s; try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) findProjects(p, out);
    else if (EXT.test(extname(name)) || EXT.test(name)) out.push(p);
  }
  return out;
}

console.log(`▶ build-sft — corpora: ${corpora.join(", ")}`);
const allFiles: string[] = [];
for (const dir of corpora) findProjects(dir, allFiles); // accumulate in place (corpus can be 100k+ files)
// deterministic shuffle (so a --sample is spread across the corpus, not one subdir)
allFiles.sort((a, b) => hashStr(`${seed}:${a}`) - hashStr(`${seed}:${b}`));
const files = allFiles.slice(0, sampleN);
console.log(`  ${allFiles.length} project/MIDI file(s) found; processing ${files.length}${limitN < Infinity ? ` (cap ${limitN} examples)` : ""}\n`);

// ── back-translation (the brain-unlocked step) ─────────────────────────────────
// Synthesizes natural producer utterances for each distinct templated SHAPE once,
// reused across the whole corpus. Persisted cache → re-runs never re-pay the brain.
const btCachePath = join(outDir, "bt_cache.json");
let bt: Backtranslator | null = null;
let btCount = 0;
if (btEnabled) {
  const chat = makeBrainChat(loadDotEnv(process.cwd()));
  if (!chat) {
    console.warn("  ⚠ --backtranslate set but no brain key (ui/.env.local) — falling back to templated utterances only");
  } else {
    const cache = new Map<string, string[]>();
    if (existsSync(btCachePath)) try { for (const [k, v] of Object.entries(JSON.parse(readFileSync(btCachePath, "utf8")))) cache.set(k, v as string[]); } catch { /* ignore */ }
    bt = new Backtranslator(chat, {
      variants: btVariants, styles: btStyles ? BT_STYLES : undefined, budget: { calls: btBudget }, cache,
      onShape: (s, t) => console.log(`  ↳ backtranslate "${s}" → ${t.length} phrasing(s)`),
    });
    console.log(`  back-translation ON (budget ${btBudget} brain calls, ${btVariants} variant(s)/shape${cache.size ? `, ${cache.size} cached shape(s)` : ""})`);
  }
}

// ── importer slices → render, interleaved, capped at --limit ───────────────────
const rendered: RenderedExample[] = [];
const rawById = new Map<string, RawExample>();
const used: string[] = []; // files that contributed at least one example (for the manifest)
let processed = 0;
for (const f of files) {
  if (rendered.length >= limitN) break;
  processed++;
  let raws: RawExample[] = [];
  try { raws = sliceProgramFull(emitCommands(importPath(f)), `${basename(f)}@${hashStr(f) % 100000}`, { max: maxPerFile, maxNotes }); }
  catch { /* unparseable file — skip */ }
  let contributed = false;
  for (const r of raws) {
    if (rendered.length >= limitN) break;
    const ex = await renderExample(r);
    if (!ex) continue; // only augment raws that themselves render cleanly
    rendered.push(ex); rawById.set(r.id, r); contributed = true;
    if (bt) for (const v of await bt.variantsFor(r)) {
      if (rendered.length >= limitN) break;
      const vex = await renderExample(v);
      if (vex) { rendered.push(vex); rawById.set(v.id, v); btCount++; }
    }
  }
  if (contributed) used.push(f);
  if (processed % 1000 === 0) console.log(`  …${processed}/${files.length} files, ${rendered.length} examples`);
}
console.log(`  rendered ${rendered.length} importer examples (${btCount} back-translated) from ${used.length}/${processed} processed files`);

// ── tuples (train-only) ────────────────────────────────────────────────────────
const tupleExamples: RenderedExample[] = [];
if (tuplesPath && existsSync(tuplesPath)) {
  readFileSync(tuplesPath, "utf8").split("\n").filter((s) => s.trim()).forEach((l, i) => {
    try { const ex = tupleToExample(JSON.parse(l) as Tuple, i); if (ex) tupleExamples.push(ex); } catch { /* skip */ }
  });
  console.log(`  tuples: ${tupleExamples.length} clean examples`);
}

// ── HUH / defer slice ──────────────────────────────────────────────────────────
const huhTarget = Math.round(rendered.length * huhFrac);
const huhSnaps: Snapshot[] = [];
for (const r of rawById.values()) {
  if (huhSnaps.length >= huhTarget) break;
  const snap = await snapshotForSetup(r.startCommands);
  if (snap && snap.tracks.length > 0) huhSnaps.push(snap);
}
const huh = huhExamples(huhSnaps, huhTarget);
console.log(`  HUH/defer: ${huh.length} examples`);

// ── split + assemble ───────────────────────────────────────────────────────────
const split = splitBySource(rendered, [trR, vaR, teR], seed);
split.train.push(...tupleExamples, ...huh.slice(0, Math.ceil(huh.length * 0.8)));
split.valid.push(...huh.slice(Math.ceil(huh.length * 0.8)));
const evalRaws = split.test.map((e) => rawById.get(e.id)).filter((r): r is RawExample => !!r);

mkdirSync(outDir, { recursive: true });
// persist the back-translation cache (shape → natural phrasings) so re-runs reuse it
if (bt) try { writeFileSync(btCachePath, JSON.stringify(Object.fromEntries(bt.cacheEntries()), null, 0)); } catch { /* non-fatal */ }
const chatLine = (e: RenderedExample) => JSON.stringify({ messages: e.messages });
const metaLine = (e: RenderedExample) => JSON.stringify({ id: e.id, sourceId: e.sourceId });
writeRows(join(outDir, "train.jsonl"), split.train, chatLine);
writeRows(join(outDir, "valid.jsonl"), split.valid, chatLine);
writeRows(join(outDir, "test.jsonl"), split.test, chatLine);
// Sidecar metadata (line-aligned with the chat files) so downstream curation can
// key rows by source — e.g. leakage checks against a frozen eval set (2026-07 audit).
writeRows(join(outDir, "train.meta.jsonl"), split.train, metaLine);
writeRows(join(outDir, "valid.meta.jsonl"), split.valid, metaLine);
writeRows(join(outDir, "test.meta.jsonl"), split.test, metaLine);
writeRows(join(outDir, "test.eval.jsonl"), evalRaws, (r) => JSON.stringify({ id: r.id, utterance: r.utterance, startCommands: r.startCommands, goldCommandNames: r.goldCommandNames }));

const datasetVersion = `sft-${createHash("sha256").update(`${corpora.join("|")}:${seed}:${trR}/${vaR}/${teR}:${sampleN}:${limitN}:${maxNotes ?? "all"}:${used.length}`).digest("hex").slice(0, 12)}`;
const manifest = {
  datasetVersion, createdFrom: corpora,
  counts: { train: split.train.length, valid: split.valid.length, test: split.test.length, evalSet: evalRaws.length, importer: rendered.length, backtranslated: btCount, tuples: tupleExamples.length, huh: huh.length },
  corpus: { filesFound: allFiles.length, filesProcessed: processed, filesUsed: used.length },
  backtranslation: bt ? { enabled: true, brainCalls: bt.calls, shapes: bt.cacheEntries().length, variants: btVariants, styles: btStyles ? BT_STYLES.length : 0, examples: btCount } : { enabled: false },
  split: { ratios: [trR, vaR, teR], seed, sample: sampleN === Infinity ? "all" : sampleN, limit: limitN === Infinity ? "none" : limitN, maxNotes: maxNotes ?? "all" },
};
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log("\n================= SFT DATASET =================");
console.log(`version : ${datasetVersion}`);
console.log(`train   : ${split.train.length}   valid: ${split.valid.length}   test: ${split.test.length}   eval-set: ${evalRaws.length}`);
console.log(`corpus  : ${used.length} files used / ${processed} processed / ${allFiles.length} found`);
console.log(`\nwrote to ${outDir}/ : train.jsonl, valid.jsonl, test.jsonl, test.eval.jsonl, manifest.json`);
if (split.train.length === 0) console.error("\n⚠ empty train set — check --corpus path.");
