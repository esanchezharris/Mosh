// The tool-driving Codex seat: `codex exec` with the Mosh MCP server attached, so
// the agent can LOOK at the session and change it, instead of answering with one
// JSON blob and being told not to use tools.
//
// This is a DIFFERENT measurement from the one-shot seats, not a better one. An
// agent that can observe mid-task should beat one that cannot; the finding is by
// how much, and on which categories. Never merge its number into a one-shot board.
//
// ⚠ REQUIRES --dangerously-bypass-approvals-and-sandbox. Measured 2026-07-27
// against codex-cli 0.144.1: MCP tool calls are auto-CANCELLED headlessly under
// every narrower setting tried — `approval_policy="never"`, per-tool
// `approval_mode="auto"`, and `-a never -s read-only` all produced
// "user cancelled MCP tool call" with the server receiving zero calls. Only the
// bypass flag lets a tool call through. That flag also drops the shell sandbox for
// the whole run, so this seat grants the model unsandboxed shell on the host
// machine for as long as it runs. That is a real cost, it is why this seat is
// opt-in behind its own flag, and it should not be run unattended without
// deciding that trade deliberately.

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotAt, type BrainUsage, type Cmd } from "./realEngine.mts";
import type { AgentTaskRun, StepRecord } from "../../src/agent/loopSeam";
import type { AgentCommandCall } from "../../src/agent/executor";

const WORK = join(tmpdir(), `mosh-codex-mcp-${process.pid}`);

export type McpSeatDeps = {
  readonly bin: string;
  readonly model: string;
  readonly setup: readonly Cmd[];
  readonly session: string;
  readonly systemPrompt: string;
  readonly usage?: BrainUsage;
  readonly maxToolCalls?: number;
};

type State = {
  applied: Cmd[];
  attempts: Array<{ command: string; args: Record<string, unknown>; ok: boolean; error?: string }>;
};

/** Run ONE task through the tool-driving seat and shape the result like every
 *  other runner's, so scoreTask grades it identically. */
export function runCodexMcpTask(ask: string, deps: McpSeatDeps): AgentTaskRun {
  const dir = join(WORK, deps.session);
  mkdirSync(dir, { recursive: true });
  const statePath = join(dir, "state.json");
  if (existsSync(statePath)) rmSync(statePath);

  // The seat instructions go through AGENTS.md — the delivery that measured best
  // for the one-shot codex seat (REPORT_2026-07-19-codex-lane.md), kept identical
  // here so seat shape is not a second variable alongside tool access.
  writeFileSync(join(dir, "AGENTS.md"), `${deps.systemPrompt}

## How to act in this session
You have two tools from the "mosh" MCP server:
  • get_snapshot — read the current session (ids, tracks, clips, tempo, key, master)
  • execute_command — run ONE Mosh command; it returns { ok } or { ok:false, error }

Use them. Read the session before you need an id, act, and read back if you need to
check. When the request is genuinely ambiguous, say so instead of guessing. When you
are finished, reply with a one-line summary of what you did.`);

  const serverPath = join(import.meta.dirname, "moshMcpServer.mts");
  // Codex launches the server with ITS ephemeral cwd, which has no node_modules —
  // `npx tsx` there resolves nothing and the server never starts, which presents as
  // a run where the agent simply chose not to act (measured: 0/2, both WRONG-DEFER).
  // Resolve the real tsx binary from this checkout instead.
  const tsxBin = join(import.meta.dirname, "..", "..", "node_modules", ".bin", "tsx");
  if (!existsSync(tsxBin)) throw new Error(`--codex-mcp needs ui/node_modules/.bin/tsx (looked at ${tsxBin})`);
  const t0 = Date.now();
  const raw = spawnSync("codex", [
    "exec", "-m", deps.model,
    ...(process.env.MOSH_CODEX_EFFORT ? ["-c", `model_reasoning_effort="${process.env.MOSH_CODEX_EFFORT}"`] : []),
    "-c", `mcp_servers.mosh.command="${tsxBin}"`,
    "-c", `mcp_servers.mosh.args=["${serverPath}"]`,
    // Codex does NOT pass its own environment down to an MCP server child — the
    // server's config block is the only channel. Setting these on the codex process
    // instead (the obvious first guess) leaves MOSH_MCP_BIN undefined in the server,
    // which surfaces as a spawnSync type error inside a tool call and reads, from
    // the outside, as the agent simply choosing not to act.
    "-c", `mcp_servers.mosh.env.MOSH_MCP_BIN="${deps.bin}"`,
    "-c", `mcp_servers.mosh.env.MOSH_MCP_SETUP=${JSON.stringify(JSON.stringify(deps.setup))}`,
    "-c", `mcp_servers.mosh.env.MOSH_MCP_SESSION="${deps.session}"`,
    "-c", `mcp_servers.mosh.env.MOSH_MCP_STATE="${statePath}"`,
    "-c", `mcp_servers.mosh.tools.get_snapshot.approval_mode="auto"`,
    "-c", `mcp_servers.mosh.tools.execute_command.approval_mode="auto"`,
    // See the header note: nothing narrower lets an MCP tool call through headlessly.
    "--dangerously-bypass-approvals-and-sandbox",
    "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
    "--color", "never", "--json", "-",
  ], {
    cwd: dir,
    input: ask,
    encoding: "utf8",
    timeout: 900_000,
    env: {
      ...process.env,
      MOSH_MCP_BIN: deps.bin,
      MOSH_MCP_SETUP: JSON.stringify(deps.setup),
      MOSH_MCP_SESSION: deps.session,
      MOSH_MCP_STATE: statePath,
    },
  });
  const ms = Date.now() - t0;

  let say: string | undefined;
  const errors: string[] = [];
  for (const line of String(raw.stdout ?? "").split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const ev = JSON.parse(s) as Record<string, any>;
      if (ev.type === "item.completed" && ev.item?.type === "agent_message") say = String(ev.item.text ?? "");
      if (ev.type === "turn.completed" && deps.usage && ev.usage) {
        deps.usage.promptTokens += ev.usage.input_tokens ?? 0;
        deps.usage.completionTokens += ev.usage.output_tokens ?? 0;
        deps.usage.calls += 1;
      }
      if (ev.type === "error" || ev.type === "turn.failed") errors.push(JSON.stringify(ev).slice(0, 200));
    } catch { /* non-JSON stdout line */ }
  }

  // The STATE FILE is the source of truth for what happened, not the model's own
  // account of it: the server wrote it as each call landed, so a codex crash after
  // real work still yields the real transcript rather than an empty run.
  const state: State = existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, "utf8")) as State)
    : { applied: [], attempts: [] };

  const commands: AgentCommandCall[] = state.attempts.map((a) => ({ command: a.command, args: a.args }));
  const step: StepRecord = {
    say,
    intent: undefined,
    commands,
    results: state.attempts.map((a) => ({ command: a.command, ok: a.ok, error: a.error })),
    // The server rejects catalog-invalid calls with validateCommand's own message,
    // so they are recoverable here without re-validating.
    invalidCount: state.attempts.filter((a) => !a.ok && a.error && !/^Blocked:/.test(a.error)
      && !/failed$/.test(a.error)).length,
    ms,
  };

  const snap = snapshotAt(deps.bin, [...deps.setup, ...state.applied], `${deps.session}-final`).snap;
  const error = state.attempts.length === 0 && errors.length > 0 ? errors.join(" | ") : undefined;

  return {
    finalSnapshot: snap,
    transcript: [step],
    stepCount: 1,
    deferred: commands.length === 0,
    error,
  };
}
