// M3 — agent_memory_delete/agent_memory_clear, mocked. Mirrors the native contract
// (MoshOps::cmdAgentMemoryDelete/cmdAgentMemoryClear, src/moshops/MoshOps.cpp):
// global scope's `kind` selects WHICH FILE (delete searches all three when omitted;
// clear wipes all three when omitted); project scope's `kind` is an item-level filter
// (delete: an extra safety check against the found item's own kind; clear: removes
// only that kind, or everything when omitted).

import { describe, it, expect, beforeEach } from "vitest";
import { __resetMockForTests, mockExecute } from "./bridge.mock";
import type { CommandResult } from "./types";

type WriteData = { count: number };
type ReadData = { items: { ts: number; kind: string; explicit: boolean; item: unknown }[] };
type DeleteData = { count: number };
type ClearData = { cleared: number };

async function write(args: Record<string, unknown>) {
  return mockExecute<CommandResult<WriteData>>({ command: "agent_memory_write", args });
}
async function read(args: Record<string, unknown>) {
  return mockExecute<CommandResult<ReadData>>({ command: "agent_memory_read", args });
}
async function del(args: Record<string, unknown>) {
  return mockExecute<CommandResult<DeleteData>>({ command: "agent_memory_delete", args });
}
async function clear(args: Record<string, unknown>) {
  return mockExecute<CommandResult<ClearData>>({ command: "agent_memory_clear", args });
}
async function tsOf(args: Record<string, unknown>): Promise<number> {
  const r = await read({ ...args, limit: 1 });
  return r.data!.items[0]!.ts;
}

beforeEach(() => __resetMockForTests());

describe("agent_memory_delete — validation", () => {
  it("rejects a missing/invalid scope", async () => {
    expect((await del({ kind: "preference", ts: 1 })).ok).toBe(false);
    expect((await del({ scope: "nonsense", ts: 1 })).ok).toBe(false);
  });
  it("rejects a missing ts", async () => {
    expect((await del({ scope: "global", kind: "preference" })).ok).toBe(false);
  });
  it("global scope rejects an invalid kind", async () => {
    expect((await del({ scope: "global", kind: "nonsense", ts: 1 })).ok).toBe(false);
  });
});

