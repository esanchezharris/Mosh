import { describe, it, expect } from "vitest";
import { deriveTakeLanes } from "./takeLanes";
import type { Clip } from "../types";

// Minimal clip factory — only the fields deriveTakeLanes reads.
const clip = (over: Partial<Clip>): Clip => ({
  id: "c1", name: "vox", type: "wave", start: 0, length: 4, offset: 0,
  hasRenderLayer: false, ...over,
});

describe("deriveTakeLanes", () => {
  it("returns [] when the clip has no takes", () => {
    expect(deriveTakeLanes(clip({}))).toEqual([]);
  });

  it("returns [] for a single take (nothing to choose between)", () => {
    const c = clip({ numTakes: 1, currentTakeIndex: 0, takes: [{ index: 0, isCurrent: true }] });
    expect(deriveTakeLanes(c)).toEqual([]);
  });

  it("maps each take to a lane, labelled Take N (1-based)", () => {
    const c = clip({
      numTakes: 3, currentTakeIndex: 1,
      takes: [
        { index: 0, isCurrent: false },
        { index: 1, isCurrent: true },
        { index: 2, isCurrent: false },
      ],
    });
    expect(deriveTakeLanes(c)).toEqual([
      { index: 0, label: "Take 1", title: undefined, isCurrent: false },
      { index: 1, label: "Take 2", title: undefined, isCurrent: true },
      { index: 2, label: "Take 3", title: undefined, isCurrent: false },
    ]);
  });

  it("carries a non-empty description as the lane title (tooltip)", () => {
    const c = clip({
      numTakes: 2, currentTakeIndex: 0,
      takes: [
        { index: 0, description: "vox_take1.wav", isCurrent: true },
        { index: 1, description: "   ", isCurrent: false },
      ],
    });
    const lanes = deriveTakeLanes(c);
    expect(lanes[0].title).toBe("vox_take1.wav");
    expect(lanes[1].title).toBeUndefined(); // whitespace-only → no tooltip
  });

  it("falls back to currentTakeIndex when a take omits isCurrent", () => {
    const c = clip({
      numTakes: 2, currentTakeIndex: 1,
      takes: [{ index: 0 }, { index: 1 }],
    });
    const lanes = deriveTakeLanes(c);
    expect(lanes.map((l) => l.isCurrent)).toEqual([false, true]);
  });
});
