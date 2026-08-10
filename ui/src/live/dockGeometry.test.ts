// Unit pins for the dock splitter's clamp (dockGeometry.ts).

import { describe, it, expect } from "vitest";
import { clampDockHeight, dockDragDismisses, DOCK_MIN, DOCK_MAX_FRAC, DOCK_DISMISS_PX } from "./dockGeometry";

describe("clampDockHeight", () => {
  it("passes a sane height through (rounded)", () => {
    expect(clampDockHeight(265, 900)).toBe(265);
    expect(clampDockHeight(265.6, 900)).toBe(266);
  });

  it("clamps at the minimum readable height", () => {
    expect(clampDockHeight(40, 900)).toBe(DOCK_MIN);
    expect(clampDockHeight(DOCK_MIN - 1, 900)).toBe(DOCK_MIN);
  });

  it("clamps at 70% of the shell height — the arrangement keeps its share", () => {
    expect(clampDockHeight(900, 900)).toBe(Math.floor(900 * DOCK_MAX_FRAC));
    expect(clampDockHeight(500, 600)).toBe(420);
  });

  it("a tiny shell collapses the max onto the min (the min wins, never a contradiction)", () => {
    // 200 * 0.7 = 140 < 180 → max becomes the min.
    expect(clampDockHeight(1000, 200)).toBe(DOCK_MIN);
    expect(clampDockHeight(50, 200)).toBe(DOCK_MIN);
  });
});

describe("dockDragDismisses (Live's drag-to-close)", () => {
  it("a brush against the floor clamps; a deliberate pull past it dismisses", () => {
    expect(dockDragDismisses(DOCK_MIN - 10)).toBe(false);   // short drag → hold at min
    expect(dockDragDismisses(DOCK_MIN - DOCK_DISMISS_PX - 1)).toBe(true); // long pull → close
    expect(dockDragDismisses(DOCK_MIN + 40)).toBe(false);
  });
});
