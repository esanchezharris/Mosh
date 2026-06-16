// The executor turns the brain's planned commands into real edits — run as ONE
// undo step via the backend batch_begin/batch_end pair, so a single "Undo" in
// Monster changes reverts the whole thing. Every call is validated against the
// curated catalog before it reaches the command seam; invalid calls are recorded
// as failures and never sent. load_plugin names are resolved to real scanned-plugin
// ids here (the brain says "OTT"; the engine needs the id) — an unresolvable name
// fails the entry rather than loading the wrong plugin.

import { useStore } from "../store";
import { validateCommand, describeCommand, resolvePluginId, coerceArgs } from "./commands";

export type AgentCommandCall = { command: string; args?: Record<string, unknown> };
export type ChangeEntry = { summary: string; ok: boolean; error?: string };
export type ChangeSet = { label: string; entries: ChangeEntry[]; applied: number };

export async function runAgentBatch(label: string, calls: AgentCommandCall[]): Promise<ChangeSet> {
  const { exec, refresh, availablePlugins } = useStore.getState();
  const entries: ChangeEntry[] = [];
  const valid: { call: AgentCommandCall; execArgs: Record<string, unknown> }[] = [];

  for (const c of calls) {
    const args = coerceArgs(c.command, c.args ?? {});
    const err = validateCommand(c.command, args);
    if (err) { entries.push({ summary: c.command.replace(/_/g, " "), ok: false, error: err }); continue; }

    let execArgs = args;
    if (c.command === "load_plugin") {
      const r = resolvePluginId(String(args.pluginId ?? ""), availablePlugins);
      if ("error" in r) { entries.push({ summary: describeCommand(c.command, args), ok: false, error: r.error }); continue; }
      execArgs = { ...args, pluginId: r.id };
    }
    valid.push({ call: c, execArgs });
  }

  if (valid.length > 0) {
    await exec("batch_begin", { name: label });
    for (const { call, execArgs } of valid) {
      const res = await exec(call.command, execArgs);
      entries.push({
        // describe with the ORIGINAL args so the changelog shows "Added OTT", not the id
        summary: describeCommand(call.command, call.args ?? {}),
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
