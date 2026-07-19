// Task-scoped batch lifecycle: ONE native undo transaction spans every step of
// an agent task. Driven against the REAL store+mock seam (the executor.test
// idiom) so batch bracketing, undo grouping and the destructive budget are
// proven on the same path the app ships.

import { describe, it, expect, beforeEach } from "vitest";
import { createTaskExecutor } from "./taskExec";
import { DESTRUCTIVE_BLOCK_REASON } from "../destructiveScreen";
import { useStore } from "../../store";
import { __resetMockForTests } from "../../bridge.mock";
import type { Snapshot } from "../../types";

function snap(): Snapshot {
  const s = useStore.getState().snapshot;
  if (!s) throw new Error("store has no snapshot");
  return s;
}

describe("createTaskExecutor — one undo unit per agent task", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("two steps coalesce into ONE undo step", async () => {
    const tracksBefore = snap().tracks.length;
    const t = createTaskExecutor("build a beat", { utterance: "build a beat" });

    const s1 = await t.env.runBatch("step 1", [{ command: "create_track", args: { name: "LoopTrack" } }]);
    expect(s1.results[0]!.ok).toBe(true);
    const newId = s1.snapshot.tracks.find((x) => x.name === "LoopTrack")!.id;
    const s2 = await t.env.runBatch("step 2", [{ command: "rename_track", args: { trackId: newId, name: "Renamed" } }]);
    expect(s2.results[0]!.ok).toBe(true);
    await t.close();

    expect(snap().tracks.some((x) => x.name === "Renamed")).toBe(true);
    const u = await useStore.getState().exec("undo");
    expect(u.ok).toBe(true);
    await useStore.getState().refresh();
    expect(snap().tracks.length).toBe(tracksBefore);          // create AND rename reverted
    expect(snap().tracks.some((x) => x.name === "Renamed")).toBe(false);
  });

  it("a purely read-only task never opens a batch", async () => {
    const t = createTaskExecutor("look around", {});
    const s = await t.env.runBatch("step 1", [{ command: "list_builtins", args: {} }]);
    expect(s.results[0]!.ok).toBe(true);
    expect(t.opened()).toBe(false);
    await t.close();
  });

  it("self-heals a zombie batch left open by a prior crash", async () => {
    const pre = await useStore.getState().exec("batch_begin", { name: "zombie" });
    expect(pre.ok).toBe(true); // the stale batch a JS crash would leave behind

    const t = createTaskExecutor("recover", {});
    const s = await t.env.runBatch("step 1", [{ command: "create_track", args: { name: "AfterHeal" } }]);
    expect(s.results[0]!.ok).toBe(true);
    expect(t.opened()).toBe(true);
    await t.close();
    expect(snap().tracks.some((x) => x.name === "AfterHeal")).toBe(true);
  });

  it("the destructive budget is TASK-cumulative, not per step", async () => {
    const t = createTaskExecutor("cleanup", {});
    const six = Array.from({ length: 6 }, (_, i) => ({ command: "remove_clip", args: { clipId: `x${i}` } }));
    const s1 = await t.env.runBatch("step 1", six);
    expect(s1.results).toHaveLength(6); // allowed (6 ≤ 10) — they fail on bogus ids, but they were permitted

    const five = Array.from({ length: 5 }, (_, i) => ({ command: "remove_clip", args: { clipId: `y${i}` } }));
    const s2 = await t.env.runBatch("step 2", [...five, { command: "create_track", args: { name: "Kept" } }]);
    const blocked = s2.results.filter((r) => r.error === DESTRUCTIVE_BLOCK_REASON);
    expect(blocked).toHaveLength(5);                        // 6 used + 5 > 10 ⇒ all five blocked
    expect(s2.results.find((r) => r.command === "create_track")!.ok).toBe(true);
    await t.close();
  });

  it("invalid commands fail validation without reaching the seam", async () => {
    const t = createTaskExecutor("mixed", {});
    const s = await t.env.runBatch("step 1", [
      { command: "create_track", args: { name: "Real" } },
      { command: "definitely_not_a_command", args: {} },
    ]);
    expect(s.results.find((r) => r.command === "create_track")!.ok).toBe(true);
    const bad = s.results.find((r) => r.command === "definitely_not_a_command")!;
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/not an allowed command/);
    await t.close();
  });

  it("close() is idempotent and the env refuses work after close", async () => {
    const t = createTaskExecutor("done", {});
    await t.env.runBatch("step 1", [{ command: "create_track", args: { name: "X" } }]);
    await t.close();
    await t.close(); // second close is a no-op, not an error
    await expect(t.env.runBatch("late", [{ command: "create_track", args: { name: "Y" } }])).rejects.toThrow(/closed/);
  });
});
