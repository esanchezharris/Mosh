// AGT-MEM (Phase-B memory lane, M1) — the agent-memory store, mocked.
//
// Mirrors the native contract (src/moshops/AgentMemoryStore.h +
// MoshOps::cmdAgentMemoryRead/cmdAgentMemoryWrite): two scopes (global/project),
// three closed global kinds, a 500-item cap per store with the explicit-protection
// eviction policy, newest-first reads, and reads that never touch the command log.

import { describe, it, expect, beforeEach } from "vitest";
import { __resetMockForTests, mockExecute } from "./bridge.mock";
import type { CommandResult } from "./types";

type WriteData = { count: number };
type ReadData = { items: { ts: number; kind: string; explicit: boolean; item: unknown }[] };
type LogData = { entries: { command: string; ok: boolean; undoable: boolean }[]; total: number };

async function write(args: Record<string, unknown>): Promise<CommandResult<WriteData>> {
  return mockExecute<CommandResult<WriteData>>({ command: "agent_memory_write", args });
}
async function read(args: Record<string, unknown>): Promise<CommandResult<ReadData>> {
  return mockExecute<CommandResult<ReadData>>({ command: "agent_memory_read", args });
}
async function log(): Promise<CommandResult<LogData>> {
  return mockExecute<CommandResult<LogData>>({ command: "get_command_log", args: { limit: 1000 } });
}

describe("bridge.mock agent_memory_write/agent_memory_read — validation", () => {
  beforeEach(() => __resetMockForTests());

  it("rejects a missing or invalid scope", async () => {
    expect((await write({ kind: "preference", item: "x" })).ok).toBe(false);
    expect((await write({ scope: "nonsense", kind: "preference", item: "x" })).ok).toBe(false);
    expect((await read({})).ok).toBe(false);
    expect((await read({ scope: "nonsense" })).ok).toBe(false);
  });

  it("global scope requires a valid kind (preference | drum_pattern | lyric_framework)", async () => {
    expect((await write({ scope: "global", item: "x" })).ok).toBe(false);
    expect((await write({ scope: "global", kind: "nonsense", item: "x" })).ok).toBe(false);
    for (const kind of ["preference", "drum_pattern", "lyric_framework"]) {
      expect((await write({ scope: "global", kind, item: "ok" })).ok).toBe(true);
    }
    expect((await read({ scope: "global", kind: "nonsense" })).ok).toBe(false);
  });

  it("rejects a missing item, an empty string, and an array item", async () => {
    expect((await write({ scope: "global", kind: "preference" })).ok).toBe(false);
    expect((await write({ scope: "global", kind: "preference", item: "" })).ok).toBe(false);
    expect((await write({ scope: "global", kind: "preference", item: "   " })).ok).toBe(false);
    expect((await write({ scope: "global", kind: "preference", item: [1, 2, 3] })).ok).toBe(false);
  });

  it("accepts a string item and an object item verbatim", async () => {
    const s = await write({ scope: "global", kind: "preference", item: "loves wide drums" });
    expect(s.ok).toBe(true);
    const o = await write({ scope: "global", kind: "preference", item: { note: "140bpm" } });
    expect(o.ok).toBe(true);

    const r = await read({ scope: "global", kind: "preference" });
    expect(r.data?.items.map((i) => i.item)).toContainEqual("loves wide drums");
    expect(r.data?.items.map((i) => i.item)).toContainEqual({ note: "140bpm" });
  });
});

describe("bridge.mock agent_memory_write/agent_memory_read — global scope", () => {
  beforeEach(() => __resetMockForTests());

  it("write -> read round-trips, newest-first", async () => {
    await write({ scope: "global", kind: "preference", item: "first" });
    const w2 = await write({ scope: "global", kind: "preference", item: "second" });
    expect(w2.data?.count).toBe(2);

    const r = await read({ scope: "global", kind: "preference" });
    expect(r.ok).toBe(true);
    expect(r.data?.items).toHaveLength(2);
    expect(r.data?.items[0].item).toBe("second");   // newest first
    expect(r.data?.items[1].item).toBe("first");
  });

  it("kind filters isolate the three global stores from each other", async () => {
    await write({ scope: "global", kind: "preference", item: "pref" });
    await write({ scope: "global", kind: "drum_pattern", item: "drum" });
    await write({ scope: "global", kind: "lyric_framework", item: "lyric" });

    expect((await read({ scope: "global", kind: "preference" })).data?.items).toHaveLength(1);
    expect((await read({ scope: "global", kind: "drum_pattern" })).data?.items).toHaveLength(1);
    expect((await read({ scope: "global", kind: "lyric_framework" })).data?.items).toHaveLength(1);
  });

  it("an unfiltered global read merges all three kinds", async () => {
    await write({ scope: "global", kind: "preference", item: "pref" });
    await write({ scope: "global", kind: "drum_pattern", item: "drum" });

    const r = await read({ scope: "global" });
    expect(r.data?.items).toHaveLength(2);
  });

  it("limit caps the returned count", async () => {
    for (let i = 0; i < 5; i++) await write({ scope: "global", kind: "preference", item: `item-${i}` });
    const r = await read({ scope: "global", kind: "preference", limit: 2 });
    expect(r.data?.items).toHaveLength(2);
    expect(r.data?.items[0].item).toBe("item-4");   // newest
    expect(r.data?.items[1].item).toBe("item-3");
  });

  it("the explicit flag round-trips and defaults to false", async () => {
    await write({ scope: "global", kind: "preference", item: "derived" });
    await write({ scope: "global", kind: "preference", item: "explicit-one", explicit: true });
    const r = await read({ scope: "global", kind: "preference" });
    const derived = r.data?.items.find((i) => i.item === "derived");
    const marked = r.data?.items.find((i) => i.item === "explicit-one");
    expect(derived?.explicit).toBe(false);
    expect(marked?.explicit).toBe(true);
  });
});

