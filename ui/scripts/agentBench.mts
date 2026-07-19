// MoshAgentBench — multi-step agent eval, EXECUTE-graded on the real headless
// engine (the GATE substrate; the dev mock lives in vitest and never gates a
// model verdict).
//
//   cd ui && npm run agent-bench -- [--model <id>] [--base <url>] [--key-env NAME]
//                                   [--runner single|single-repair|loop]
//                                   [--tasks id,id] [--tag <label>] [--max-steps N]
//                                   [--bin <Mosh binary>] [--out-dir <dir>] [--no-render]
//
// Per task: replay the setup into a fresh engine → snapshot → hand the ask to an
// AgentRunner (src/agent/loopSeam.ts). Each runner batch executes with FULL
// production semantics — catalog validation + the destructive screen + one
// batch_begin/…/batch_end undo bracket — via CUMULATIVE-PREFIX REPLAY: step N
// re-runs [setup, batch₁…batchN] in one fresh invocation (engine ids are
// deterministic across replays of the same prefix, verified 2026-07-01), and
// the next step reasons over that snapshot. Goals grade the FINAL snapshot
// (src/bench/goalChecks.ts — the same grade() as moshi-bench and vitest).
//
// Runners: `single` = today's one-shot brain; `single-repair` = + ONE error-fed
// fix turn (the loop-headroom preview); `loop` = the Phase-B agentic loop
// (lands later; this flag errors until it exports an AgentRunner).
//
// Scoreboard: <out-dir>/scoreboard.<tag>.{json,md} (out-dir defaults to
// docs/agent-bench). `--render`-eligible tasks also export before/after WAVs to
// ~/mosh-agentbench-artifacts/<tag>/ — the by-ear side channel; never gating.
//
// Provider config mirrors moshi-bench (OPENAI_BASE_URL/OPENAI_API_KEY/
// OPENAI_MODEL from ui/.env.local or env), with sweep-friendly overrides:
// --base swaps the endpoint (e.g. https://openrouter.ai/api/v1) and --key-env
// names the env var carrying that endpoint's key.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  argFlag, brainConfigFromEnv, callBrain, findBin, loadEnv, runScript, snapshotAt,
  type BrainUsage, type Cmd as EngineCmd,
} from "./lib/realEngine.mts";
import { AGENT_TASKS, type AgentTask } from "../src/bench/agentTasks";
import { scoreTask, type TaskScore } from "../src/bench/goalChecks";
import { validateCommand } from "../src/agent/commands";
import { screenDestructive, DESTRUCTIVE_BLOCK_REASON, type AgentCommandCall } from "../src/agent/destructiveScreen";
import { makeSingleShotRunner } from "../src/bench/singleShotRunner";
import type { AgentEnv, AgentRunner, StepCommandResult } from "../src/agent/loopSeam";
import type { Snapshot } from "../src/types";

const env = loadEnv();
const RUNNER = argFlag("runner", "single")!;
const baseOverride = argFlag("base");
const keyEnv = argFlag("key-env");
if (keyEnv && !env[keyEnv]) throw new Error(`--key-env ${keyEnv}: that env var is empty`);
const cfg = brainConfigFromEnv(
  {
    ...env,
    ...(baseOverride ? { OPENAI_BASE_URL: baseOverride } : {}),
    ...(keyEnv ? { OPENAI_API_KEY: env[keyEnv]! } : {}),
  },
  argFlag("model"),
);
const BIN = findBin(argFlag("bin"));
const TAG = argFlag("tag", `${cfg.model.replace(/[^a-zA-Z0-9.-]/g, "_")}-${RUNNER}`)!;
const OUT_DIR = argFlag("out-dir", join(process.cwd(), "..", "docs", "agent-bench"))!;
const MAX_STEPS = Number(argFlag("max-steps", "8"));
const TASK_FILTER = (argFlag("tasks", "all") || "all").split(",");
const RENDER = !process.argv.includes("--no-render");
const ART_DIR = join(homedir(), "mosh-agentbench-artifacts", TAG);
mkdirSync(OUT_DIR, { recursive: true });

