// The executor turns the brain's planned commands into real edits — run as ONE
// undo step via the backend batch_begin/batch_end pair, so a single "Undo" in
// Moshi changes reverts the whole thing. Every call is validated against the
// curated catalog before it reaches the command seam; invalid calls are recorded
// as failures and never sent.

import { useStore } from "../store";
import { validateCommand, describeCommand } from "./commands";
import { screenByCommand, MAX_DESTRUCTIVE_PER_BATCH, DESTRUCTIVE_BLOCK_REASON } from "./destructiveScreen";
import { MEMORY_COMMANDS, handleRememberPreference } from "./memory/rememberPreference";
import { bumpPatternUsesIfMatched } from "./memory/usesTracking";

// The destructive screen itself lives in ./destructiveScreen (a PURE module the
// Node-side bench runners can import without the store/bridge chain); it is
// re-exported here so app code and tests keep one import surface.
export {
  isDestructiveCommand, destructiveWeight, screenDestructive,
  MAX_DESTRUCTIVE_PER_BATCH, DESTRUCTIVE_BLOCK_REASON,
} from "./destructiveScreen";
export type { AgentCommandCall, DestructiveScreen } from "./destructiveScreen";
import type { AgentCommandCall } from "./destructiveScreen";

export type ChangeEntry = {
  readonly index: number;
  readonly command: string;
  readonly summary: string;
  readonly ok: boolean;
  readonly error?: string;
};
export type ChangeSet = {
  readonly label: string;
  readonly entries: readonly ChangeEntry[];
  readonly applied: number;
};

export class AgentBatchBoundaryError extends Error {
  readonly boundary: "begin" | "end";
  readonly changes: ChangeSet;

  constructor(boundary: "begin" | "end", message: string, changes: ChangeSet) {
    super(message);
    this.name = "AgentBatchBoundaryError";
    this.boundary = boundary;
    this.changes = changes;
  }
}

type IndexedCommandCall = AgentCommandCall & { readonly index: number };

const HISTORY_CONTROL_COMMANDS = new Set(["undo", "redo"]);
export const HISTORY_CONTROL_BATCH_REASON = "undo and redo must run alone";

// Provenance for the harvested-trajectory dataset (Phase 0). It rides the
// existing batch_begin args — which the backend logs verbatim — so the harvester
// can group a turn's commands under the utterance that triggered them. Pure
// metadata on the existing log path: not a new command, not a second log.
export type TurnMeta = { utterance?: string; source?: string };

