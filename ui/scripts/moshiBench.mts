// Moshi-Bench v0 — NL→command agent eval, EXECUTE-graded on the real headless engine.
//
//   cd ui && npm run moshi-bench -- [--model <id>] [--tag <label>] [--cases id,id]
//                                   [--bin <Mosh binary>] [--out-dir <dir>] [--no-render]
//
// Per case: replay the setup into a fresh engine → __snapshot → build the byte-identical
// production system prompt over the REAL snapshot → one brain call (mirrors the shipped
// request shape) → validate → execute the reply's commands bracketed on the real engine →
// __snapshot → grade STATE with direction/tolerance-band checks (src/bench/cases.ts).
// Corrective cases also render before/after WAVs to ~/mosh-bench-artifacts/<tag>/ so the
// proxy metric stays paired with something the owner can hear.
//
// Scoreboard: <out-dir>/scoreboard.<tag>.json + .md. Deterministic execute-half; the
// brain half is near-deterministic (temp 0 where the API accepts it).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt, DEFAULT_RULES, parseReply } from "../src/agent/brainCore";
import { validateCommand } from "../src/agent/commands";
import { BENCH_CASES, type BenchCase, type Check, type Cmd } from "../src/bench/cases";
import type { Snapshot } from "../src/types";
import { argFlag, brainConfigFromEnv, callBrain, findBin, loadEnv, snapshotAt, runScript, type BrainUsage } from "./lib/realEngine.mts";

const env = loadEnv();
const cfg = brainConfigFromEnv(env, argFlag("model"));
const BIN = findBin(argFlag("bin"));
const TAG = argFlag("tag", cfg.model.replace(/[^a-zA-Z0-9.-]/g, "_"))!;
const OUT_DIR = argFlag("out-dir", join(process.cwd(), "..", "docs", "bench"))!;
const RENDER = !process.argv.includes("--no-render");
const CASE_FILTER = (argFlag("cases", "all") || "all").split(",");
const ART_DIR = join(homedir(), "mosh-bench-artifacts", TAG);
mkdirSync(OUT_DIR, { recursive: true });

type Tracks = Array<Record<string, unknown>>;
const tracksOf = (s: Snapshot): Tracks => ((s as any).tracks ?? []) as Tracks;
const findTrack = (s: Snapshot, name: string) => {
  const ts = tracksOf(s);
  return ts.find((t) => t.name === name) ?? ts.find((t) => String(t.name ?? "").toLowerCase().includes(name.toLowerCase()));
};
const num = (v: unknown): number => (typeof v === "number" ? v : NaN);

type CheckResult = { check: Check; pass: boolean; note: string };

