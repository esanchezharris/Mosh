// M2 — hydrate.ts against the REAL agent_memory_read/write mock contract (M1's
// bridge.mock.ts), proving the four-pool fetch + merge + cache/invalidate cycle
// end-to-end through the same executeCommand seam the native app uses.

import { describe, it, expect, beforeEach } from "vitest";
import { __resetMockForTests, mockExecute } from "../../bridge.mock";
import {
  ensureMemoryHydrated,
  memoryHydrated,
  getMemoryPoolsIfHydrated,
  invalidateMemoryHydration,
  poolsNonEmpty,
  __resetMemoryHydrationForTests,
} from "./hydrate";
import { DRUM_PATTERN_SEEDS } from "./drumSeeds";
import type { CommandResult } from "../../types";

async function write(args: Record<string, unknown>) {
  return mockExecute<CommandResult>({ command: "agent_memory_write", args });
}

beforeEach(() => {
  __resetMockForTests();
  __resetMemoryHydrationForTests();
});

describe("ensureMemoryHydrated", () => {
  it("starts unhydrated", () => {
    expect(memoryHydrated()).toBe(false);
    expect(getMemoryPoolsIfHydrated()).toBeNull();
  });

  it("fetches and merges all four sources: preference, both pattern kinds, and project notes", async () => {
    await write({ scope: "global", kind: "preference", item: "likes wide low end" });
    await write({ scope: "global", kind: "drum_pattern", item: "four on the floor" });
    await write({ scope: "global", kind: "lyric_framework", item: "AABA structure" });
    await write({ scope: "project", item: "chorus needs more energy" });

    const pools = await ensureMemoryHydrated();
    expect(pools.preferences?.map((r) => r.item)).toEqual(["likes wide low end"]);
    // patterns MERGES drum_pattern + lyric_framework into one array.
    expect(pools.patterns?.map((r) => r.item).sort()).toEqual(["AABA structure", "four on the floor"].sort());
    expect(pools.projectNotes?.map((r) => r.item)).toEqual(["chorus needs more energy"]);
  });

  // M4 — an empty drum_pattern store hydrates to the built-in seed cards, not [], so
  // retrieval has something to offer on day one (see hydrate.ts's SEED_DRUM_PATTERN_
  // RECORDS). preferences/projectNotes have no such fallback (there is no tasteful
  // universal seed for "your taste" or "this project") and stay empty.
  it("an empty store everywhere hydrates preferences/projectNotes to empty, but patterns to the built-in drum seeds", async () => {
    const pools = await ensureMemoryHydrated();
    expect(pools.preferences).toEqual([]);
    expect(pools.projectNotes).toEqual([]);
    expect(pools.patterns?.length).toBe(DRUM_PATTERN_SEEDS.length);
    expect(pools.patterns?.every((r) => r.kind === "drum_pattern" && r.explicit === false)).toBe(true);
    expect(pools.patterns?.map((r) => (r.item as { name: string }).name)).toEqual(
      DRUM_PATTERN_SEEDS.map((s) => s.name),
    );
    expect(memoryHydrated()).toBe(true); // hydration itself succeeded, it just found nothing real
  });

  it("a real saved drum_pattern suppresses the seeds entirely (real saves always win)", async () => {
    await write({ scope: "global", kind: "drum_pattern", item: { name: "my beat", pattern: "kick: x...", stepsPerBar: 4, bars: 1, tags: [], source: "saved", uses: 0 } });
    const pools = await ensureMemoryHydrated();
    expect(pools.patterns?.length).toBe(1);
    expect((pools.patterns![0].item as { name: string }).name).toBe("my beat");
  });

  it("seeds are NEVER written to disk — a fresh read after hydration still shows an empty real store", async () => {
    await ensureMemoryHydrated(); // hydrates patterns to the 6 in-memory seed cards
    const check = await mockExecute<CommandResult<{ items: unknown[] }>>({ command: "agent_memory_read", args: { scope: "global", kind: "drum_pattern" } });
    expect(check.data?.items).toEqual([]); // still empty on disk
  });

  it("caches: a second call does not re-issue agent_memory_read", async () => {
    await write({ scope: "global", kind: "preference", item: "one" });
    const first = await ensureMemoryHydrated();

    await write({ scope: "global", kind: "preference", item: "two" }); // written AFTER hydration
    const second = await ensureMemoryHydrated();

    // The cached result is reused verbatim -- "two" is NOT reflected without an
    // explicit invalidateMemoryHydration() (proves memoization, not staleness-by-luck).
    expect(second).toBe(first); // same object reference == served from cache, not refetched
    expect(second.preferences?.map((r) => r.item)).toEqual(["one"]);
  });

  it("concurrent callers before the first resolution share ONE in-flight fetch", async () => {
    await write({ scope: "global", kind: "preference", item: "shared" });
    const [a, b] = await Promise.all([ensureMemoryHydrated(), ensureMemoryHydrated()]);
    expect(a).toBe(b);
  });

  it("invalidateMemoryHydration drops the cache so the NEXT call re-fetches fresh", async () => {
    await write({ scope: "global", kind: "preference", item: "before" });
    const before = await ensureMemoryHydrated();
    expect(before.preferences?.map((r) => r.item)).toEqual(["before"]);

    invalidateMemoryHydration();
    expect(memoryHydrated()).toBe(false);

    await write({ scope: "global", kind: "preference", item: "after" });
    const after = await ensureMemoryHydrated();
    // agent_memory_read is newest-first (the M1 contract), so "after" sorts first.
    expect(after.preferences?.map((r) => r.item)).toEqual(["after", "before"]);
  });
});

describe("poolsNonEmpty", () => {
  it("false for three empty arrays", () => {
    expect(poolsNonEmpty({ preferences: [], patterns: [], projectNotes: [] })).toBe(false);
  });

  it("false when the fields are entirely omitted", () => {
    expect(poolsNonEmpty({})).toBe(false);
  });

  it("true when any single pool has content", () => {
    expect(poolsNonEmpty({ preferences: [{ ts: 1, kind: "preference", explicit: false, item: "x" }] })).toBe(true);
    expect(poolsNonEmpty({ patterns: [{ ts: 1, kind: "drum_pattern", explicit: false, item: "x" }] })).toBe(true);
    expect(poolsNonEmpty({ projectNotes: [{ ts: 1, kind: "note", explicit: false, item: "x" }] })).toBe(true);
  });
});
