// M2 (Phase-B memory lane) — the bridge-coupled half of the memory system: fetches
// the agent-memory pools via agent_memory_read (native + bridge.mock.ts both serve
// it, unchanged from M1) and caches them for retrieveContext.ts (pure) to score.
//
// Hydration is LAZY (nothing is fetched until the first call) and MEMOIZED per
// session (a resolved pool set is reused for every subsequent turn/step — this must
// never become a per-turn/per-step network round-trip, i.e. never a hot-path cost).
// invalidateMemoryHydration() drops the cache so the NEXT lazy call re-fetches; it
// does not eagerly re-fetch itself, so a write mid-task doesn't stall that task's own
// prompt build. (No caller invokes it yet — M1 never wired a write path into the
// running app; this is forward plumbing for a future write-capable surface, M3+.)
//
// Deliberately the ONLY file in agent/memory/ that imports the bridge — brainCore.ts,
// knowledge.ts, scoring.ts and retrieveContext.ts all stay bridge-free so the offline
// bench (ui/scripts/) can keep importing them directly.

import { executeCommand } from "../../bridge";
import type { CommandResult } from "../../types";
import type { MemoryPools, MemoryRecord } from "./retrieveContext";
import { DRUM_PATTERN_SEEDS } from "./drumSeeds";

type ReadArgs = { scope: "global" | "project"; kind?: string; limit?: number };
type ReadData = { items: MemoryRecord[] };

async function readMemory(args: ReadArgs): Promise<MemoryRecord[]> {
  try {
    const res = await executeCommand<CommandResult<ReadData>>({ command: "agent_memory_read", args });
    return res.ok && Array.isArray(res.data?.items) ? res.data.items : [];
  } catch {
    return [];   // hydration must never throw into a prompt-build call site
  }
}

// M4 (Phase-B memory lane) — day-one pattern retrieval, without ever writing anything
// uninvited. Wrapped as MemoryRecords (negative, synthetic `ts` so they never collide
// with a real wall-clock write, and sort stably/deterministically among themselves;
// `explicit: false` — nobody asked Moshi to remember these, they're just the built-in
// starting library) so they flow through rankMemoryEntries/renderMemorySection exactly
// like a real saved card. Computed once at module load (DRUM_PATTERN_SEEDS is a fixed
// const), not per-call.
const SEED_DRUM_PATTERN_RECORDS: readonly MemoryRecord[] = DRUM_PATTERN_SEEDS.map((card, i) => ({
  ts: -(i + 1),
  kind: "drum_pattern",
  explicit: false,
  item: card,
}));

let cache: MemoryPools | null = null;
let inflight: Promise<MemoryPools> | null = null;

/** Fetches + caches every pool agent_memory_read serves: preferences, the two
 *  pattern kinds (merged into one `patterns` array), and this project's notes. The
 *  first call per session pays the four-request round-trip; every call after that
 *  (same session, no intervening invalidateMemoryHydration()) resolves from cache
 *  with no I/O. */
export function ensureMemoryHydrated(): Promise<MemoryPools> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = (async (): Promise<MemoryPools> => {
    const [preferences, drumPatterns, lyricFrameworks, projectNotes] = await Promise.all([
      readMemory({ scope: "global", kind: "preference" }),
      readMemory({ scope: "global", kind: "drum_pattern" }),
      readMemory({ scope: "global", kind: "lyric_framework" }),
      readMemory({ scope: "project" }),
    ]);
    // Seeds fill in ONLY when the real global drum_pattern store is empty (never once
    // a producer has saved their own — real saves always win, seeds never mix in
    // alongside them). Never written to disk; this is purely an in-memory fallback at
    // read time (see the SEED_DRUM_PATTERN_RECORDS comment above).
    const drumPatternsOrSeed = drumPatterns.length > 0 ? drumPatterns : SEED_DRUM_PATTERN_RECORDS;
    const pools: MemoryPools = {
      preferences,
      patterns: [...drumPatternsOrSeed, ...lyricFrameworks],
      projectNotes,
    };
    cache = pools;
    inflight = null;
    return pools;
  })();
  return inflight;
}

/** True once a pool set is cached (a fast, sync check the hot path can use to skip
 *  `await`-ing hydration when it hasn't resolved yet — see the "never a hot path"
 *  posture: a caller may choose to skip memory for THIS turn rather than block on
 *  the first-ever fetch, falling back on the next turn once it resolves). */
export function memoryHydrated(): boolean {
  return cache !== null;
}

/** Sync accessor for an already-hydrated pool set, or null before the first
 *  resolution. Never triggers a fetch itself. */
export function getMemoryPoolsIfHydrated(): MemoryPools | null {
  return cache;
}

/** Drops the cache so the NEXT ensureMemoryHydrated() call re-fetches. Does NOT
 *  re-fetch eagerly (see the file header) — call this after a successful
 *  agent_memory_write. */
export function invalidateMemoryHydration(): void {
  cache = null;
  inflight = null;
}

/** True when at least one memory pool actually has content — the "pools are
 *  non-empty" gate the single-shot/loop call sites check before passing a `memory`
 *  section into the prompt (an empty result would just add an empty string anyway,
 *  but checking here avoids the retrieveContext() call entirely on the common
 *  nothing-written-yet path). */
export function poolsNonEmpty(pools: MemoryPools): boolean {
  return (pools.preferences?.length ?? 0) > 0
    || (pools.patterns?.length ?? 0) > 0
    || (pools.projectNotes?.length ?? 0) > 0;
}

/** Test-only: reset hydration state between tests (mirrors bridge.mock.ts's
 *  __resetMockForTests — call both together). */
export function __resetMemoryHydrationForTests(): void {
  cache = null;
  inflight = null;
}