const sessionSafe = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 48);

// ── the real-engine AgentEnv (cumulative-prefix replay) ───────────────────────

type RealEnv = AgentEnv & {
  script(): EngineCmd[];
  finalSnapshot(waitMs?: number): Snapshot;
};

function makeRealEnv(task: AgentTask, sessionBase: string): RealEnv {
  const batches: Array<Array<{ command: string; args: Record<string, unknown> }>> = [];
  let n = 0;

  const script = (): EngineCmd[] => [
    ...(task.setup as EngineCmd[]),
    ...batches.flatMap((b, i) => [
      { command: "batch_begin", args: { name: `agent-bench step ${i + 1}`, turn_id: `${sessionBase}-b${i}`, utterance: task.ask, source: "brain_chat" } } as EngineCmd,
      ...(b as EngineCmd[]),
      { command: "batch_end", args: {} } as EngineCmd,
    ]),
  ];

  return {
    script,
    async getSnapshot() {
      return snapshotAt(BIN, script(), `${sessionBase}-s${n++}`).snap;
    },
    finalSnapshot(waitMs?: number) {
      const lines: EngineCmd[] = waitMs ? [...script(), { command: "__wait", args: { ms: waitMs } }] : script();
      return snapshotAt(BIN, lines, `${sessionBase}-sf`).snap;
    },
    async runBatch(_label: string, calls: readonly AgentCommandCall[]) {
      // Production semantics, mirrored from runAgentBatch: validate → screen →
      // execute the allowed calls in ONE undo bracket; invalid + blocked calls
      // come back as failed envelopes at their original positions.
      type Entry = StepCommandResult & { index: number };
      const entries: Entry[] = [];
      const valid: Array<{ index: number; command: string; args: Record<string, unknown> }> = [];
      calls.forEach((c, index) => {
        const err = validateCommand(c.command, (c.args ?? {}) as Record<string, unknown>);
        if (err) entries.push({ index, command: c.command, ok: false, error: err });
        else valid.push({ index, command: c.command, args: (c.args ?? {}) as Record<string, unknown> });
      });
      const { allowed, blocked } = screenDestructive(valid);
      for (const b of blocked) entries.push({ index: b.index, command: b.command, ok: false, error: DESTRUCTIVE_BLOCK_REASON });

      let snap: Snapshot;
      if (allowed.length > 0) {
        batches.push(allowed.map((a) => ({ command: a.command, args: a.args })));
        const out = snapshotAt(BIN, script(), `${sessionBase}-s${n++}`);
        snap = out.snap;
        // Result index of this batch's first allowed command inside the replay:
        // setup, then (len+2) per prior batch, then this batch_begin.
        let pos = task.setup.length;
        for (let i = 0; i < batches.length - 1; i++) pos += batches[i].length + 2;
        pos += 1;
        const slice = out.results.slice(pos, pos + allowed.length);
        allowed.forEach((a, i) => entries.push({
          index: a.index,
          command: a.command,
          ok: slice[i] ? (slice[i] as Record<string, unknown>).ok !== false : false,
          error: slice[i] && typeof (slice[i] as Record<string, unknown>).error === "string"
            ? String((slice[i] as Record<string, unknown>).error) : undefined,
        }));
        // A batch whose EVERY command failed mutated nothing — drop it from the
        // prefix so later replays don't re-run guaranteed failures. (Partially
        // failing batches stay: their ok commands mutated state, and their
        // failures re-fail deterministically on replay.)
        if (slice.length > 0 && slice.every((s) => (s as Record<string, unknown>)?.ok === false))
          batches.pop();
      } else {
        snap = snapshotAt(BIN, script(), `${sessionBase}-s${n++}`).snap;
      }

      entries.sort((a, b) => a.index - b.index);
      return { results: entries.map(({ command, ok, error }) => ({ command, ok, error })), snapshot: snap };
    },
  };
}

