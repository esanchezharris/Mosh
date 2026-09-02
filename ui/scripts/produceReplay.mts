#!/usr/bin/env -S ui/node_modules/.bin/vite-node --mode development
// Brainless replay of a captured produce-lane program through the headless
// `Mosh --run-script` engine (realEngine.mts's runScript — an isolated,
// no-audio, fresh-per-invocation engine; NOT the live companion app). Three
// modes:
//
//   (a) plain replay — `--program <run-dir>/program.jsonl` from a prior
//       produceLiveRun.mts run: strip the bookkeeping commands
//       (new_project/batch_begin/batch_end/save_as/export_audio), replay the
//       rest verbatim, append a fresh export_audio. A cheap regression check
//       ("does this exact program still work") independent of any brain call.
//
//   (b) `--swap lab=<manifest.json>` — the SOUND-MATCHED second render: re-run
//       the W2.5 preflight (ui/src/agent/loop/produceTemplate.ts) against a
//       DIFFERENT sample/preset manifest (the owner's lab kit — his Live set's
//       exact wavs in place), then replay the ORIGINAL run's note commands
//       (add_note/add_midi_clip/add_drum_pattern) verbatim on top. This works
//       because engine-assigned ids are deterministic across replays of an
//       identical command-shape PREFIX (realEngine.mts's header, verified
//       2026-07-01): swapping which file assign_sample points at, or which
//       preset load_preset loads, doesn't change how many tracks/clips get
//       created or their order, so the captured note commands (which
//       reference those ids) land on the right tracks/clips.
//
//   (c) `--fixture` — replay ui/src/agent/__fixtures__/mac_r0_001_fix.program.json
//       (W2.7's MDSL→Mosh conversion of the corrected reference beat) against
//       the DEFAULT (non-swapped) preflight: a third A/B point, the reference
//       beat's own notes, Mosh's own sounds.
//
// (b) and (c) both depend on ui/src/agent/loop/produceTemplate.ts (W2.5) and,
// for (c), the W2.7 fixture — neither landed as of this writing. Both exit
// with code 2 (not 1) when their dependency is missing, so overnight.sh can
// tell "this leg of the A/B isn't available tonight" apart from "the replay
// actually broke" and skip it without stopping the batch.
//
// Usage:
//   ui/node_modules/.bin/vite-node --mode development ui/scripts/produceReplay.mts \
//     --program <run-dir>/program.jsonl --out-dir <dir> --run-id r1 [--bin <path>] \
//     [--ask "<original ask — read from run.json next to --program if omitted>"] \
//     [--swap lab=<manifest.json>] [--fixture] [--dry-run]

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  argFlag, findBin, runScript, type Cmd as EngineCmd,
} from "./lib/realEngine.mts";
import { wavRmsDbfs } from "./lib/companionClient.mts";
import type { ProduceTemplateDeps } from "../src/agent/loop/produceTemplate";
import type { PaletteItem } from "../src/agent/loop/drumPalette";
import type { Snapshot } from "../src/types";

const PROGRAM_PATH = argFlag("program");
const OUT_DIR = argFlag("out-dir");
const RUN_ID = argFlag("run-id", `replay-${Date.now()}`)!;
const ASK_FLAG = argFlag("ask");
const SWAP = argFlag("swap"); // "lab=<path>"
const FIXTURE = process.argv.includes("--fixture");
const DRY_RUN = process.argv.includes("--dry-run");

const FIXTURE_PATH = resolve(process.cwd(), "src/agent/__fixtures__/mac_r0_001_fix.program.json");

// Commands the W2.5 preflight lays — everything else (add_note, add_midi_clip,
// add_drum_pattern, rename_track after the fact, etc.) is a "note" command the
// swap/fixture replay carries over verbatim.
const TEMPLATE_COMMANDS = new Set([
  "set_tempo", "set_key", "set_time_signature", "create_section",
  "create_track", "assign_sample", "set_drum_pad", "clear_drum_pad",
  "load_plugin", "load_preset", "rename_track",
]);
const BOOKKEEPING_COMMANDS = new Set(["new_project", "batch_begin", "batch_end", "save_as", "export_audio"]);

type ProgramLine = { command: string; args?: Record<string, unknown> };