function grade(check: Check, before: Snapshot, after: Snapshot, cmdResults: Array<{ command: string; ok: boolean }>): CheckResult {
  const fail = (note: string): CheckResult => ({ check, pass: false, note });
  const pass = (note: string): CheckResult => ({ check, pass: true, note });
  const sesA = (after as any).session ?? {};
  switch (check.kind) {
    case "tempo": {
      const t = num(sesA.tempo);
      if (check.eq !== undefined) return Math.abs(t - check.eq) <= (check.tol ?? 0.01) ? pass(`tempo ${t}`) : fail(`tempo ${t} ≠ ${check.eq}`);
      if (check.min !== undefined && t < check.min) return fail(`tempo ${t} < ${check.min}`);
      if (check.max !== undefined && t > check.max) return fail(`tempo ${t} > ${check.max}`);
      return pass(`tempo ${t}`);
    }
    case "timeSig": {
      const n = num(sesA.timeSigNumerator), d = num(sesA.timeSigDenominator);
      return n === check.num && d === check.den ? pass(`${n}/${d}`) : fail(`${n}/${d} ≠ ${check.num}/${check.den}`);
    }
    case "trackCount": {
      const delta = tracksOf(after).length - tracksOf(before).length;
      return delta === check.delta ? pass(`Δtracks ${delta}`) : fail(`Δtracks ${delta} ≠ ${check.delta}`);
    }
    case "trackExists": {
      const found = !!findTrack(after, check.name);
      return found !== !!check.negate ? pass(`"${check.name}" ${found ? "exists" : "absent"}`) : fail(`"${check.name}" ${found ? "unexpectedly exists" : "missing"}`);
    }
    case "trackField": {
      const t = findTrack(after, check.track);
      if (!t) return fail(`track "${check.track}" not found`);
      const v = (t as any)[check.field];
      if (check.eq !== undefined) {
        if (typeof check.eq === "number") return Math.abs(num(v) - check.eq) <= (check.tol ?? 0.25) ? pass(`${check.field}=${v}`) : fail(`${check.field}=${v} ≠ ${check.eq}`);
        return v === check.eq ? pass(`${check.field}=${v}`) : fail(`${check.field}=${v} ≠ ${check.eq}`);
      }
      if (check.min !== undefined && num(v) < check.min) return fail(`${check.field}=${v} < ${check.min}`);
      if (check.max !== undefined && num(v) > check.max) return fail(`${check.field}=${v} > ${check.max}`);
      return pass(`${check.field}=${v}`);
    }
    case "trackDelta": {
      const tb = findTrack(before, check.track), ta = findTrack(after, check.track);
      if (!tb || !ta) return fail(`track "${check.track}" not found`);
      const d = num((ta as any)[check.field]) - num((tb as any)[check.field]);
      const signed = check.dir === "down" ? -d : d;
      return signed >= check.min && signed <= check.max
        ? pass(`${check.field} moved ${check.dir} ${Math.abs(d).toFixed(1)}`)
        : fail(`${check.field} Δ${d.toFixed(1)} not ${check.dir} within [${check.min},${check.max}]`);
    }
    case "clipCount": {
      const tb = findTrack(before, check.track), ta = findTrack(after, check.track);
      if (!ta) return fail(`track "${check.track}" not found`);
      const d = (((ta as any).clips ?? []) as unknown[]).length - (((tb as any)?.clips ?? []) as unknown[]).length;
      return d === check.delta ? pass(`Δclips ${d}`) : fail(`Δclips ${d} ≠ ${check.delta}`);
    }
    case "clipStart": {
      const ta = findTrack(after, check.track);
      const clip = (((ta as any)?.clips ?? []) as Array<Record<string, unknown>>)[check.clipIndex];
      if (!clip) return fail(`clip[${check.clipIndex}] on "${check.track}" not found`);
      const s = num(clip.start);
      return s >= check.minSec && s <= check.maxSec ? pass(`start ${s}s`) : fail(`start ${s}s ∉ [${check.minSec},${check.maxSec}]`);
    }
    case "transport": {
      const v = ((after as any).transport ?? {})[check.field];
      return v === check.eq ? pass(`${check.field}=${v}`) : fail(`${check.field}=${v} ≠ ${check.eq}`);
    }
    case "transportPos": {
      const p = num(((after as any).transport ?? {}).position);
      return p >= check.minSec && p <= check.maxSec ? pass(`pos ${p}s`) : fail(`pos ${p}s ∉ [${check.minSec},${check.maxSec}]`);
    }
    case "sectionExists": {
      const secs = ((after as any).sections ?? []) as Array<Record<string, unknown>>;
      const hit = secs.find((x) => String(x.name ?? "").toLowerCase() === check.name.toLowerCase());
      if (check.negate) return hit ? fail(`section "${check.name}" unexpectedly exists`) : pass(`section "${check.name}" absent`);
      if (!hit) return fail(`section "${check.name}" missing (have: ${secs.map((x) => x.name).join(",") || "none"})`);
      const tol = check.tolBeats ?? 1;
      if (check.startBeat !== undefined && Math.abs(num(hit.startBeat) - check.startBeat) > tol) return fail(`startBeat ${hit.startBeat}`);
      if (check.endBeat !== undefined && Math.abs(num(hit.endBeat) - check.endBeat) > tol) return fail(`endBeat ${hit.endBeat}`);
      return pass(`section "${check.name}" ok`);
    }
    case "pluginOnTrack": {
      const ta = findTrack(after, check.track);
      if (!ta) return fail(`track "${check.track}" not found`);
      const blob = JSON.stringify((ta as any).plugins ?? []).toLowerCase();
      const found = blob.includes(check.nameIncludes.toLowerCase());
      return found !== !!check.negate ? pass(`plugin ~"${check.nameIncludes}" ${found ? "present" : "absent"}`) : fail(`plugin ~"${check.nameIncludes}" ${found ? "unexpectedly present" : "missing"}`);
    }
    case "cmdOk": {
      const n = cmdResults.filter((c) => c.command === check.name && c.ok).length;
      return n >= check.min ? pass(`${check.name} ×${n}`) : fail(`${check.name} ×${n} < ${check.min}`);
    }
    case "defer":
      return cmdResults.length === 0 ? pass("deferred") : fail(`emitted ${cmdResults.length} command(s) on a defer case`);
  }
}

