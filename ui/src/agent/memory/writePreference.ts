// M3 (Phase-B memory lane) — the shared "write a preference + invalidate + report
// back its ts" sequence used by BOTH the fastPath "remember" rule (explicit:true,
// user-initiated, ui/src/agent/fastPath.ts) and the remember_preference
// pseudo-command (explicit:false, agent-initiated, ui/src/agent/memory/
// rememberPreference.ts). Bridge-coupled (calls an executeCommand-shaped `exec`), so
// this lives beside hydrate.ts, not in the pure retrieveContext.ts/scoring.ts.
//
// agent_memory_write only returns {count} (see M1) — a caller that wants to offer a
// delete-by-ts undo affordance (the fastPath toast; a future drawer entry) needs the
// written record's own `ts`, so this reads it straight back (newest-first, limit 1)
// immediately after a successful write. Safe in this single-threaded UI: nothing else
// can race a write between these two calls.

import { invalidateMemoryHydration } from "./hydrate";

// Structurally minimal on purpose (only the fields actually read below) so BOTH the
// full bridge CommandResult (store.exec) and loop/taskExec.ts's narrower local
// ExecResult (which omits `command`) satisfy it without an adapter at each call site.
export type ExecFn = (command: string, args?: Record<string, unknown>) => Promise<{
  ok: boolean;
  data?: unknown;
  error?: string;
}>;

export type WritePreferenceResult = { ok: true; ts: number } | { ok: false; error: string };

/** Writes a "preference"-kind item (global store, or this project's sidecar) and
 *  invalidates the hydration cache so the NEXT retrieval sees it. */
export async function writePreference(
  exec: ExecFn,
  text: string,
  scope: "global" | "project",
  explicitFlag: boolean,
): Promise<WritePreferenceResult> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "nothing to remember" };

  const w = await exec("agent_memory_write", { scope, kind: "preference", explicit: explicitFlag, item: trimmed });
  if (!w.ok) return { ok: false, error: w.error ?? "agent_memory_write failed" };
  invalidateMemoryHydration();

  // kind filtering on agent_memory_read is global-scope-only (M1 contract) — project
  // reads always return everything, newest-first, so items[0] is still the item we
  // just wrote (nothing else can have raced a write in between, single-threaded UI).
  const r = await exec("agent_memory_read", { scope, kind: scope === "global" ? "preference" : undefined, limit: 1 });
  const items = (r.data as { items?: { ts: number }[] } | undefined)?.items;
  const ts = items?.[0]?.ts;
  if (typeof ts !== "number") return { ok: false, error: "wrote the preference but couldn't confirm it" };
  return { ok: true, ts };
}
