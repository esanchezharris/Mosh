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

export async function runAgentBatch(label: string, calls: AgentCommandCall[]): Promise<ChangeSet> {
  const { exec, refresh } = useStore.getState();
  const entries: ChangeEntry[] = [];
  const valid: AgentCommandCall[] = [];

  for (const c of calls) {
    const err = validateCommand(c.command, c.args ?? {});
    if (err) entries.push({ summary: c.command.replace(/_/g, " "), ok: false, error: err });
    else valid.push(c);
  }

  if (valid.length > 0) {
    await exec("batch_begin", { name: label });
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
