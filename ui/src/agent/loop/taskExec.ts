// The task-scoped AgentEnv the APP uses: ONE native undo transaction
// (batch_begin … batch_end) spans every step of an agent task, so a single
// Cmd+Z — or the drawer's Undo — reverts the whole task. Native semantics
// verified: MoshOps::beginTxn coalesces every command while `inBatch`, and the
// dev mock mirrors it (per-command pushUndo suppressed inside a batch).
//
// Lifecycle hardening (the approved Phase-B design):
// - LAZY open: the batch opens on the first step that carries a mutating
//   command, so a purely read-only task never touches the undo stack.
// - SELF-HEAL: if batch_begin answers "a batch is already open" (a zombie from
//   a prior JS crash — the hazard window grows from ms to minutes with a
//   multi-step task), close it and retry once.
// - close() in a finally on every exit path; idempotent.
// - The destructive budget is TASK-cumulative: 6 removes in step 1 leave only
//   4 for the rest of the task, and delete_time_range still consumes the whole
//   budget (destructiveScreen weights).

import { useStore } from "../../store";
import { validateCommand } from "../commands";
import {
  destructiveWeight, isDestructiveCommand,
  MAX_DESTRUCTIVE_PER_BATCH, DESTRUCTIVE_BLOCK_REASON,
} from "../destructiveScreen";
import type { AgentEnv, StepCommandResult } from "../loopSeam";
import type { Snapshot } from "../../types";

export type TaskMeta = { utterance?: string; source?: string };

type ExecResult = { ok: boolean; error?: string; data?: unknown };
export type TaskExecDeps = {
  exec?: (command: string, args?: Record<string, unknown>) => Promise<ExecResult>;
  refresh?: () => Promise<void>;
};

// Commands a step may run WITHOUT opening the task's undo transaction. Kept
// deliberately small — anything not listed is treated as mutating.
const READ_ONLY = new Set([
  "list_builtins", "list_plugins", "list_takes", "list_track_outputs",
  "detect_clip_bpm", "get_rhymes", "analyze_lyrics",
]);

function newTurnId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch { /* non-crypto fallback below */ }
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export type TaskExecutor = {
  env: AgentEnv;
  /** Close the task's undo transaction (idempotent; call in a finally). */
  close(): Promise<void>;
  /** Whether the native batch was actually opened (false for read-only tasks). */
  opened(): boolean;
};

export function createTaskExecutor(label: string, meta: TaskMeta = {}, deps: TaskExecDeps = {}): TaskExecutor {
  const exec = deps.exec ?? ((c: string, a?: Record<string, unknown>) => useStore.getState().exec(c, a));
  const refresh = deps.refresh ?? (() => useStore.getState().refresh());
  let opened = false;
  let closed = false;
  let destructiveUsed = 0;

  async function getSnapshot(): Promise<Snapshot> {
    await refresh();
    const s = useStore.getState().snapshot;
    if (!s) throw new Error("task env: store has no snapshot");
    return s;
  }

  async function ensureOpen(): Promise<void> {
    if (opened) return;
    const args = {
      name: label,
      turn_id: newTurnId(),
      utterance: meta.utterance ?? label,
      source: meta.source ?? "agent_loop",
    };
    let begin = await exec("batch_begin", args);
    if (!begin.ok && /already open/i.test(begin.error ?? "")) {
      await exec("batch_end", {}); // heal the zombie, then retry once
      begin = await exec("batch_begin", args);
    }
    if (!begin.ok) throw new Error(`batch_begin failed: ${begin.error ?? "unknown error"}`);
    opened = true;
  }

  const env: AgentEnv = {
    getSnapshot,
    async runBatch(_stepLabel, calls) {
      if (closed) throw new Error("task executor is closed");
      type Entry = StepCommandResult & { index: number };
      const entries: Entry[] = [];
      const valid: Array<{ index: number; command: string; args: Record<string, unknown> }> = [];
      calls.forEach((c, index) => {
        const err = validateCommand(c.command, (c.args ?? {}) as Record<string, unknown>);
        if (err) entries.push({ index, command: c.command, ok: false, error: err });
        else valid.push({ index, command: c.command, args: (c.args ?? {}) as Record<string, unknown> });
      });

      // Task-cumulative destructive screen (same reporting shape as runAgentBatch).
      const stepWeight = valid.reduce((n, c) => n + destructiveWeight(c.command), 0);
      let allowed = valid;
      if (destructiveUsed + stepWeight > MAX_DESTRUCTIVE_PER_BATCH) {
        for (const c of valid)
          if (isDestructiveCommand(c.command))
            entries.push({ index: c.index, command: c.command, ok: false, error: DESTRUCTIVE_BLOCK_REASON });
        allowed = valid.filter((c) => !isDestructiveCommand(c.command));
      } else {
        destructiveUsed += stepWeight;
      }

      if (allowed.some((c) => !READ_ONLY.has(c.command))) await ensureOpen();
      for (const c of allowed) {
        const r = await exec(c.command, c.args);
        entries.push({ index: c.index, command: c.command, ok: r.ok, error: r.ok ? undefined : r.error });
      }

      entries.sort((a, b) => a.index - b.index);
      return {
        results: entries.map(({ command, ok, error }) => ({ command, ok, error })),
        snapshot: await getSnapshot(),
      };
    },
  };

  return {
    env,
    opened: () => opened,
    async close() {
      if (closed) return;
      closed = true;
      if (opened) {
        await exec("batch_end", {});
        await refresh();
      }
    },
  };
}

/** Revert the last agent TASK — one undo covers the whole transaction. */
export async function undoAgentTask(): Promise<boolean> {
  const { exec, refresh } = useStore.getState();
  const result = await exec("undo");
  await refresh();
  if (!result.ok) return false;
  if (result.data === true) return true;
  if (result.data === null || typeof result.data !== "object" || Array.isArray(result.data)) return false;
  return "undone" in result.data && (result.data as { undone?: unknown }).undone === true;
}