function readProgramFile(path: string): ProgramLine[] {
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  // Accept a JSONL file (one {command,args,...} object per line — what
  // produceLiveRun.mts writes), a JSON array, or a single JSON object (the
  // landed W2.7 fixture: one LoopReply `{intent,say,status,plan:[{goal,
  // commands}]}` — loop/parse.ts:14-20's shape, not a flat command list).
  if (text.startsWith("[")) return flattenEntries(JSON.parse(text) as unknown[]);
  if (text.startsWith("{")) return flattenEntries([JSON.parse(text)]);
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as ProgramLine);
}

// Recursively pull {command,args} pairs out of whatever shape the source
// carries: a flat command, a LoopReply-ish {commands:[...]}, or a plan
// {plan:[{goal,commands:[...]}]} (which is itself walked the same way, so a
// plan step's own commands array flattens without a separate code path).
function flattenEntries(arr: unknown[]): ProgramLine[] {
  const out: ProgramLine[] = [];
  const visit = (entry: unknown) => {
    const e = entry as Record<string, unknown>;
    if (e && typeof e.command === "string") {
      out.push({ command: e.command, args: (e.args ?? {}) as Record<string, unknown> });
      return;
    }
    if (e && Array.isArray(e.commands)) {
      for (const c of e.commands as unknown[]) visit(c);
      return;
    }
    if (e && Array.isArray(e.plan)) {
      for (const step of e.plan as unknown[]) visit(step);
      return;
    }
    console.error(`[produceReplay] skipping unrecognized program entry: ${JSON.stringify(entry).slice(0, 120)}`);
  };
  for (const entry of arr) visit(entry);
  return out;
}

/** Recursively replace `${name}` placeholder strings using `map`. Throws on an
 *  unresolved placeholder — a broken substitution should fail loudly, not
 *  silently emit a command with a literal "${lead}" trackId. */
function substitutePlaceholders<T>(value: T, map: Record<string, string>): T {
  if (typeof value === "string") {
    const whole = value.match(/^\$\{(\w+)\}$/);
    if (whole) {
      const key = whole[1]!;
      if (!(key in map)) throw new Error(`unresolved fixture placeholder \${${key}} — no matching field in the produce template`);
      return map[key] as unknown as T;
    }
    return value.replace(/\$\{(\w+)\}/g, (_m, key: string) => {
      if (!(key in map)) throw new Error(`unresolved fixture placeholder \${${key}} — no matching field in the produce template`);
      return map[key]!;
    }) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => substitutePlaceholders(v, map)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = substitutePlaceholders(v, map);
    return out as T;
  }
  return value;
}

/** Load a lab manifest into runProduceTemplate's `palette` seam. Accepts
 *  either a raw `PaletteItem[]` array or a `{items:[...]}` wrapper (the same
 *  shape `list_palette`'s command result returns), so a manifest file can be
 *  authored either way. */
function readPaletteManifest(path: string): readonly PaletteItem[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const items = Array.isArray(parsed) ? parsed : (parsed as { items?: unknown[] })?.items;
  if (!Array.isArray(items)) throw new Error(`--swap manifest ${path}: expected an array or {items:[...]}`);
  for (const item of items) {
    const it = item as Record<string, unknown>;
    if (typeof it.path !== "string" || typeof it.role !== "string")
      throw new Error(`--swap manifest ${path}: every item needs string "path" and "role" fields, got ${JSON.stringify(item).slice(0, 120)}`);
  }
  return items as PaletteItem[];
}

function templatePlaceholderMap(template: Record<string, unknown>): Record<string, string> {
  const map: Record<string, string> = {};
  const drums = template.drums as { trackId?: string } | undefined;
  const bass = template.bass as { trackId?: string } | undefined;
  if (drums?.trackId) map.drums = drums.trackId;
  if (bass?.trackId) map["808"] = bass.trackId;
  const synths = template.synths as Array<{ trackId?: string; role?: string }> | undefined;
  for (const s of synths ?? []) if (s.role && s.trackId) map[s.role] = s.trackId;
  return map;
}

