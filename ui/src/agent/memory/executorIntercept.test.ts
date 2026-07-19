// M3 — proves BOTH executors (executor.ts's runAgentBatch, single-shot; loop/
// taskExec.ts's createTaskExecutor, the loop) intercept remember_preference BEFORE
// validateCommand/dispatch, against the REAL mock backend end-to-end.

import { describe, it, expect, beforeEach } from "vitest";
import { runAgentBatch } from "../executor";
import { createTaskExecutor } from "../loop/taskExec";
import { useStore } from "../../store";
import { __resetMockForTests, mockExecute } from "../../bridge.mock";
import type { CommandResult } from "../../types";

async function readGlobalPreferences() {
  const r = await mockExecute<CommandResult<{ items: { item: unknown; explicit: boolean }[] }>>({
    command: "agent_memory_read",
    args: { scope: "global", kind: "preference" },
  });
  return r.data!.items;
}

describe("runAgentBatch — remember_preference interception (single-shot)", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("writes explicit:false and never reaches validateCommand (no 'not an allowed command' error)", async () => {
    const cs = await runAgentBatch("remember", [{ command: "remember_preference", args: { text: "leans on triplet hats" } }]);
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0].ok).toBe(true);
    expect(cs.entries[0].error).toBeUndefined();
    expect(cs.entries[0].summary).toContain("leans on triplet hats");

    const items = await readGlobalPreferences();
    expect(items).toHaveLength(1);
    expect(items[0].item).toBe("leans on triplet hats");
    expect(items[0].explicit).toBe(false);
  });

  it("does NOT open a batch_begin/batch_end transaction for a remember_preference-only turn", async () => {
    const seen: string[] = [];
    const orig = useStore.getState().exec;
    useStore.setState({
      exec: async (command: string, args?: Record<string, unknown>) => { seen.push(command); return orig(command, args); },
    });
    await runAgentBatch("remember", [{ command: "remember_preference", args: { text: "x" } }]);
    useStore.setState({ exec: orig });
    expect(seen).not.toContain("batch_begin");
    expect(seen).not.toContain("batch_end");
    // agent_memory_write/read happen OUTSIDE store.exec (writePreference takes its
    // own exec param, which IS store.exec here) — confirm they were the only calls.
    expect(seen).toEqual(["agent_memory_write", "agent_memory_read"]);
  });

  it("a mixed batch still wraps the REAL command in batch_begin/batch_end; remember_preference is reported alongside it", async () => {
    const cs = await runAgentBatch("mixed", [
      { command: "remember_preference", args: { text: "likes wide low end" } },
      { command: "create_track", args: { name: "Hats" } },
    ]);
    expect(cs.entries).toHaveLength(2);
    const rememberEntry = cs.entries.find((e) => e.command === "remember_preference")!;
    const createEntry = cs.entries.find((e) => e.command === "create_track")!;
    expect(rememberEntry.ok).toBe(true);
    expect(createEntry.ok).toBe(true);

    const items = await readGlobalPreferences();
    expect(items.map((i) => i.item)).toEqual(["likes wide low end"]);
    const snap = useStore.getState().snapshot!;
    expect(snap.tracks.some((t) => t.name === "Hats")).toBe(true);
  });

  it("a missing text fails with a self-describing error and writes nothing", async () => {
    const cs = await runAgentBatch("remember", [{ command: "remember_preference", args: {} }]);
    expect(cs.entries[0].ok).toBe(false);
    expect(cs.entries[0].error).toMatch(/text/i);
    expect(await readGlobalPreferences()).toEqual([]);
  });
});

describe("loop/taskExec.ts — remember_preference interception (the agentic loop)", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("intercepts remember_preference without opening the task's undo transaction", async () => {
    const seen: string[] = [];
    const orig = useStore.getState().exec;
    useStore.setState({
      exec: async (command: string, args?: Record<string, unknown>) => { seen.push(command); return orig(command, args); },
    });

    const { env, close, opened } = createTaskExecutor("remember-task");
    const result = await env.runBatch("step", [{ command: "remember_preference", args: { text: "always quantize to 16ths" } }]);
    await close();
    useStore.setState({ exec: orig });

    expect(result.results).toEqual([{ command: "remember_preference", ok: true, error: undefined }]);
    expect(opened()).toBe(false);   // read-only from the task-undo-transaction's point of view
    expect(seen).not.toContain("batch_begin");

    const items = await readGlobalPreferences();
    expect(items.map((i) => i.item)).toEqual(["always quantize to 16ths"]);
  });

  it("a step mixing remember_preference with a real mutating command still opens the task transaction for the real one", async () => {
    const { env, close, opened } = createTaskExecutor("mixed-task");
    const result = await env.runBatch("step", [
      { command: "remember_preference", args: { text: "the hook needs punch" } },
      { command: "create_track", args: { name: "Hats" } },
    ]);
    await close();

    expect(result.results.find((r) => r.command === "remember_preference")?.ok).toBe(true);
    expect(result.results.find((r) => r.command === "create_track")?.ok).toBe(true);
    expect(opened()).toBe(true);

    const items = await readGlobalPreferences();
    expect(items.map((i) => i.item)).toEqual(["the hook needs punch"]);
  });
});
