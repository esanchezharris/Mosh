import { describe, it, expect } from "vitest";
import { awaitRendersSettled } from "./jobWait";
import type { Snapshot } from "../../types";

// A scripted snapshot source: each getSnapshot() pops the next frame.
function snapSource(frames: Array<Record<string, string | undefined>>) {
  let i = 0;
  const calls = { count: 0 };
  return {
    calls,
    async getSnapshot() {
      calls.count++;
      const statuses = frames[Math.min(i++, frames.length - 1)]!;
      return {
        tracks: [{
          clips: Object.entries(statuses).map(([id, status]) => ({
            id, type: "wave", start: 0, length: 4, offset: 0,
            ...(status ? { renderLayer: { status } } : {}),
          })),
        }],
      } as unknown as Snapshot;
    },
  };
}

describe("awaitRendersSettled — env-agnostic render settling", () => {
  it("polls until the clip leaves queued/rendering", async () => {
    const src = snapSource([{ c1: "queued" }, { c1: "rendering" }, { c1: "ready" }]);
    const r = await awaitRendersSettled(src, ["c1"], { pollMs: 5 });
    expect(r.outcome).toBe("settled");
    expect(src.calls.count).toBe(3);
  });

  it("returns immediately when nothing is pending (the mock's instant render)", async () => {
    const src = snapSource([{ c1: "ready" }]);
    const r = await awaitRendersSettled(src, ["c1"], { pollMs: 5 });
    expect(r.outcome).toBe("settled");
    expect(src.calls.count).toBe(1);
  });

  it("a clip with NO layer counts as settled (accept_render can consume it)", async () => {
    const src = snapSource([{ c1: undefined }]);
    const r = await awaitRendersSettled(src, ["c1"], { pollMs: 5 });
    expect(r.outcome).toBe("settled");
  });

  it("abort cancels each still-pending clip and reports aborted", async () => {
    const src = snapSource([{ c1: "rendering" }]);
    const signal = { aborted: false };
    const cancelled: string[] = [];
    const p = awaitRendersSettled(src, ["c1"], {
      pollMs: 5, signal,
      onAbort: async (id) => { cancelled.push(id); },
    });
    signal.aborted = true;
    const r = await p;
    expect(r.outcome).toBe("aborted");
    expect(cancelled).toEqual(["c1"]);
  });

  it("times out honestly instead of hanging a task", async () => {
    const src = snapSource([{ c1: "rendering" }]);
    let t = 0;
    const r = await awaitRendersSettled(src, ["c1"], { pollMs: 1, timeoutMs: 10, now: () => (t += 6) });
    expect(r.outcome).toBe("timeout");
  });
});