// ── real-engine harness (cumulative-prefix replay, mirrors agentBench.mts) ──
// A minimal AgentEnv-shaped exec surface for driving `runProduceTemplate`
// against the real headless engine: every call re-runs the WHOLE
// accumulated script (setup, so far) in one fresh `--run-script` invocation
// and returns the newest command's result — slower than a live app (no
// incremental state), but correct, and it's a one-shot nightly cost.
function makeScriptedRealExec(bin: string, session: string) {
  const script: EngineCmd[] = [];
  let lastSnap: Snapshot | null = null;

  async function exec(command: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; error?: string; data?: unknown }> {
    script.push({ command, args });
    const out = runScript(bin, [...script, { command: "__wait", args: { ms: 50 } }, { command: "__snapshot", args: { label: "s" } }], session);
    const snaps = out.results.filter((r) => r.command === "__snapshot");
    lastSnap = (snaps[snaps.length - 1]?.data ?? null) as Snapshot | null;
    const results = out.results.filter((r) => r.command !== "__snapshot" && r.command !== "__wait");
    const last = results[results.length - 1] as Record<string, unknown> | undefined;
    return { ok: last?.ok !== false, error: typeof last?.error === "string" ? last.error : undefined, data: last?.data };
  }
  async function getSnapshot(): Promise<Snapshot> {
    if (lastSnap) return lastSnap;
    const out = runScript(bin, [...script, { command: "__snapshot", args: { label: "s" } }], session);
    const snaps = out.results.filter((r) => r.command === "__snapshot");
    lastSnap = (snaps[snaps.length - 1]?.data ?? {}) as Snapshot;
    return lastSnap;
  }
  return { exec, getSnapshot, script };
}

