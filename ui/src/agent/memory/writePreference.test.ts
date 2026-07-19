import { describe, it, expect, beforeEach } from "vitest";
import { __resetMockForTests, mockExecute } from "../../bridge.mock";
import { writePreference } from "./writePreference";
import { ensureMemoryHydrated, __resetMemoryHydrationForTests } from "./hydrate";
import type { CommandResult } from "../../types";

const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });

beforeEach(() => {
  __resetMockForTests();
  __resetMemoryHydrationForTests();
});

describe("writePreference", () => {
  it("writes global scope and returns the written item's ts", async () => {
    const r = await writePreference(exec, "likes wide low end", "global", true);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const read = await exec("agent_memory_read", { scope: "global", kind: "preference" });
      const items = (read.data as { items: { ts: number; item: unknown; explicit: boolean }[] }).items;
      expect(items[0].ts).toBe(r.ts);
      expect(items[0].item).toBe("likes wide low end");
      expect(items[0].explicit).toBe(true);
    }
  });

  it("writes project scope with explicit:false (the remember_preference posture)", async () => {
    const r = await writePreference(exec, "the hook needs punch", "project", false);
    expect(r.ok).toBe(true);
    const read = await exec("agent_memory_read", { scope: "project" });
    const items = (read.data as { items: { ts: number; item: unknown; explicit: boolean; kind: string }[] }).items;
    expect(items[0].item).toBe("the hook needs punch");
    expect(items[0].explicit).toBe(false);
    expect(items[0].kind).toBe("preference");
  });

  it("trims whitespace and rejects an empty/whitespace-only remembered text", async () => {
    const r1 = await writePreference(exec, "   ", "global", true);
    expect(r1.ok).toBe(false);
    const r2 = await writePreference(exec, "  padded text  ", "global", true);
    expect(r2.ok).toBe(true);
    const read = await exec("agent_memory_read", { scope: "global", kind: "preference" });
    expect((read.data as { items: { item: unknown }[] }).items[0].item).toBe("padded text");
  });

  it("propagates a write failure (e.g. an all-explicit store at cap) without throwing", async () => {
    for (let i = 0; i < 500; i++) {
      await exec("agent_memory_write", { scope: "global", kind: "preference", explicit: true, item: `x${i}` });
    }
    const r = await writePreference(exec, "one more, non-explicit", "global", false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/explicit/i);
  });

  it("invalidates the memory hydration cache so the next retrieval sees the write", async () => {
    // Hydrate once (empty pools), THEN write, THEN hydrate again — must NOT be served
    // from the stale cache.
    const before = await ensureMemoryHydrated();
    expect(before.preferences).toEqual([]);

    await writePreference(exec, "fresh preference", "global", true);

    const after = await ensureMemoryHydrated();
    expect(after).not.toBe(before); // cache was actually invalidated (new object)
    expect(after.preferences?.map((r) => r.item)).toEqual(["fresh preference"]);
  });
});
