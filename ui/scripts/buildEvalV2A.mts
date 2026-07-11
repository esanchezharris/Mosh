// Build frozen-eval-v2 §A — the per-command-floor eval set (pre-registered in
// docs/bench/PROGRAM_STAGE1_2026-07.md §P4).
//
// Items come from two sources, both disjoint from training:
//   1. The EVAL-ONLY synthesis run (driver --setup eval; eval-*.jsonl — a SETUP
//      profile golden-pinned to share no entity names with training profiles,
//      whose outputs never enter any training mix).
//   2. The held-out v3 test split (test.eval.jsonl — split grouped by sourceId,
//      so no train leakage) for the corpus-covered commands.
//
// Item shape = the standard EvalExample consumed by eval-sft: the model answers
// from the MOCK session built by startCommands (the bound eval profile below);
// scoring = validate + mock-apply + gold-name recall. Per-command floors are
// computed from the `evalA#<command>#<i>` id convention.
//
//   cd ui && npx tsx scripts/buildEvalV2A.mts \
//     [--synth ../service/sft/.sft-data/synth] [--held ../service/sft/.sft-data/v3-import/test.eval.jsonl] \
//     [--out ../service/sft/.sft-data/eval-v2/evalA.eval.jsonl] [--per 6]
//
// Repair mode (2026-07-10 fixture-id fix): rewrite an EXISTING evalA so every
// utterance-referenced id resolves in the mock-rendered snapshot — synth rows'
// real-engine 1000-series ids become ${VAR} placeholders (resolved at scoring
// time from the bound env, like startCommands' $refs; see src/gepa/fixtureIds.ts).
// Row ids, order and gold names are untouched.
//
//   cd ui && npx tsx scripts/buildEvalV2A.mts --repair <old-evalA.eval.jsonl> --out <new.jsonl>

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { argFlag } from "./lib/realEngine.mts";
import { fixtureIdGaps, rewriteRealIds } from "../src/gepa/fixtureIds";
import { buildExamplePrompt } from "../src/gepa/metric";

type BoundCommand = { command: string; args: Record<string, unknown>; bind?: string };
type EvalItem = { id: string; utterance: string; startCommands: BoundCommand[]; goldCommandNames: string[] };

// The eval profile, in BoundCommand form for the mock engine (mirrors
// SETUP_PROFILES.eval; mock renders/lyrics are synchronous — no wait args).
// TKICK is bound (unlike SETUP_PROFILES.eval) so ${TKICK} utterances resolve.
const EVAL_BOUND: BoundCommand[] = [
  { command: "create_track", args: { name: "Kick", type: "drum" }, bind: "TKICK" },
  { command: "create_track", args: { name: "Keys" }, bind: "TKEYS" },
  { command: "create_track", args: { name: "Sub" }, bind: "TSUB" },
  { command: "create_track", args: { name: "Lead" }, bind: "TLEAD" },
  { command: "add_midi_clip", args: { trackId: "$TKEYS", start: 4, length: 8 }, bind: "CKEYS" },
  { command: "add_note", args: { clipId: "$CKEYS", pitch: 55, start: 0, length: 1, velocity: 90 } },
  { command: "add_note", args: { clipId: "$CKEYS", pitch: 58, start: 2, length: 1, velocity: 110 } },
  { command: "add_note", args: { clipId: "$CKEYS", pitch: 62, start: 4, length: 0.5, velocity: 64 } },
  { command: "add_test_tone_clip", args: { trackId: "$TSUB", seconds: 3, freq: 55 }, bind: "CSUB" },
  { command: "load_builtin", args: { trackId: "$TKEYS", type: "delay" } },
  { command: "create_section", args: { name: "Drop", startBeat: 0, endBeat: 32 } },
  { command: "create_annotation", args: { text: "tighten this transition", beat: 16 } },
  { command: "create_lyric_sheet", args: { trackId: "$TLEAD", topic: "midnight drive", mood: "wistful" } },
  { command: "set_lyric_line", args: { trackId: "$TLEAD", lineIndex: 0, text: "taillights paint the highway red" } },
  { command: "create_render_layer", args: { clipId: "$CSUB" } },
  { command: "render_layer", args: { clipId: "$CSUB" } },
];

const synthDir = resolve(argFlag("synth") ?? join("..", "service", "sft", ".sft-data", "synth"));
const heldPath = resolve(argFlag("held") ?? join("..", "service", "sft", ".sft-data", "v3-import", "test.eval.jsonl"));
const outPath = resolve(argFlag("out") ?? join("..", "service", "sft", ".sft-data", "eval-v2", "evalA.eval.jsonl"));
const perCap = Number(argFlag("per", "6"));
const repairPath = argFlag("repair");

/** Tripwire: every item must render a prompt whose utterance ids all resolve in
 *  the mock snapshot (leftover ${VAR} or a 1000-series real-engine id = broken
 *  fixture → an unpassable row). Returns human-readable failures. */
async function verifyItems(items: EvalItem[]): Promise<string[]> {
  const failures: string[] = [];
  for (const it of items) {
    const msgs = await buildExamplePrompt("Rules:", it);
    const sys = msgs.find((m) => m.role === "system")?.content ?? "";
    const user = msgs.find((m) => m.role === "user")?.content ?? "";
    const gaps = fixtureIdGaps(user, sys);
    if (gaps.length) failures.push(`${it.id}: unresolved ${gaps.join(", ")} in "${user}"`);
  }
  return failures;
}