describe("bridge.mock agent_memory_write — cap + eviction policy", () => {
  beforeEach(() => __resetMockForTests());

  it("a non-explicit write at cap evicts the OLDEST non-explicit item, skipping explicit ones", async () => {
    // Seed: explicit-0 (must survive), then 499 more derived items (total 500 = cap).
    await write({ scope: "global", kind: "preference", item: "explicit-0", explicit: true });
    for (let i = 1; i < 500; i++) await write({ scope: "global", kind: "preference", item: `derived-${i}` });

    const before = await read({ scope: "global", kind: "preference", limit: 1000 });
    expect(before.data?.items).toHaveLength(500);

    const atCap = await write({ scope: "global", kind: "preference", item: "derived-500" });
    expect(atCap.ok).toBe(true);
    expect(atCap.data?.count).toBe(500);   // still at cap — one evicted, one appended

    const after = await read({ scope: "global", kind: "preference", limit: 1000 });
    const items = after.data?.items.map((i) => i.item) ?? [];
    expect(items).toHaveLength(500);
    expect(items).toContain("explicit-0");         // explicit item survived
    expect(items).not.toContain("derived-1");       // the OLDEST derived item was evicted
    expect(items).toContain("derived-499");
    expect(items).toContain("derived-500");         // the new item landed
  });

  it("an all-explicit store REJECTS a non-explicit write, with a self-describing error", async () => {
    for (let i = 0; i < 500; i++) await write({ scope: "global", kind: "drum_pattern", item: `explicit-${i}`, explicit: true });

    const rejected = await write({ scope: "global", kind: "drum_pattern", item: "should be rejected" });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toMatch(/explicit/i);

    const after = await read({ scope: "global", kind: "drum_pattern", limit: 1000 });
    expect(after.data?.items).toHaveLength(500);
    expect(after.data?.items.map((i) => i.item)).not.toContain("should be rejected");
  });

  it("an all-explicit store ACCEPTS another explicit write, evicting the OLDEST explicit item", async () => {
    for (let i = 0; i < 500; i++) await write({ scope: "global", kind: "drum_pattern", item: `explicit-${i}`, explicit: true });

    const accepted = await write({ scope: "global", kind: "drum_pattern", item: "explicit-500", explicit: true });
    expect(accepted.ok).toBe(true);
    expect(accepted.data?.count).toBe(500);

    const items = (await read({ scope: "global", kind: "drum_pattern", limit: 1000 })).data?.items.map((i) => i.item) ?? [];
    expect(items).not.toContain("explicit-0");   // the oldest explicit item was the only valid victim
    expect(items).toContain("explicit-499");
    expect(items).toContain("explicit-500");
  });
});

describe("bridge.mock agent_memory_write/agent_memory_read — project scope", () => {
  beforeEach(() => __resetMockForTests());

  it("kind defaults to \"note\" when omitted, and a custom kind round-trips", async () => {
    const w1 = await write({ scope: "project", item: "verse 2 needs a bigger lift" });
    expect(w1.ok).toBe(true);
    const w2 = await write({ scope: "project", kind: "mood", item: { mood: "triumphant" }, explicit: true });
    expect(w2.ok).toBe(true);
    expect(w2.data?.count).toBe(2);

    const r = await read({ scope: "project" });
    expect(r.data?.items).toHaveLength(2);
    expect(r.data?.items[0].kind).toBe("mood");    // newest first
    expect(r.data?.items[1].kind).toBe("note");
  });

  it("project scope shares the same 500-item cap + eviction policy as global", async () => {
    for (let i = 0; i < 500; i++) await write({ scope: "project", item: `note-${i}` });
    const atCap = await write({ scope: "project", item: "note-500" });
    expect(atCap.ok).toBe(true);
    expect(atCap.data?.count).toBe(500);
    const items = (await read({ scope: "project", limit: 1000 })).data?.items.map((i) => i.item) ?? [];
    expect(items).not.toContain("note-0");
    expect(items).toContain("note-500");
  });

  it("rejects a missing item at project scope too", async () => {
    expect((await write({ scope: "project" })).ok).toBe(false);
  });
});

describe("bridge.mock agent_memory_write/agent_memory_read — logging posture", () => {
  beforeEach(() => __resetMockForTests());

  it("a write is logged as undoable:false; a read is never logged", async () => {
    await write({ scope: "global", kind: "preference", item: "logged?" });
    await read({ scope: "global", kind: "preference" });
    await read({ scope: "project" });

    const l = await log();
    const writeEntries = l.data?.entries.filter((e) => e.command === "agent_memory_write") ?? [];
    const readEntries = l.data?.entries.filter((e) => e.command === "agent_memory_read") ?? [];
    expect(writeEntries).toHaveLength(1);
    expect(writeEntries[0].undoable).toBe(false);
    expect(readEntries).toHaveLength(0);
  });

  it("undo does not touch the agent-memory store (it is not on the undo stack)", async () => {
    await mockExecute({ command: "create_track", args: { name: "UndoProbe" } });
    await write({ scope: "global", kind: "preference", item: "survives undo" });
    const u = await mockExecute<CommandResult>({ command: "undo", args: {} });
    expect(u.ok).toBe(true);

    const r = await read({ scope: "global", kind: "preference" });
    expect(r.data?.items.map((i) => i.item)).toContain("survives undo");
  });
});
