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
});