describe("agent_memory_delete — global scope", () => {
  it("deletes the exact item by ts when kind is given", async () => {
    await write({ scope: "global", kind: "preference", item: "a" });
    await write({ scope: "global", kind: "preference", item: "b" });
    const ts = await tsOf({ scope: "global", kind: "preference" }); // ts of "b" (newest)

    const r = await del({ scope: "global", kind: "preference", ts });
    expect(r.ok).toBe(true);
    expect(r.data?.count).toBe(1);

    const items = (await read({ scope: "global", kind: "preference" })).data?.items.map((i) => i.item);
    expect(items).toEqual(["a"]);
  });

  it("with NO kind, searches all three global stores and finds the right one", async () => {
    await write({ scope: "global", kind: "drum_pattern", item: "pattern-x" });
    const ts = await tsOf({ scope: "global", kind: "drum_pattern" });

    const r = await del({ scope: "global", ts });
    expect(r.ok).toBe(true);
    expect((await read({ scope: "global", kind: "drum_pattern" })).data?.items).toEqual([]);
  });

  it("a missing ts fails with a self-describing error, mutating nothing", async () => {
    await write({ scope: "global", kind: "preference", item: "a" });
    const r = await del({ scope: "global", kind: "preference", ts: 999999 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no item/i);
    expect((await read({ scope: "global", kind: "preference" })).data?.items.map((i) => i.item)).toEqual(["a"]);
  });

  it("deleting the same ts twice fails the second time", async () => {
    await write({ scope: "global", kind: "preference", item: "a" });
    const ts = await tsOf({ scope: "global", kind: "preference" });
    expect((await del({ scope: "global", kind: "preference", ts })).ok).toBe(true);
    expect((await del({ scope: "global", kind: "preference", ts })).ok).toBe(false);
  });
});

describe("agent_memory_delete — project scope", () => {
  it("deletes by ts with no kind filter", async () => {
    await write({ scope: "project", item: "note-a" });
    const ts = await tsOf({ scope: "project" });
    expect((await del({ scope: "project", ts })).ok).toBe(true);
    expect((await read({ scope: "project" })).data?.items).toEqual([]);
  });

  it("a kind filter that doesn't match the found item's own kind refuses", async () => {
    await write({ scope: "project", kind: "mood", item: "triumphant" });
    const ts = await tsOf({ scope: "project" });
    expect((await del({ scope: "project", kind: "note", ts })).ok).toBe(false);
    expect((await del({ scope: "project", kind: "mood", ts })).ok).toBe(true);
  });
});

describe("agent_memory_clear — global scope", () => {
  it("a kind given wipes ONLY that store", async () => {
    await write({ scope: "global", kind: "preference", item: "a" });
    await write({ scope: "global", kind: "lyric_framework", item: "b" });

    const r = await clear({ scope: "global", kind: "preference" });
    expect(r.ok).toBe(true);
    expect(r.data?.cleared).toBe(1);
    expect((await read({ scope: "global", kind: "preference" })).data?.items).toEqual([]);
    expect((await read({ scope: "global", kind: "lyric_framework" })).data?.items.map((i) => i.item)).toEqual(["b"]);
  });

  it("no kind wipes ALL three global stores", async () => {
    await write({ scope: "global", kind: "preference", item: "a" });
    await write({ scope: "global", kind: "drum_pattern", item: "b" });
    await write({ scope: "global", kind: "lyric_framework", item: "c" });

    const r = await clear({ scope: "global" });
    expect(r.ok).toBe(true);
    expect(r.data?.cleared).toBe(3);
    expect((await read({ scope: "global" })).data?.items).toEqual([]);
  });

  it("an invalid kind fails cleanly", async () => {
    expect((await clear({ scope: "global", kind: "nonsense" })).ok).toBe(false);
  });
});

describe("agent_memory_clear — project scope", () => {
  it("a kind given removes only notes with that kind, leaving others", async () => {
    await write({ scope: "project", item: "a note" });                        // kind: note
    await write({ scope: "project", kind: "mood", item: "triumphant" });
    await write({ scope: "project", kind: "mood", item: "somber" });

    const r = await clear({ scope: "project", kind: "mood" });
    expect(r.ok).toBe(true);
    expect(r.data?.cleared).toBe(2);
    const items = (await read({ scope: "project" })).data?.items;
    expect(items?.map((i) => i.kind)).toEqual(["note"]);
  });

  it("no kind clears the whole notes array", async () => {
    await write({ scope: "project", item: "a note" });
    await write({ scope: "project", kind: "mood", item: "triumphant" });

    const r = await clear({ scope: "project" });
    expect(r.ok).toBe(true);
    expect(r.data?.cleared).toBe(2);
    expect((await read({ scope: "project" })).data?.items).toEqual([]);
  });
});

describe("agent_memory_delete/clear — logging posture (mutations, so they ARE logged, undoable:false)", () => {
  it("both appear in the command log as undoable:false", async () => {
    await write({ scope: "global", kind: "preference", item: "a" });
    const ts = await tsOf({ scope: "global", kind: "preference" });
    await del({ scope: "global", kind: "preference", ts });
    await clear({ scope: "global" });

    const log = await mockExecute<CommandResult<{ entries: { command: string; undoable: boolean }[] }>>({
      command: "get_command_log", args: { limit: 1000 },
    });
    const deleteEntry = log.data?.entries.find((e) => e.command === "agent_memory_delete");
    const clearEntry = log.data?.entries.find((e) => e.command === "agent_memory_clear");
    expect(deleteEntry?.undoable).toBe(false);
    expect(clearEntry?.undoable).toBe(false);
  });

  it("undo does not restore a deleted or cleared item (not on the undo stack)", async () => {
    await write({ scope: "global", kind: "preference", item: "a" });
    const ts = await tsOf({ scope: "global", kind: "preference" });
    await del({ scope: "global", kind: "preference", ts });
    // undo's own result always reports ok:true (matches the native contract — cmdUndo
    // returns okResult with a `did` flag, never a top-level error, even as a no-op);
    // the real proof is that the deleted item stays gone.
    await mockExecute<CommandResult>({ command: "undo", args: {} });
    expect((await read({ scope: "global", kind: "preference" })).data?.items).toEqual([]);
  });
});
