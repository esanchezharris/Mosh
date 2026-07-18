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
import { RULES_WITH_EXAMPLES } from "../src/agent/fewshot";
import { validateCommand } from "../src/agent/commands";
import { BENCH_CASES, type BenchCase, type Cmd } from "../src/bench/cases";
import { grade } from "../src/bench/goalChecks";
import { argFlag, brainConfigFromEnv, callBrain, findBin, loadEnv, snapshotAt, runScript, type BrainUsage } from "./lib/realEngine.mts";

const env = loadEnv();
const cfg = brainConfigFromEnv(env, argFlag("model"));
const BIN = findBin(argFlag("bin"));
const TAG = argFlag("tag", cfg.model.replace(/[^a-zA-Z0-9.-]/g, "_"))!;
const OUT_DIR = argFlag("out-dir", join(process.cwd(), "..", "docs", "bench"))!;
const RENDER = !process.argv.includes("--no-render");
const CASE_FILTER = (argFlag("cases", "all") || "all").split(",");
// --rules examples → append the worked-example bank (the +30pp-lever A/B arm).
const RULES = argFlag("rules") === "examples" ? RULES_WITH_EXAMPLES : DEFAULT_RULES;
// --repair → allow ONE error-driven repair turn (observable signals only).
const REPAIR = process.argv.includes("--repair");
const ART_DIR = join(homedir(), "mosh-bench-artifacts", TAG);
mkdirSync(OUT_DIR, { recursive: true });

// grade() lives in src/bench/goalChecks.ts now — shared verbatim with
// MoshAgentBench (scripts/agentBench.mts) and the vitest harness smoke.

const DESTRUCTIVE = /^(remove|delete|clear)_/;
async function runCase(c: BenchCase, usage: BrainUsage) {
  const session = `bench-${TAG}-${c.id}`.slice(0, 60);
  const { snap: before } = snapshotAt(BIN, c.setup, session);
  const system = buildSystemPrompt(RULES, before);
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
  let repaired = false;
  let executedCmds = allowed.map((x) => ({ command: x.command, args: x.args ?? {} }));
  if (allowed.length > 0) {
    const bracket: Cmd[] = [
      { command: "batch_begin", args: { name: `bench: ${c.id}`, turn_id: `bench-${c.id}`, utterance: c.utterance, source: "brain_chat" } },
      ...executedCmds,
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

    // --repair: ONE observable-signal repair turn — the model sees its own command
    // errors + the fresh REAL snapshot (never the gold checks) and gets one shot to
    // fix. The measured pattern (validated retries) that took beat-building 0/9→9/9.
    if (REPAIR && cmdResults.some((r) => !r.ok)) {
      const errs = cmdResults.filter((r) => !r.ok).map((r) => `${r.command}: ${r.error ?? "failed"}`).join("; ");
      try {
        const { content: fixContent } = await callBrain(cfg, [
          { role: "system", content: system },
          { role: "user", content: c.utterance },
          { role: "assistant", content },
          { role: "user", content: `Some of those commands failed: ${errs}. Reply with ONLY the corrected commands (same JSON contract).` },
        ], usage);
        const fixReply = parseReply(fixContent);
        const fixCmds = (fixReply.commands ?? []).filter((x) => !validateCommand(x.command, x.args ?? {}));
        if (fixCmds.length > 0) {
          repaired = true;
          const keep = executedCmds.filter((_, i) => cmdResults[i]?.ok);
          const fixes = fixCmds.map((x) => ({ command: x.command, args: x.args ?? {} }));
          const bracket2: Cmd[] = [
            { command: "batch_begin", args: { name: `bench-fix: ${c.id}`, turn_id: `bench-${c.id}-fix`, utterance: c.utterance, source: "brain_chat" } },
            ...keep,
            ...fixes,
            { command: "batch_end", args: {} },
          ];
          const out2 = snapshotAt(BIN, [...c.setup, ...bracket2], `${session}-fix`);
          after = out2.snap;
          const slice2 = out2.results.slice(c.setup.length + 1, c.setup.length + 1 + keep.length + fixes.length);
          const all2 = [...keep, ...fixes];
          cmdResults = all2.map((x, i) => ({
            command: x.command,
            ok: slice2[i] ? (slice2[i] as any).ok !== false : false,
            error: slice2[i] && typeof (slice2[i] as any).error === "string" ? ((slice2[i] as any).error as string) : undefined,
          }));
          executedCmds = all2;
        }
      } catch {
        /* repair call failed — keep first-shot results */
      }
    }
  }

  const checks = c.checks.map((k) => grade(k, before, after, cmdResults));
  const appliedClean = cmdResults.every((r) => r.ok);
  const isDefer = c.checks.some((k) => k.kind === "defer");
  const genuineDefer = isDefer && !brainError && invalidCount === 0;
  const pass = checks.every((r) => r.pass) && (isDefer ? genuineDefer : allowed.length > 0 && appliedClean);

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
    repaired,
    commands: executedCmds.map((x) => x.command),
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
