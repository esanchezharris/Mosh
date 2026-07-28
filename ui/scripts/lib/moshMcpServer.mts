// A stdio MCP server exposing Mosh to a tool-driving agent (the `--codex-mcp`
// bench seat). Two tools: look at the session, change the session.
//
// WHY THIS EXISTS: every other seat forces the model to answer with one JSON blob
// and forbids tools, which measures one-shot recall of the catalog. This measures
// something different and arguably more honest — whether an agent that can LOOK
// before it leaps can operate Mosh. Report it as its own column; a seat that can
// observe mid-task should beat one that cannot, and by how much is the finding.
//
// SUBSTRATE: the same cumulative-prefix replay every other seat uses. The server
// holds the accumulated command list and re-runs [setup, ...accepted] in a fresh
// headless engine per call. Determinism and semantics are therefore identical to
// the one-shot seats; only the agent's ACCESS shape differs, which is the one
// variable we want to isolate.
//
// PRODUCTION SEMANTICS ARE ENFORCED HERE, not skipped: catalog validation and the
// destructive screen run on every call, exactly as AgentEnv.runBatch does. Without
// that this seat would be scored under looser rules than the seats it is compared
// against, and would win for the wrong reason.
//
// The server writes its state to MOSH_MCP_STATE after every call, so the parent
// can reconstruct the run even when codex dies mid-task.
//
// Inputs (env): MOSH_MCP_BIN, MOSH_MCP_SETUP (JSON Cmd[]), MOSH_MCP_SESSION,
//               MOSH_MCP_STATE.

import { writeFileSync } from "node:fs";
import { runScript, snapshotAt, type Cmd } from "./realEngine.mts";
import { validateCommand } from "../../src/agent/commands";
import { destructiveWeight, MAX_DESTRUCTIVE_PER_BATCH } from "../../src/agent/destructiveScreen";

const BIN = process.env.MOSH_MCP_BIN!;
const SETUP: Cmd[] = JSON.parse(process.env.MOSH_MCP_SETUP ?? "[]");
const SESSION = process.env.MOSH_MCP_SESSION ?? "mcp-seat";
const STATE = process.env.MOSH_MCP_STATE;

/** Commands the agent has successfully applied, in order. The replay prefix. */
const applied: Cmd[] = [];
/** Every attempt, accepted or not — the transcript the bench scores. */
const attempts: Array<{ command: string; args: Record<string, unknown>; ok: boolean; error?: string }> = [];
let calls = 0;
/** Running destructive weight for this task — see the screen note in applyCommand. */
let destructiveSpent = 0;

const persist = () => {
  if (STATE) writeFileSync(STATE, JSON.stringify({ applied, attempts, calls }, null, 2));
};

const script = () => [...SETUP, ...applied];
const snapshotNow = () => snapshotAt(BIN, script(), `${SESSION}-s${calls++}`).snap;

/** Compact session view — the same information the one-shot seats get in their
 *  prompt, so the comparison is about ACCESS not about knowing more. */
function renderSnapshot(): string {
  const snap = snapshotNow() as Record<string, unknown>;
  return JSON.stringify(snap, null, 1).slice(0, 20_000);
}

function applyCommand(command: string, args: Record<string, unknown>): { ok: boolean; error?: string } {
  const invalid = validateCommand(command, args);
  if (invalid) {
    attempts.push({ command, args, ok: false, error: invalid });
    persist();
    return { ok: false, error: invalid };
  }
  // The destructive screen, ADAPTED — deliberately, not skipped.
  //
  // screenDestructive is a per-BATCH rule: it blocks when one submitted batch
  // exceeds the weight budget. A tool-driving agent submits one command at a time,
  // so calling it per-command would never block anything — a guard that cannot
  // fire, which is worse than no guard because it reads as protection.
  //
  // So the same budget is enforced as a RUNNING total across the task: an agent
  // gets the same destructive headroom a one-shot agent gets in a single batch,
  // and can't launder a mass delete past the screen by drip-feeding it. Same
  // constant, same weights (delete_time_range still consumes the whole budget).
  const weight = destructiveWeight(command);
  if (weight > 0 && destructiveSpent + weight > MAX_DESTRUCTIVE_PER_BATCH) {
    const reason =
      `Blocked: this task's destructive budget (${MAX_DESTRUCTIVE_PER_BATCH}) is spent. ` +
      `Delete less, or ask the user.`;
    attempts.push({ command, args, ok: false, error: reason });
    persist();
    return { ok: false, error: reason };
  }
  destructiveSpent += weight;

  const next = [...applied, { command, args } as Cmd];
  const out = runScript(BIN, [...SETUP, ...next], `${SESSION}-x${calls++}`);
  const last = out.results[out.results.length - 1] as Record<string, unknown> | undefined;
  const ok = last?.ok === true;
  const error = ok ? undefined : String(last?.error ?? "command failed");
  if (ok) applied.push({ command, args } as Cmd);
  attempts.push({ command, args, ok, error });
  persist();
  return { ok, error };
}

// ── MCP stdio plumbing (JSON-RPC lines) ───────────────────────────────────────
const send = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const reply = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const text = (s: string, isError = false) => ({ content: [{ type: "text", text: s }], isError });

const TOOLS = [
  {
    name: "get_snapshot",
    description:
      "Read the current Mosh session: tracks, clips, sections, tempo, key, master and buses. " +
      "Call this before acting when you need an id or need to see what changed.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "execute_command",
    description:
      "Run ONE Mosh command. Returns { ok } or { ok:false, error } — read the error and adapt. " +
      "Use the exact command names and argument names from the catalog in your instructions.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "e.g. set_track_volume" },
        args: { type: "object", additionalProperties: true, description: "the command's arguments" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
];

let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line); } catch { continue; }

    try {
      if (msg.method === "initialize") {
        reply(msg.id, {
          protocolVersion: (msg.params as Record<string, unknown>)?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "mosh", version: "0.1.0" },
        });
      } else if (msg.method === "tools/list") {
        reply(msg.id, { tools: TOOLS });
      } else if (msg.method === "tools/call") {
        const p = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        if (p.name === "get_snapshot") {
          reply(msg.id, text(renderSnapshot()));
        } else if (p.name === "execute_command") {
          const a = p.arguments ?? {};
          const r = applyCommand(String(a.command ?? ""), (a.args ?? {}) as Record<string, unknown>);
          // Errors come back as CONTENT, not as a protocol error: the model is
          // meant to read and adapt to them, which is the whole point of the seat.
          reply(msg.id, text(JSON.stringify(r), !r.ok));
        } else {
          reply(msg.id, text(`unknown tool "${p.name}"`, true));
        }
      } else if (msg.id !== undefined) {
        reply(msg.id, {});
      }
    } catch (e) {
      if (msg.id !== undefined) reply(msg.id, text(`server error: ${String(e).slice(0, 200)}`, true));
    }
  }
});

process.stdin.on("end", () => { persist(); process.exit(0); });