const DESTRUCTIVE = /^(remove|delete|clear)_/;
async function runCase(c: BenchCase, usage: BrainUsage) {
  const session = `bench-${TAG}-${c.id}`.slice(0, 60);
  const { snap: before } = snapshotAt(BIN, c.setup, session);
  const system = buildSystemPrompt(DEFAULT_RULES, before);
  let content = "", ms = 0, brainError: string | undefined;
  try {
    ({ content, ms } = await callBrain(cfg, [
      { role: "system", content: system },
      { role: "user", content: c.utterance },
    ], usage));
  } catch (e) {
    brainError = String(e).slice(0, 200);
  }
  const reply = brainError ? {} : parseReply(content);
  const cmds = (reply.commands ?? []).filter((x) => !validateCommand(x.command, x.args ?? {}));
  const invalidCount = (reply.commands ?? []).length - cmds.length;
  const destructiveCount = cmds.filter((x) => DESTRUCTIVE.test(x.command)).length;
  const allowed = destructiveCount > 10 ? cmds.filter((x) => !DESTRUCTIVE.test(x.command)) : cmds;

  let after = before;
  let cmdResults: Array<{ command: string; ok: boolean; error?: string }> = [];
  if (allowed.length > 0) {
    const bracket: Cmd[] = [
      { command: "batch_begin", args: { name: `bench: ${c.id}`, turn_id: `bench-${c.id}`, utterance: c.utterance, source: "brain_chat" } },
      ...allowed.map((x) => ({ command: x.command, args: x.args ?? {} })),
      { command: "batch_end", args: {} },
    ];
    const out = snapshotAt(BIN, [...c.setup, ...bracket], session);
    after = out.snap;
    const slice = out.results.slice(c.setup.length + 1, c.setup.length + 1 + allowed.length);
    cmdResults = allowed.map((x, i) => ({
      command: x.command,
      ok: slice[i] ? (slice[i] as any).ok !== false : false,
      error: slice[i] && typeof (slice[i] as any).error === "string" ? ((slice[i] as any).error as string) : undefined,
    }));
  }

  const checks = c.checks.map((k) => grade(k, before, after, cmdResults));
  const appliedClean = cmdResults.every((r) => r.ok);
  const isDefer = c.checks.some((k) => k.kind === "defer");
  const pass = checks.every((r) => r.pass) && (isDefer || (allowed.length > 0 && appliedClean));

  // paired audio for the owner's ears
  let renders: string[] = [];
  if (RENDER && c.render && !process.argv.includes("--no-render")) {
    mkdirSync(ART_DIR, { recursive: true });
    const wavB = join(ART_DIR, `${c.id}.before.wav`);
    const wavA = join(ART_DIR, `${c.id}.after.wav`);
    runScript(BIN, [...c.setup, { command: "export_audio", args: { file: wavB } }], `${session}-rb`);
    const bracket: Cmd[] = allowed.length
      ? [{ command: "batch_begin", args: { name: "bench", turn_id: `bench-${c.id}-r`, utterance: c.utterance, source: "brain_chat" } }, ...allowed.map((x) => ({ command: x.command, args: x.args ?? {} })), { command: "batch_end", args: {} }]
      : [];
    runScript(BIN, [...c.setup, ...bracket, { command: "export_audio", args: { file: wavA } }], `${session}-ra`);
    if (existsSync(wavB) && existsSync(wavA)) renders = [wavB, wavA];
  }

  return {
    id: c.id,
    area: c.area,
    utterance: c.utterance,
    pass,
    commands: allowed.map((x) => x.command),
    invalidCount,
    appliedClean,
    deferred: allowed.length === 0,
    brainMs: ms,
    brainError,
    checks: checks.map((r) => ({ pass: r.pass, note: r.note })),
    renders,
  };
}