async function main(): Promise<void> {
  if (FIXTURE && SWAP) throw new Error("produceReplay: --fixture and --swap are mutually exclusive");
  if (!FIXTURE && !PROGRAM_PATH) throw new Error("produceReplay: need --program <path> (or --fixture)");
  if (!OUT_DIR) throw new Error("produceReplay: need --out-dir <dir>");

  const outDir = resolve(OUT_DIR);
  const programPath = FIXTURE ? FIXTURE_PATH : resolve(PROGRAM_PATH!);
  const swapMatch = SWAP?.match(/^lab=(.+)$/);
  const swapManifest = swapMatch ? resolve(swapMatch[1]!) : undefined;
  if (SWAP && !swapMatch) throw new Error(`produceReplay: --swap must look like "lab=<manifest.json>", got ${SWAP}`);

  const resolvedConfig = {
    mode: FIXTURE ? "fixture" : swapManifest ? "swap" : "plain",
    programPath,
    outDir,
    runId: RUN_ID,
    swapManifest: swapManifest ?? null,
  };

  if (DRY_RUN) {
    console.log(JSON.stringify({ dryRun: true, config: resolvedConfig, programExists: existsSync(programPath) }, null, 2));
    process.exit(0);
  }

  if (!existsSync(programPath)) {
    console.error(`[produceReplay] ${FIXTURE ? "W2.7 fixture" : "program file"} not found at ${programPath} — ${FIXTURE ? "not landed yet" : "check --program"}. Skipping this leg.`);
    process.exit(2);
  }

  const raw = readProgramFile(programPath);
  const notes = raw.filter((l) => !BOOKKEEPING_COMMANDS.has(l.command) && !TEMPLATE_COMMANDS.has(l.command));
  const templateCmdsFromProgram = raw.filter((l) => TEMPLATE_COMMANDS.has(l.command));

  const wavFile = resolve(outDir, "mix.wav");
  const session = `_harness/produce-replay-${RUN_ID}`;

  if (!swapManifest && !FIXTURE) {
    // (a) plain replay — the ORIGINAL template + note commands, verbatim.
    const bin = findBin(argFlag("bin"));
    const lines: EngineCmd[] = [
      { command: "new_project", args: {} },
      ...[...templateCmdsFromProgram, ...notes].map((l) => ({ command: l.command, args: l.args ?? {} }) as EngineCmd),
      { command: "export_audio", args: { file: wavFile, format: "wav", range: "loop", renderMode: "auto" } },
    ];
    const out = runScript(bin, lines, session, 600_000);
    return finish(outDir, wavFile, out.results, resolvedConfig);
  }

  // (b) swap / (c) fixture — both need the W2.5 preflight. Check its
  // availability BEFORE resolving a Mosh binary, so "the dependency isn't
  // landed yet" is distinguishable from "no binary on this machine" and this
  // guard is exercisable on a machine with no build at all.
  let mod: { runProduceTemplate?: (ask: string, deps: ProduceTemplateDeps) => Promise<Record<string, unknown>> };
  try {
    mod = await import("../src/agent/loop/produceTemplate");
  } catch {
    console.error("[produceReplay] ui/src/agent/loop/produceTemplate.ts not available yet (W2.5 not landed) — this leg of the A/B is skipped tonight, not broken.");
    process.exit(2);
    return;
  }
  if (typeof mod.runProduceTemplate !== "function") {
    console.error("[produceReplay] produceTemplate.ts has no runProduceTemplate() export yet — skipping.");
    process.exit(2);
    return;
  }

  const bin = findBin(argFlag("bin"));
  const ask = ASK_FLAG ?? askFromSiblingRunJson(programPath) ?? "produce a full trap beat";
  const harness = makeScriptedRealExec(bin, session);
  await harness.exec("new_project", {});
  // `palette` is runProduceTemplate's test/production seam for injecting the
  // sample list directly (ProduceTemplateDeps, drumPalette.ts's PaletteItem
  // shape: {path, role, rootNote?}) — the lab manifest is exactly that shape
  // (plan W2.3: "same item shape" as list_palette's items), so a swap just
  // means "use THIS palette instead of list_palette's default."
  const templateDeps: ProduceTemplateDeps = { exec: harness.exec, getSnapshot: harness.getSnapshot };
  if (swapManifest) templateDeps.palette = readPaletteManifest(swapManifest);
  const template = await mod.runProduceTemplate(ask, templateDeps);
  writeFileSync(resolve(outDir, "template.json"), JSON.stringify(template, null, 2));

  let replayNotes: ProgramLine[];
  if (FIXTURE) {
    const map = templatePlaceholderMap(template);
    replayNotes = notes.map((l) => substitutePlaceholders(l, map));
  } else {
    replayNotes = notes; // swap: track/clip ids are assumed stable (deterministic prefix)
  }

  for (const line of replayNotes) await harness.exec(line.command, line.args ?? {});
  const exportResult = await harness.exec("export_audio", { file: wavFile, format: "wav", range: "loop", renderMode: "auto" });
  writeFileSync(resolve(outDir, "swap-program.jsonl"), [...harness.script, { command: "export_audio", args: { file: wavFile } }].map((l) => JSON.stringify(l)).join("\n") + "\n");
  finish(outDir, wavFile, [{ command: "export_audio", ok: exportResult.ok, error: exportResult.error }], resolvedConfig);
}

function askFromSiblingRunJson(programPath: string): string | undefined {
  try {
    const runJsonPath = resolve(dirname(programPath), "run.json");
    if (!existsSync(runJsonPath)) return undefined;
    const j = JSON.parse(readFileSync(runJsonPath, "utf8")) as { ask?: string };
    return j.ask;
  } catch {
    return undefined;
  }
}

function finish(outDir: string, wavFile: string, results: Array<Record<string, unknown>>, config: Record<string, unknown>): void {
  const exportEntry = [...results].reverse().find((r) => r.command === "export_audio");
  let renderBytes = 0;
  let renderRmsDbfs: number | null = null;
  let silentRender = true;
  if (existsSync(wavFile)) {
    renderBytes = statSync(wavFile).size;
    try {
      renderRmsDbfs = wavRmsDbfs(wavFile);
      silentRender = renderRmsDbfs < -60;
    } catch (e) {
      console.error(`[produceReplay] wavRmsDbfs failed: ${String((e as Error)?.message ?? e)}`);
    }
  }
  const result = {
    v: 1,
    config,
    export: { ok: exportEntry?.ok !== false, error: exportEntry?.error },
    render: { file: wavFile, bytes: renderBytes, rmsDbfs: renderRmsDbfs, silentRender },
  };
  writeFileSync(resolve(outDir, "replay-result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.export.ok && !silentRender ? 0 : 1;
}

main().catch((e) => {
  console.error("[produceReplay] FATAL", e);
  process.exitCode = 1;
});
