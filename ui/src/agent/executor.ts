// The executor turns the brain's planned commands into real edits — run as ONE
// undo step via the backend batch_begin/batch_end pair, so a single "Undo" in
// Monster changes reverts the whole thing. Every call is validated against the
// curated catalog before it reaches the command seam; invalid calls are recorded
// as failures and never sent.

import { useStore } from "../store";
import { validateCommand, describeCommand } from "./commands";
import { screenByCommand, MAX_DESTRUCTIVE_PER_BATCH, DESTRUCTIVE_BLOCK_REASON } from "./destructiveScreen";

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

function changeSet(label: string, entries: readonly ChangeEntry[]): ChangeSet {
  return {
    label,
    entries: [...entries].sort((left, right) => left.index - right.index),
    applied: entries.filter((entry) => entry.ok).length,
  };
}

export async function runAgentBatch(
  label: string,
  calls: readonly AgentCommandCall[],
  meta: TurnMeta = {},
): Promise<ChangeSet> {
  const { exec, refresh } = useStore.getState();
  const entries: ChangeEntry[] = [];
  const valid: IndexedCommandCall[] = [];

  for (const [index, c] of calls.entries()) {
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

  if (allowed.length > 0) {
    const begin = await exec("batch_begin", {
      name: label, // still the undo-transaction label
      turn_id: newTurnId(),
      utterance: meta.utterance ?? label,
      source: meta.source ?? "brain_chat",
    });
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
  if (result.data === true) return true;
  if (result.data === null || typeof result.data !== "object" || Array.isArray(result.data))
    return false;
  return "undone" in result.data && result.data.undone === true;
}