function newTurnId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* fall through to the non-crypto id below */
  }
  return `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// FS-B2a (H2) — the turn marker's args. `utterance` is OMITTED (key absent, never
// empty-string) when no real transcript reached us. It used to fall back to `label`,
// but the label is Moshi's OWN output (reply.say, a fast-path caption, "voice") — so
// a miner could not tell a real ask from a synthesized one, and the skill lane this
// provenance exists for would learn its trigger phrases from the model's own words.
// Absent is honest; fabricated is not. `name` stays the undo-transaction label.
function turnMarkerArgs(label: string, meta: TurnMeta): Record<string, unknown> {
  const args: Record<string, unknown> = {
    name: label,
    turn_id: newTurnId(),
    source: meta.source ?? "brain_chat",
  };
  if (meta.utterance) args.utterance = meta.utterance;
  return args;
}

// FS-B2a (H3) — record an ask that produced NO commands: the brain planned nothing,
// every call failed validation, the destructive screen blocked the lot, or a section
// rework resolved empty. Those turns used to leave no trace at all, yet they are the
// highest-value rows for skill mining — an ask we could not serve names a missing
// skill. Emits the SAME batch_begin/batch_end pair with nothing between, so the
// harvester needs no new shape. Safe for undo: UndoManager::beginNewTransaction only
// sets a flag; no ActionSet exists until a perform(), so an empty pair adds nothing
// to the undo stack. Best-effort — a marker failure must never surface to the user.
export async function logAgentTurn(label: string, meta: TurnMeta): Promise<void> {
  const { exec } = useStore.getState();
  try {
    const begin = await exec("batch_begin", turnMarkerArgs(label, meta));
    if (!begin.ok) return;
    await exec("batch_end", {});
  } catch {
    /* provenance is never worth breaking a turn over */
  }
}

function changeSet(label: string, entries: readonly ChangeEntry[]): ChangeSet {
  return {
    label,
    entries: [...entries].sort((left, right) => left.index - right.index),
    applied: entries.filter((entry) => entry.ok).length,
  };
}

function historyControlApplied(command: string, data: unknown): boolean {
  if (data === true) return true;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  const result = data as Record<string, unknown>;
  return command === "undo" ? result.undone === true : result.redone === true;
}

export async function runAgentBatch(
  label: string,
  calls: readonly AgentCommandCall[],
  meta: TurnMeta = {},
): Promise<ChangeSet> {
  const { exec, refresh } = useStore.getState();
  const entries: ChangeEntry[] = [];
  const valid: IndexedCommandCall[] = [];

  // History controls must never share the transaction they are meant to walk.
  // Opening batch_begin before undo/redo creates a new undo head, so the command
  // consumes that fresh boundary instead of reverting the user's prior edit.
  // Reject a mixed plan before pseudo-commands or seam calls can mutate anything.
  if (calls.some((call) => HISTORY_CONTROL_COMMANDS.has(call.command)) && calls.length !== 1) {
    return changeSet(label, calls.map((call, index) => ({
      index,
      command: call.command,
      summary: describeCommand(call.command, call.args ?? {}),
      ok: false,
      error: HISTORY_CONTROL_BATCH_REASON,
    })));
  }

  for (const [index, c] of calls.entries()) {
    // AGT-MEM (M3) — remember_preference is a PSEUDO-command: intercepted here,
    // BEFORE validateCommand (which would reject it as "not an allowed command" —
    // it has no ArgSpec and is deliberately never added to AGENT_COMMANDS). Runs
    // immediately, outside the batch_begin/batch_end transaction below (a memory
    // write is non-undoable and touches no ValueTree — see M1).
    if (MEMORY_COMMANDS.has(c.command)) {
      const r = await handleRememberPreference(c.args, exec);
      entries.push({ index, command: r.command, summary: describeCommand(r.command, c.args ?? {}), ok: r.ok, error: r.error });
      continue;
    }
    const err = validateCommand(c.command, c.args ?? {});
    if (err) {
      entries.push({
        index,
        command: c.command,
        summary: c.command.replace(/_/g, " "),
        ok: false,
        error: err,
      });
    } else valid.push({ ...c, index });
  }

  // Safety: cap destructive commands per batch so a runaway tool-loop can't wipe a session.
  const { allowed, blocked } = screenByCommand(valid, MAX_DESTRUCTIVE_PER_BATCH);
  for (const c of blocked) {
    entries.push({
      index: c.index,
      command: c.command,
      summary: describeCommand(c.command, c.args ?? {}),
      ok: false,
      error: DESTRUCTIVE_BLOCK_REASON,
    });
  }

  // FS-B2a (H3) — nothing survived validation/screening, so no batch runs; still
  // record the ask, or this turn (a missing-skill signal) vanishes from the log.
  // Memory pseudo-commands don't count: they are intercepted above and deliberately
  // run OUTSIDE any transaction, so a "remember X" turn was SERVED — marking it
  // unserved would both lie and open a batch that turn must never have (AGT-MEM M3).
  const seamCalls = calls.filter((c) => !MEMORY_COMMANDS.has(c.command)).length;
  if (allowed.length === 0 && seamCalls > 0) await logAgentTurn(label, meta);

  // Undo/redo are history navigation, not edits to collect into a new history
  // unit. Dispatch the one allowed control directly and carry the same turn
  // provenance in its own logged args. Both native (boolean data) and the mock
  // ({undone|redone}) report whether anything actually changed; surface a no-op
  // honestly instead of calling the turn successful.
  if (allowed.length === 1 && HISTORY_CONTROL_COMMANDS.has(allowed[0].command)) {
    const c = allowed[0];
    const res = await exec(c.command, { ...(c.args ?? {}), ...turnMarkerArgs(label, meta) });
    const applied = res.ok && historyControlApplied(c.command, res.data);
    entries.push({
      index: c.index,
      command: c.command,
      summary: describeCommand(c.command, c.args ?? {}),
      ok: applied,
      error: applied ? undefined : (res.ok ? `nothing to ${c.command}` : res.error),
    });
    await refresh();
    return changeSet(label, entries);
  }

  if (allowed.length > 0) {
    const begin = await exec("batch_begin", turnMarkerArgs(label, meta));
    if (!begin.ok)
      throw new AgentBatchBoundaryError(
        "begin",
        `batch_begin failed: ${begin.error ?? "unknown error"}`,
        changeSet(label, entries),
      );
    for (const c of allowed) {
      const res = await exec(c.command, c.args ?? {});
      entries.push({
        index: c.index,
        command: c.command,
        summary: describeCommand(c.command, c.args ?? {}),
        ok: res.ok,
        error: res.ok ? undefined : res.error,
      });
      // AGT-MEM (M4, item 6) — cheap "uses" tracking: fire-and-forget, never awaited
      // (a secondary effect that must not add latency to this batch); no-ops unless
      // this exact command replayed a saved pattern card verbatim.
      if (res.ok) void bumpPatternUsesIfMatched(c.command, c.args, exec);
    }
    const end = await exec("batch_end", {});
    await refresh();
    if (!end.ok)
      throw new AgentBatchBoundaryError(
        "end",
        `batch_end failed: ${end.error ?? "unknown error"}`,
        changeSet(label, entries),
      );
  }

  return changeSet(label, entries);
}

/** Revert the agent's last batch — one undo reverses the whole thing. */
export async function undoAgentBatch(): Promise<boolean> {
  const { exec, refresh } = useStore.getState();
  const result = await exec("undo");
  await refresh();
  if (!result.ok) return false;
  return historyControlApplied("undo", result.data);
}
