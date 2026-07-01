// The executor turns the brain's planned commands into real edits — run as ONE
// undo step via the backend batch_begin/batch_end pair, so a single "Undo" in
// Monster changes reverts the whole thing. Every call is validated against the
// curated catalog before it reaches the command seam; invalid calls are recorded
// as failures and never sent.

import { useStore } from "../store";
import { validateCommand, describeCommand } from "./commands";

export type AgentCommandCall = {
  command: string;
  args?: Record<string, unknown>;
  capture?: Record<string, string>;
  bind?: string;
};
export type ChangeEntry = { summary: string; ok: boolean; error?: string };
export type ChangeSet = { label: string; entries: ChangeEntry[]; applied: number };

// ── Destructive-command scope limit (safety) ─────────────────────────────────
// Moshi runs mutating commands; undo is the backstop, not the only line. A confused
// tool-loop (or an adversarial generative result) that emits "delete everything" should
// not be able to quietly wipe a session in one step. So a single agent batch may run at
// most MAX_DESTRUCTIVE_PER_BATCH destructive commands — beyond that, ALL the destructive
// calls in that batch are blocked (the constructive ones still run), and the block is
// reported in the change summary. Bulk deletions remain available via the manual UI, which
// this guard never touches.
const DESTRUCTIVE = new Set<string>([
  "remove_track", "remove_clip", "remove_plugin", "remove_render_layer",
  "remove_section", "remove_annotation", "remove_note",
]);

/** A command is destructive if it's a known delete OR matches the remove/delete/clear_
 *  prefix (defence-in-depth so a future destructive command is caught by default). */
export function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE.has(command) || /^(remove|delete|clear)_/.test(command);
}

export const MAX_DESTRUCTIVE_PER_BATCH = 10;
export const DESTRUCTIVE_BLOCK_REASON =
  `Blocked: too many destructive commands in one step (limit ${MAX_DESTRUCTIVE_PER_BATCH}). ` +
  `Delete in smaller steps or use the editor directly.`;

export type DestructiveScreen = { allowed: AgentCommandCall[]; blocked: AgentCommandCall[] };

function refName(value: string): string | null {
  if (value.startsWith("${") && value.endsWith("}")) return value.slice(2, -1);
  return null;
}

function resolveValue(value: unknown, refs: Map<string, unknown>): { value: unknown; missing: string[] } {
  if (typeof value === "string") {
    const ref = refName(value);
    if (ref) {
      if (refs.has(ref)) return { value: refs.get(ref), missing: [] };
      return { value, missing: [value] };
    }
    return { value, missing: [] };
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    const missing: string[] = [];
    for (const item of value) {
      const r = resolveValue(item, refs);
      out.push(r.value);
      missing.push(...r.missing);
    }
    return { value: out, missing };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const r = resolveValue(item, refs);
      out[key] = r.value;
      missing.push(...r.missing);
    }
    return { value: out, missing };
  }
  return { value, missing: [] };
}

function resolveArgs(args: Record<string, unknown>, refs: Map<string, unknown>): {
  args: Record<string, unknown>;
  missing: string[];
} {
  const r = resolveValue(args, refs);
  return { args: r.value as Record<string, unknown>, missing: r.missing };
}

function bindResult(call: AgentCommandCall, data: unknown, refs: Map<string, unknown>): void {
  if (!data || typeof data !== "object") return;
  const record = data as Record<string, unknown>;
  if (call.bind) {
    const id = record.trackId ?? record.clipId ?? record.id;
    if (typeof id === "string") refs.set(call.bind, id);
  }
  for (const [name, field] of Object.entries(call.capture ?? {})) {
    const value = record[field];
    if (value !== undefined) refs.set(name, value);
  }
}

/** Split a planned batch into runnable vs blocked. Under the limit, everything runs. Over
 *  it, the destructive calls are blocked and the constructive calls still run. Pure. */
export function screenDestructive(
  calls: AgentCommandCall[],
  max: number = MAX_DESTRUCTIVE_PER_BATCH,
): DestructiveScreen {
  const destructiveCount = calls.reduce((n, c) => n + (isDestructiveCommand(c.command) ? 1 : 0), 0);
  if (destructiveCount <= max) return { allowed: calls, blocked: [] };
  const allowed: AgentCommandCall[] = [];
  const blocked: AgentCommandCall[] = [];
  for (const c of calls) (isDestructiveCommand(c.command) ? blocked : allowed).push(c);
  return { allowed, blocked };
}

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
  const candidates: AgentCommandCall[] = [];

  for (const c of calls) {
    const err = validateCommand(c.command, c.args ?? {});
    if (err) entries.push({ summary: c.command.replace(/_/g, " "), ok: false, error: err });
    else candidates.push(c);
  }

  // Safety: cap destructive commands per batch so a runaway tool-loop can't wipe a session.
  const { allowed, blocked } = screenDestructive(candidates);
  for (const c of blocked) {
    entries.push({ summary: describeCommand(c.command, c.args ?? {}), ok: false, error: DESTRUCTIVE_BLOCK_REASON });
  }

  const refs = new Map<string, unknown>();
  let batchOpen = false;
  for (const c of allowed) {
    const resolved = resolveArgs(c.args ?? {}, refs);
    if (resolved.missing.length > 0) {
      entries.push({
        summary: describeCommand(c.command, c.args ?? {}),
        ok: false,
        error: `unbound ref ${resolved.missing.join(", ")}`,
      });
      continue;
    }
    const err = validateCommand(c.command, resolved.args);
    if (err) {
      entries.push({ summary: c.command.replace(/_/g, " "), ok: false, error: err });
      continue;
    }
    if (!batchOpen) {
      batchOpen = true;
      await exec("batch_begin", {
        name: label, // still the undo-transaction label
        turn_id: newTurnId(),
        utterance: meta.utterance ?? label,
        source: meta.source ?? "brain_chat",
      });
    }
    const res = await exec(c.command, resolved.args);
    entries.push({
      summary: describeCommand(c.command, resolved.args),
      ok: res.ok,
      error: res.ok ? undefined : res.error,
    });
    if (res.ok) bindResult(c, res.data, refs);
  }

  if (batchOpen) {
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
