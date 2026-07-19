// M4 (Phase-B memory lane, item 6) — cheap, best-effort "uses" tracking: when the
// agent successfully replays a SAVED drum pattern verbatim via add_drum_pattern, bump
// that card's `uses` so future retrieval can prioritize it (retrieveContext.ts's
// uses-then-recency tie-break).
//
// Deliberately cheap: an EXACT string match on the pattern arg (after trimming), not a
// semantic re-parse/compare — "skip if it requires anything ugly" per the approved
// design. Only a REAL, persisted card (positive `ts`) can be bumped; a seed (negative
// synthetic ts from hydrate.ts — never written to disk) has nothing on disk to update,
// so it's silently skipped rather than auto-promoted into a real saved card (that would
// be a bigger, more opinionated behavior than this heuristic is meant to cover).
//
// M1's agent_memory_write is APPEND-only (no update-by-key), so "bump uses" is done as
// delete-the-old-record-by-ts then write-the-bumped-replacement — both existing
// commands, no native change needed. The replacement's `ts` is necessarily NEW (an
// append always gets a fresh ts), which doubles as a recency refresh: using a pattern
// bumps both its uses AND its "last touched" time, matching the tie-break's own
// "uses, then recency" ordering. Never throws — every failure path (no hydrated pools
// yet, no match, the delete/write round-trip failing) is a silent no-op; this must
// never affect the add_drum_pattern call it's piggybacking on.

import { getMemoryPoolsIfHydrated, invalidateMemoryHydration } from "./hydrate";
import { isDrumPatternCard } from "./patternCards";

export type ExecFn = (command: string, args?: Record<string, unknown>) => Promise<{
  ok: boolean;
  error?: string;
  data?: unknown;
}>;

/** Called AFTER a command is known to have already succeeded (its own `ok` is not
 *  re-checked here). Not awaited by its callers on purpose (executor.ts / loop/
 *  taskExec.ts fire-and-forget it) — a secondary effect that must never add latency to
 *  the user-visible batch it rides along. */
export async function bumpPatternUsesIfMatched(
  command: string,
  args: Record<string, unknown> | undefined,
  exec: ExecFn,
): Promise<void> {
  if (command !== "add_drum_pattern") return;
  const patternArg = args?.pattern;
  if (typeof patternArg !== "string") return;

  const pools = getMemoryPoolsIfHydrated();
  const match = pools?.patterns?.find((rec) =>
    rec.ts > 0 && isDrumPatternCard(rec.item) && rec.item.pattern.trim() === patternArg.trim());
  if (!match || !isDrumPatternCard(match.item)) return;

  try {
    const del = await exec("agent_memory_delete", { scope: "global", kind: "drum_pattern", ts: match.ts });
    if (!del.ok) return;
    const bumped = { ...match.item, uses: match.item.uses + 1 };
    const write = await exec("agent_memory_write", { scope: "global", kind: "drum_pattern", item: bumped, explicit: match.explicit });
    if (write.ok) invalidateMemoryHydration();
  } catch {
    // best-effort — see the file header
  }
}