// ── runner selection ──────────────────────────────────────────────────────────

function makeRunner(usage: BrainUsage): AgentRunner {
  // ONE retry on network-level failures only ("fetch failed" — e.g. a stale
  // keep-alive socket going down between the multi-second engine replays).
  // HTTP errors are real model/provider answers and are NOT retried.
  const chat = async (messages: Array<{ role: "system" | "user" | "assistant"; content: string }>) => {
    try {
      return await callBrain(cfg, messages, usage);
    } catch (e) {
      if (!/fetch failed|ECONNRESET|socket/i.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 250));
      return callBrain(cfg, messages, usage);
    }
  };
  if (RUNNER === "single") return makeSingleShotRunner({ chat });
  if (RUNNER === "single-repair") return makeSingleShotRunner({ chat, repair: true });
  if (RUNNER === "loop")
    throw new Error("--runner loop lands with the Phase-B agentic loop (it will export an AgentRunner through src/agent/loopSeam.ts)");
  throw new Error(`unknown --runner ${RUNNER}`);
}

// ── main ──────────────────────────────────────────────────────────────────────

type Row = {
  id: string; category: string; ask: string;
  score: TaskScore;
  steps: number; commands: string[];
  /** Per-command envelopes (flattened over steps; errors truncated) — without
   *  these, a "cmdOk ×0" failure can't be told apart from validation vs native
   *  rejection when reading a scoreboard after the fact. */
  results: Array<{ command: string; ok: boolean; error?: string }>;
  wallMs: number; brainError?: string;
  renders: string[];
};

async function runTask(task: AgentTask, runner: AgentRunner): Promise<Row> {
  const sessionBase = sessionSafe(`ab-${TAG}-${task.id}`);
  const realEnv = makeRealEnv(task, sessionBase);
  const before = await realEnv.getSnapshot();

  const t0 = Date.now();
  let run = await runner({ ask: task.ask }, realEnv, { maxSteps: task.maxSteps ?? MAX_STEPS });
  // Async jobs (generative renders) need a settle window before the final read.
  if (task.needsWaitMs) run = { ...run, finalSnapshot: realEnv.finalSnapshot(task.needsWaitMs) };
  const wallMs = Date.now() - t0;

  const score = scoreTask(task, before, run);

  const renders: string[] = [];
  if (RENDER && task.render) {
    mkdirSync(ART_DIR, { recursive: true });
    const wavB = join(ART_DIR, `${task.id}.before.wav`);
    const wavA = join(ART_DIR, `${task.id}.after.wav`);
    runScript(BIN, [...(task.setup as EngineCmd[]), { command: "export_audio", args: { file: wavB } }], `${sessionBase}-rb`);
    runScript(BIN, [...realEnv.script(), { command: "export_audio", args: { file: wavA } }], `${sessionBase}-ra`);
    if (existsSync(wavB) && existsSync(wavA)) renders.push(wavB, wavA);
  }

  return {
    id: task.id, category: task.category, ask: task.ask,
    score,
    steps: run.stepCount,
    commands: run.transcript.flatMap((s) => s.commands.map((c) => c.command)),
    results: run.transcript.flatMap((s) =>
      s.results.map((r) => ({ command: r.command, ok: r.ok, error: r.error?.slice(0, 160) }))),
    wallMs, brainError: run.error, renders,
  };
}

