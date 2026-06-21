// The executor turns the brain's planned commands into real edits — run as ONE
// undo step via the backend batch_begin/batch_end pair, so a single "Undo" in
// Monster changes reverts the whole thing. Every call is validated against the
// curated catalog before it reaches the command seam; invalid calls are recorded
// as failures and never sent.

import { useStore } from "../store";
import { validateCommand, describeCommand } from "./commands";

export type AgentCommandCall = { command: string; args?: Record<string, unknown> };
export type ChangeEntry = { summary: string; ok: boolean; error?: string };
export type ChangeSet = { label: string; entries: ChangeEntry[]; applied: number };

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

export async function runAgentBatch(
  label: string,
  calls: AgentCommandCall[],
  meta: TurnMeta = {},
): Promise<ChangeSet> {
  const { exec, refresh } = useStore.getState();
  const entries: ChangeEntry[] = [];
  const valid: AgentCommandCall[] = [];

  for (const c of calls) {
    const err = validateCommand(c.command, c.args ?? {});
    if (err) entries.push({ summary: c.command.replace(/_/g, " "), ok: false, error: err });
    else valid.push(c);
  }

  if (valid.length > 0) {
    await exec("batch_begin", {
      name: label, // still the undo-transaction label
      turn_id: newTurnId(),
      utterance: meta.utterance ?? label,
      source: meta.source ?? "brain_chat",
    });
    for (const c of valid) {
      const res = await exec(c.command, c.args ?? {});
      entries.push({
        summary: describeCommand(c.command, c.args ?? {}),
        ok: res.ok,
        error: res.ok ? undefined : res.error,
      });
    }
    await exec("batch_end", {});
    await refresh();
  }

  return { label, entries, applied: entries.filter((e) => e.ok).length };
}

/** Revert the agent's last batch — one undo reverses the whole thing. */
export async function undoAgentBatch(): Promise<void> {
  const { exec, refresh } = useStore.getState();
  await exec("undo");
  await refresh();
}
