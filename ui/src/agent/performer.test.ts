import { describe, it, expect, vi } from "vitest";
import { handleFast, type FastDeps } from "./performer";

const deps = () => {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const d: FastDeps & { calls: typeof calls } = {
    calls,
    runBatch: vi.fn(async (_l: string, cs) => { calls.push(...cs); }),
    enterRecord: vi.fn(async (_bar?: number) => {}),
    stopRecord: vi.fn(async () => {}),
    keepTake: vi.fn(async () => {}),
    navTake: vi.fn(async (_d: number) => {}),
    utter: vi.fn((_i: string, _s?: string) => {}),
    remember: vi.fn(async (_text: string, _scope: "global" | "project") => {}),
  };
  return d;
};

describe("handleFast", () => {
  it("runs a commands action via the batch", async () => {
    const d = deps();
    await handleFast({ kind: "commands", commands: [{ command: "undo" }], intent: "ACK_GOT_IT" }, d);
    expect(d.runBatch).toHaveBeenCalledOnce();
    expect(d.calls[0]).toMatchObject({ command: "undo" });
  });
  it("routes record/keep/nav transitions to their handlers + always utters", async () => {
    const d = deps();
    await handleFast({ kind: "enterRecord", bar: 8, intent: "ACK_WORKING", say: "in" }, d);
    expect(d.enterRecord).toHaveBeenCalledWith(8);
    await handleFast({ kind: "stopRecord", intent: "ACK_GOT_IT" }, d);
    expect(d.stopRecord).toHaveBeenCalledOnce();
    await handleFast({ kind: "keepTake", intent: "DONE" }, d);
    expect(d.keepTake).toHaveBeenCalledOnce();
    await handleFast({ kind: "navTake", delta: -1, intent: "ACK_GOT_IT" }, d);
    expect(d.navTake).toHaveBeenCalledWith(-1);
    expect(d.utter).toHaveBeenCalledTimes(4);
  });

  it("routes a remember action to its own dep, not runBatch (agent_memory_write isn't a catalog command)", async () => {
    const d = deps();
    await handleFast({ kind: "remember", text: "likes wide low end", scope: "global", intent: "DONE", say: "got it" }, d);
    expect(d.remember).toHaveBeenCalledWith("likes wide low end", "global");
    expect(d.runBatch).not.toHaveBeenCalled();
    expect(d.utter).toHaveBeenCalledWith("DONE", "got it");
  });

  it("a remember action is a no-op (not a crash) when the caller doesn't supply the dep", async () => {
    const d = deps();
    delete (d as { remember?: unknown }).remember;
    await expect(
      handleFast({ kind: "remember", text: "x", scope: "global", intent: "DONE" }, d),
    ).resolves.toBeUndefined();
  });
});