async function main() {
  const cases = CASE_FILTER[0] === "all" ? BENCH_CASES : BENCH_CASES.filter((c) => CASE_FILTER.includes(c.id));
  const usage: BrainUsage = { promptTokens: 0, completionTokens: 0, calls: 0 };
  const rows = [] as Awaited<ReturnType<typeof runCase>>[];
  for (const c of cases) {
    const r = await runCase(c, usage);
    rows.push(r);
    process.stderr.write(`  ${r.pass ? "✓" : "✗"} ${c.id} [${c.area}] ${r.deferred ? "(deferred)" : r.commands.join(",")}${r.brainError ? ` BRAIN-ERR` : ""}\n`);
  }
  const byArea: Record<string, { pass: number; total: number }> = {};
  for (const r of rows) {
    byArea[r.area] ??= { pass: 0, total: 0 };
    byArea[r.area].total++;
    if (r.pass) byArea[r.area].pass++;
  }
  const score = rows.filter((r) => r.pass).length / rows.length;
  const board = {
    tag: TAG,
    model: cfg.model,
    bin: BIN,
    ranAt: new Date().toISOString(),
    score,
    passed: rows.filter((r) => r.pass).length,
    total: rows.length,
    byArea,
    usage,
    rows,
  };
  const jsonPath = join(OUT_DIR, `scoreboard.${TAG}.json`);
  writeFileSync(jsonPath, JSON.stringify(board, null, 2));
  const md = [
    `# Moshi-Bench v0 — ${TAG}`,
    ``,
    `model \`${cfg.model}\` · ${board.passed}/${board.total} = **${(score * 100).toFixed(1)}%** · ${new Date().toISOString().slice(0, 10)} · tokens ${usage.promptTokens}+${usage.completionTokens}`,
    ``,
    `| area | pass | cases |`,
    `|---|---|---|`,
    ...Object.entries(byArea).map(([a, s]) => `| ${a} | ${s.pass}/${s.total} | ${rows.filter((r) => r.area === a).map((r) => `${r.pass ? "✓" : "✗"}${r.id}`).join(" ")} |`),
    ``,
    `Failures:`,
    ...rows.filter((r) => !r.pass).map((r) => `- **${r.id}**: ${r.deferred ? "deferred" : r.commands.join(",")} — ${r.checks.filter((c) => !c.pass).map((c) => c.note).join("; ")}${r.brainError ? ` (brain: ${r.brainError})` : ""}`),
    ``,
  ].join("\n");
  writeFileSync(join(OUT_DIR, `scoreboard.${TAG}.md`), md);
  console.log(`moshi-bench[${TAG}]: ${board.passed}/${board.total} = ${(score * 100).toFixed(1)}% → ${jsonPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
