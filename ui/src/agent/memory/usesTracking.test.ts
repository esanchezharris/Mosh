// M4 (item 6) — bumpPatternUsesIfMatched against the REAL agent_memory_* mock
// contract (mirrors hydrate.test.ts's posture: prove the delete+rewrite round-trip
// actually works, not just that the right calls were shaped right).

import { describe, it, expect, beforeEach } from "vitest";
import { __resetMockForTests, mockExecute } from "../../bridge.mock";
import { ensureMemoryHydrated, __resetMemoryHydrationForTests, getMemoryPoolsIfHydrated } from "./hydrate";
import { bumpPatternUsesIfMatched, type ExecFn } from "./usesTracking";
import type { DrumPatternCard } from "./patternCards";
import type { CommandResult } from "../../types";

type StoredRecord = { ts: number; item: DrumPatternCard; explicit: boolean };
type ReadResult = CommandResult<{ items: StoredRecord[] }>;

const exec: ExecFn = (command, args) => mockExecute<CommandResult>({ command, args });
const readCards = async (): Promise<StoredRecord[]> => {
  const r = await mockExecute<ReadResult>({ command: "agent_memory_read", args: { scope: "global", kind: "drum_pattern" } });
  return r.data?.items ?? [];
};

const card = (over: Partial<DrumPatternCard> = {}): DrumPatternCard => ({
  name: "My beat", pattern: "kick: x...x...x...x...", stepsPerBar: 16, bars: 1,
  tags: [], source: "saved", uses: 0, ...over,
});

beforeEach(() => {
  __resetMockForTests();
  __resetMemoryHydrationForTests();
});

describe("bumpPatternUsesIfMatched", () => {
  it("bumps uses by 1 when add_drum_pattern's pattern arg exactly matches a saved card", async () => {
    await exec("agent_memory_write", { scope: "global", kind: "drum_pattern", item: card(), explicit: true });
    await ensureMemoryHydrated();

    await bumpPatternUsesIfMatched("add_drum_pattern", { pattern: "kick: x...x...x...x..." }, exec);

    const items = await readCards();
    expect(items).toHaveLength(1); // delete+rewrite, not a duplicate
    expect(items[0].item.uses).toBe(1);
    expect(items[0].item.name).toBe("My beat"); // everything else preserved
  });

  it("invalidates the memory hydration cache so the next retrieval sees the bump", async () => {
    await exec("agent_memory_write", { scope: "global", kind: "drum_pattern", item: card(), explicit: true });
    await ensureMemoryHydrated();
    const before = getMemoryPoolsIfHydrated();
    expect(before).not.toBeNull();

    await bumpPatternUsesIfMatched("add_drum_pattern", { pattern: "kick: x...x...x...x..." }, exec);

    expect(getMemoryPoolsIfHydrated()).toBeNull(); // cache dropped
    const after = await ensureMemoryHydrated();
    expect((after.patterns?.[0]?.item as DrumPatternCard).uses).toBe(1);
  });

  it("preserves the explicit flag across the delete+rewrite", async () => {
    await exec("agent_memory_write", { scope: "global", kind: "drum_pattern", item: card(), explicit: false });
    await ensureMemoryHydrated();

    await bumpPatternUsesIfMatched("add_drum_pattern", { pattern: "kick: x...x...x...x..." }, exec);

    const items = await readCards();
    expect(items[0].explicit).toBe(false);
  });

  it("does nothing for any command other than add_drum_pattern", async () => {
    await exec("agent_memory_write", { scope: "global", kind: "drum_pattern", item: card(), explicit: true });
    await ensureMemoryHydrated();

    await bumpPatternUsesIfMatched("create_track", { pattern: "kick: x...x...x...x..." }, exec);

    expect((await readCards())[0].item.uses).toBe(0);
  });

  it("does nothing when no stored card's pattern matches the arg", async () => {
    await exec("agent_memory_write", { scope: "global", kind: "drum_pattern", item: card(), explicit: true });
    await ensureMemoryHydrated();

    await bumpPatternUsesIfMatched("add_drum_pattern", { pattern: "snare: x...x...x...x..." }, exec);

    expect((await readCards())[0].item.uses).toBe(0);
  });

  it("never throws when the pools aren't hydrated yet (no prior ensureMemoryHydrated call)", async () => {
    await expect(bumpPatternUsesIfMatched("add_drum_pattern", { pattern: "kick: x..." }, exec)).resolves.toBeUndefined();
  });

  it("never throws and no-ops when the pattern arg is missing or not a string", async () => {
    await ensureMemoryHydrated();
    await expect(bumpPatternUsesIfMatched("add_drum_pattern", {}, exec)).resolves.toBeUndefined();
    await expect(bumpPatternUsesIfMatched("add_drum_pattern", { pattern: 42 }, exec)).resolves.toBeUndefined();
  });

  it("skips a matching SEED card (nothing on disk to bump) without throwing", async () => {
    // No real drum_pattern saved -> hydrate.ts's empty-store fallback injects the
    // built-in seeds (negative synthetic ts) into pools.patterns.
    await ensureMemoryHydrated();
    const pools = getMemoryPoolsIfHydrated();
    const seed = pools!.patterns!.find((r) => r.ts < 0)!;
    const seedCard = seed.item as DrumPatternCard;

    await expect(bumpPatternUsesIfMatched("add_drum_pattern", { pattern: seedCard.pattern }, exec)).resolves.toBeUndefined();

    // Nothing was written to disk as a side effect of "using" a seed.
    expect(await readCards()).toEqual([]);
  });

  it("a failed agent_memory_delete leaves the store untouched (no orphan duplicate)", async () => {
    await exec("agent_memory_write", { scope: "global", kind: "drum_pattern", item: card(), explicit: true });
    await ensureMemoryHydrated();
    const failingExec: ExecFn = async (command, args) =>
      command === "agent_memory_delete" ? { ok: false, error: "boom" } : exec(command, args);

    await bumpPatternUsesIfMatched("add_drum_pattern", { pattern: "kick: x...x...x...x..." }, failingExec);

    const items = await readCards();
    expect(items).toHaveLength(1);
    expect(items[0].item.uses).toBe(0); // untouched
  });
});