function writeOut(items: EvalItem[], extra: Record<string, unknown> = {}): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, items.map((i) => JSON.stringify(i)).join("\n") + "\n");
  const sha = createHash("sha256").update(readFileSync(outPath)).digest("hex");
  const counts = new Map<string, number>();
  for (const i of items) { const cmd = i.id.split("#")[1]; counts.set(cmd, (counts.get(cmd) ?? 0) + 1); }
  const perCounts = Object.fromEntries([...counts.entries()].sort());
  writeFileSync(
    outPath.replace(/\.jsonl$/, ".manifest.json"),
    JSON.stringify({ items: items.length, commands: counts.size, perCap, sha256: sha, perCommand: perCounts, ...extra }, null, 2) + "\n",
  );
  console.log(`§A: ${items.length} items across ${counts.size} commands → ${outPath}\nsha256 ${sha}`);
}

// ── repair mode: fix fixture ids in an existing evalA, change nothing else ──
if (repairPath) {
  const src = readFileSync(resolve(repairPath), "utf8");
  const srcSha = createHash("sha256").update(src).digest("hex");
  const rows = src.split("\n").filter(Boolean).map((l) => JSON.parse(l) as EvalItem);
  // legacy = the profile as originally emitted (no TKICK bind)
  const legacy = JSON.stringify(EVAL_BOUND.map((c, i) => (i === 0 ? { command: c.command, args: c.args } : c)));
  const current = JSON.stringify(EVAL_BOUND);
  let utterancesRewritten = 0;
  let profileRows = 0;
  for (const r of rows) {
    const sc = JSON.stringify(r.startCommands);
    if (sc !== legacy && sc !== current) continue; // held-out rows keep their own context
    profileRows++;
    const rewritten = rewriteRealIds(r.utterance);
    if (rewritten !== r.utterance) utterancesRewritten++;
    r.startCommands = EVAL_BOUND; // adds the TKICK bind ${TKICK} resolves through
    r.utterance = rewritten;
  }
  const failures = await verifyItems(rows);
  if (failures.length) {
    console.error(`REPAIR FAILED — ${failures.length} row(s) still have unresolvable ids:\n` + failures.join("\n"));
    process.exit(1);
  }
  console.log(`repair: ${utterancesRewritten} utterance(s) rewritten across ${profileRows} EVAL_BOUND row(s); held-out rows untouched`);
  writeOut(rows, { utterancesRewritten, repairedFromSha256: srcSha });
  process.exit(0);
}

// 1. Eval-synthesis keeps, attributed to their target command via the reports.
const byCommand = new Map<string, EvalItem[]>();
function push(cmd: string, utterance: string, gold: string[]): void {
  const list = byCommand.get(cmd) ?? [];
  if (list.length >= perCap) return;
  if (list.some((i) => i.utterance === utterance)) return;
  // synth utterances were authored against the REAL engine's ids → placeholders
  list.push({ id: `evalA#${cmd}#${list.length}`, utterance: rewriteRealIds(utterance), startCommands: EVAL_BOUND, goldCommandNames: gold });
  byCommand.set(cmd, list);
}

for (const f of readdirSync(synthDir).filter((f) => /^eval-\d+\.report\.json$/.test(f)).sort()) {
  const report = JSON.parse(readFileSync(join(synthDir, f), "utf8")) as {
    out: string; perCommand: Record<string, { detail?: Array<{ request: string; outcome: string }> }>;
  };
  // kept rows live in the sibling .jsonl; map request → gold names from its assistant JSON
  const rows = readFileSync(join(synthDir, f.replace(".report.json", ".jsonl")), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l) as { messages: Array<{ role: string; content: string }> });
  const goldByRequest = new Map<string, string[]>();
  for (const r of rows) {
    const user = r.messages.find((m) => m.role === "user")?.content ?? "";
    const a = r.messages.find((m) => m.role === "assistant")?.content ?? "{}";
    try {
      const names = (JSON.parse(a).commands ?? []).map((c: { command: string }) => c.command);
      if (names.length) goldByRequest.set(user, names);
    } catch { /* skip */ }
  }
  for (const [cmd, d] of Object.entries(report.perCommand)) {
    for (const row of d.detail ?? []) {
      if (row.outcome !== "kept") continue;
      const gold = goldByRequest.get(row.request);
      if (gold) push(cmd, row.request, gold);
    }
  }
}

// 2. Held-out corpus items for commands still short (populate class + globals).
const held = readFileSync(heldPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as EvalItem);
for (const it of held) {
  for (const cmd of new Set(it.goldCommandNames)) {
    if ((byCommand.get(cmd)?.length ?? 0) >= perCap) continue;
    // held-out items keep their own startCommands (their source-project context)
    const list = byCommand.get(cmd) ?? [];
    list.push({ id: `evalA#${cmd}#${list.length}`, utterance: it.utterance, startCommands: it.startCommands, goldCommandNames: it.goldCommandNames });
    byCommand.set(cmd, list);
  }
}

const items = [...byCommand.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([, v]) => v);
const failures = await verifyItems(items);
if (failures.length) {
  console.error(`BUILD FAILED — ${failures.length} row(s) have unresolvable ids (fixture bug — extend EVAL_REAL_ID_TO_VAR or fix the source utterance):\n` + failures.join("\n"));
  process.exit(1);
}
writeOut(items);
