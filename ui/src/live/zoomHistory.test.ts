// Unit pins for the zoom-history stack (live/zoomHistory.ts): push/pop/coalesce/cap
// semantics — the DOM/module layer is exercised by the live-shell e2e pins.

import { describe, expect, it } from "vitest";
import { popZoom, pushZoom, ZOOM_COALESCE_MS, ZOOM_HISTORY_CAP, type ZoomView } from "./zoomHistory";

const v = (pxPerSec: number, scrollLeft = 0): ZoomView => ({ pxPerSec, scrollLeft });

describe("pushZoom", () => {
  it("pushes a new entry when quiet for more than the coalesce window", () => {
    const r = pushZoom([], v(80), 1000, null);
    expect(r.pushed).toBe(true);
    expect(r.stack).toEqual([v(80)]);
    const r2 = pushZoom(r.stack, v(100), 1000 + ZOOM_COALESCE_MS + 1, 1000);
    expect(r2.pushed).toBe(true);
    expect(r2.stack).toEqual([v(80), v(100)]);
  });

  it("coalesces a rapid burst into the burst-start entry", () => {
    let stack: ZoomView[] = [];
    let last: number | null = null;
    // burst: record at t=0 (pushes), t=100, t=200 (both inside the window)
    let r = pushZoom(stack, v(80), 0, last);
    stack = r.stack; last = 0;
    expect(r.pushed).toBe(true);
    r = pushZoom(stack, v(120), 100, last);
    stack = r.stack; last = 100;
    expect(r.pushed).toBe(false);
    expect(stack).toEqual([v(80)]);   // still ONE entry — the burst's start
    r = pushZoom(stack, v(160), 200, last);
    expect(r.pushed).toBe(false);
    expect(stack).toEqual([v(80)]);
  });

  it("caps at ZOOM_HISTORY_CAP, dropping the oldest", () => {
    let stack: ZoomView[] = [];
    let last: number | null = null;
    for (let i = 0; i < ZOOM_HISTORY_CAP + 5; ++i) {
      const r = pushZoom(stack, v(i), i * (ZOOM_COALESCE_MS + 1), last);
      stack = r.stack;
      last = i * (ZOOM_COALESCE_MS + 1);
    }
    expect(stack.length).toBe(ZOOM_HISTORY_CAP);
    expect(stack[stack.length - 1]).toEqual(v(ZOOM_HISTORY_CAP + 4));
    expect(stack[0]).toEqual(v(5));   // the five oldest fell off
  });
});

describe("popZoom", () => {
  it("pops the newest first; empty pops to null", () => {
    const stack = [v(80), v(120), v(160)];
    let r = popZoom(stack);
    expect(r.view).toEqual(v(160));
    r = popZoom(r.stack);
    expect(r.view).toEqual(v(120));
    r = popZoom(r.stack);
    expect(r.view).toEqual(v(80));
    r = popZoom(r.stack);
    expect(r.view).toBeNull();
    expect(r.stack).toEqual([]);
  });
});