async function main() {
  const tasks = TASK_FILTER[0] === "all" ? [...AGENT_TASKS] : AGENT_TASKS.filter((t) => TASK_FILTER.includes(t.id));
  if (tasks.length === 0) throw new Error(`--tasks matched nothing (${TASK_FILTER.join(",")})`);
  const usage: BrainUsage = { promptTokens: 0, completionTokens: 0, calls: 0 };
  const runner = makeRunner(usage);

  const rows: Row[] = [];
  for (const t of tasks) {
    const r = await runTask(t, runner);
    rows.push(r);
    const s = r.score;
    process.stderr.write(
      `  ${s.success ? "✓" : "✗"} ${t.id} [${t.category}] steps=${r.steps}` +
      `${s.wrongDefer ? " WRONG-DEFER" : ""}${r.brainError ? " BRAIN-ERR" : ""}` +
      ` ${r.commands.join(",") || "(deferred)"}\n`,
    );
  }

  const byCat: Record<string, { pass: number; total: number }> = {};
  for (const r of rows) {
    byCat[r.category] ??= { pass: 0, total: 0 };
    byCat[r.category].total++;
    if (r.score.success) byCat[r.category].pass++;
  }
  const action = rows.filter((r) => !AGENT_TASKS.find((t) => t.id === r.id)?.ambiguous);
  const ambiguous = rows.filter((r) => AGENT_TASKS.find((t) => t.id === r.id)?.ambiguous);
  const effs = rows.map((r) => r.score.stepEff).filter((x): x is number => x !== null);
  const board = {
    tag: TAG, model: cfg.model, base: cfg.base, runner: RUNNER, bin: BIN,
    maxSteps: MAX_STEPS, ranAt: new Date().toISOString(),
    success: rows.filter((r) => r.score.success).length / rows.length,
    passed: rows.filter((r) => r.score.success).length,
    total: rows.length,
    stepEffMean: effs.length ? effs.reduce((a, b) => a + b, 0) / effs.length : null,
    cmdErrRateMean: rows.reduce((a, r) => a + r.score.cmdErrRate, 0) / rows.length,
    invalidRateMean: rows.reduce((a, r) => a + r.score.invalidRate, 0) / rows.length,
    wrongDefers: action.filter((r) => r.score.wrongDefer).length,
    deferCorrect: ambiguous.length ? ambiguous.filter((r) => r.score.deferCorrect).length / ambiguous.length : null,
    byCat, usage, rows,
  };

  const jsonPath = join(OUT_DIR, `scoreboard.${TAG}.json`);
  writeFileSync(jsonPath, JSON.stringify(board, null, 2));
  const pct = (x: number | null) => (x === null ? "–" : `${(x * 100).toFixed(1)}%`);
  const md = [
    `# MoshAgentBench — ${TAG}`,
    ``,
    `model \`${cfg.model}\` @ \`${cfg.base}\` · runner **${RUNNER}** · ${board.passed}/${board.total} = **${pct(board.success)}** · ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `step-eff ${pct(board.stepEffMean)} · cmd-err ${pct(board.cmdErrRateMean)} · invalid ${pct(board.invalidRateMean)} · wrong-defers ${board.wrongDefers} · defer-correct ${pct(board.deferCorrect)} · tokens ${usage.promptTokens}+${usage.completionTokens} (${usage.calls} calls)`,
    ``,
    `| category | pass | tasks |`,
    `|---|---|---|`,
    ...Object.entries(byCat).map(([c, s]) =>
      `| ${c} | ${s.pass}/${s.total} | ${rows.filter((r) => r.category === c).map((r) => `${r.score.success ? "✓" : "✗"}${r.id}`).join(" ")} |`),
    ``,
    `Failures:`,
    ...rows.filter((r) => !r.score.success).map((r) =>
      `- **${r.id}** (${r.steps} steps): ${r.commands.join(",") || "deferred"} — ${r.score.checks.filter((c) => !c.pass).map((c) => c.note).join("; ") || (r.score.wrongDefer ? "wrongly deferred" : "")}${r.brainError ? ` (brain: ${r.brainError})` : ""}`),
    ``,
  ].join("\n");
  writeFileSync(join(OUT_DIR, `scoreboard.${TAG}.md`), md);
  console.log(`agent-bench[${TAG}]: ${board.passed}/${board.total} = ${pct(board.success)} → ${jsonPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
