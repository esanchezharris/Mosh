import { afterEach, describe, expect, it, vi } from "vitest";
import { startLanePlayheadLoop, updateLanePlayheads, type LaneGeometry } from "./lanePlayhead";
import type { VisibleRange } from "./timelineGeometry";

const RANGE: VisibleRange = { startSec: 0, endSec: 16, spanSec: 16 };

describe("Open Lanes compositor playheads", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("updates expanded lanes only from cached widths", () => {
    const expandedHead = document.createElement("div");
    const compactHead = document.createElement("div");
    const geometries: LaneGeometry[] = [
      { head: expandedHead, contentLeftPx: 44, contentWidthPx: 240, expanded: true },
      { head: compactHead, contentLeftPx: 0, contentWidthPx: 120, expanded: false },
    ];

    updateLanePlayheads(geometries, 8, RANGE);

    expect(expandedHead.style.visibility).toBe("visible");
    expect(expandedHead.style.transform).toBe("translate3d(164.00px, 0, 0)");
    expect(compactHead.style.transform).toBe("");
  });

  it("hides an expanded playhead outside the visible range", () => {
    const head = document.createElement("div");
    updateLanePlayheads([{ head, contentLeftPx: 44, contentWidthPx: 240, expanded: true }], 20, RANGE);
    expect(head.style.visibility).toBe("hidden");
  });

  it("runs one animation loop and cancels its pending frame during cleanup", () => {
    const callbacks: FrameRequestCallback[] = [];
    const request = vi.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", request);
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const head = document.createElement("div");
    const geometry = new Map<string, LaneGeometry>([["drums", { head, contentLeftPx: 36, contentWidthPx: 160, expanded: true }]]);

    const stop = startLanePlayheadLoop(() => geometry.values(), () => 4, () => RANGE);
    expect(request).toHaveBeenCalledTimes(1);
    callbacks[0]?.(0);
    expect(head.style.transform).toBe("translate3d(76.00px, 0, 0)");
    expect(request).toHaveBeenCalledTimes(2);

    stop();
    expect(cancel).toHaveBeenCalledWith(2);
  });
});
