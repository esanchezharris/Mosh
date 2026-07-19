// The destructive-command scope limit — PURE module (no store import), so the
// Node-side bench runners (scripts/agentBench.mts) can apply the production
// screen semantics on the real-engine substrate without dragging the WebView
// store/bridge chain into a headless process. executor.ts re-exports everything
// here; app code keeps importing from "./executor".
//
// Moshi runs mutating commands; undo is the backstop, not the only line. A confused
// tool-loop (or an adversarial generative result) that emits "delete everything" should
// not be able to quietly wipe a session in one step. So a single agent batch may run at
// most MAX_DESTRUCTIVE_PER_BATCH destructive WEIGHT — beyond that, ALL the destructive
// calls in that batch are blocked (the constructive ones still run), and the block is
// reported in the change summary. Bulk deletions remain available via the manual UI,
// which this guard never touches.

export type AgentCommandCall = {
  readonly command: string;
  readonly args?: Readonly<Record<string, unknown>>;
};

const DESTRUCTIVE = new Set<string>([
  "remove_track", "remove_clip", "remove_plugin", "remove_render_layer",
  "remove_section", "remove_annotation", "remove_note",
  // Doesn't match the remove/delete/clear_ prefix below, but is a genuine data-loss
  // op: keep_take discards every take lane except the kept one (MoshOps::cmdKeepTake
  // → te::WaveAudioClip::deleteAllUnusedTakes) — a "delete everything but one" spree
  // across many clips is exactly the runaway-tool-loop shape this guard exists for.
  "keep_take",
  // Matches the delete_ prefix anyway; listed explicitly because it carries a
  // non-default weight below (one call can clear a span across EVERY track).
  "delete_time_range",
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

// Per-command destructive WEIGHT. The screen budget counts weights, not calls:
// most destructive commands weigh 1, but delete_time_range clears a whole time
// span across EVERY track, so it consumes the full budget — at most one per
// batch, and never alongside any other destructive call.
const DESTRUCTIVE_WEIGHT: Readonly<Record<string, number>> = {
  delete_time_range: MAX_DESTRUCTIVE_PER_BATCH,
};

export function destructiveWeight(command: string): number {
  return isDestructiveCommand(command) ? (DESTRUCTIVE_WEIGHT[command] ?? 1) : 0;
}

export type DestructiveScreen = {
  readonly allowed: readonly AgentCommandCall[];
  readonly blocked: readonly AgentCommandCall[];
};

export function screenByCommand<T extends AgentCommandCall>(
  calls: readonly T[],
  max: number,
): { readonly allowed: readonly T[]; readonly blocked: readonly T[] } {
  const destructiveCount = calls.reduce(
    (count, call) => count + destructiveWeight(call.command),
    0,
  );
  if (destructiveCount <= max) return { allowed: calls, blocked: [] };
  const allowed: T[] = [];
  const blocked: T[] = [];
  for (const call of calls)
    (isDestructiveCommand(call.command) ? blocked : allowed).push(call);
  return { allowed, blocked };
}

/** Split a planned batch into runnable vs blocked. Under the limit, everything runs. Over
 *  it, the destructive calls are blocked and the constructive calls still run. Pure. */
export function screenDestructive(
  calls: readonly AgentCommandCall[],
  max: number = MAX_DESTRUCTIVE_PER_BATCH,
): DestructiveScreen {
  return screenByCommand(calls, max);
}
