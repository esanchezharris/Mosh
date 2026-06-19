import { describe, it, expect } from "vitest";
import { classifyClipRegion } from "./region";

// Pure geometry: given a pointer position inside a clip's box plus the feel-driven
// edge-grab width and header height, decide which clip sub-region was hit. Corners
// resolve to edge (trim wins over header), matching DAW muscle memory.

const box = { width: 200, height: 76 };

describe("classifyClipRegion", () => {
  it("classifies the left/right edge bands", () => {
    expect(classifyClipRegion({ x: 3, y: 40, ...box, edgeGrabPx: 7, headerPx: 18 })).toBe("clip.edge");
    expect(classifyClipRegion({ x: 197, y: 40, ...box, edgeGrabPx: 7, headerPx: 18 })).toBe("clip.edge");
  });

  it("classifies the top strip as the header", () => {
    expect(classifyClipRegion({ x: 100, y: 8, ...box, edgeGrabPx: 7, headerPx: 18 })).toBe("clip.header");
  });

  it("classifies the interior as the body", () => {
    expect(classifyClipRegion({ x: 100, y: 50, ...box, edgeGrabPx: 7, headerPx: 18 })).toBe("clip.body");
  });

  it("edge wins over header in the corners", () => {
    expect(classifyClipRegion({ x: 2, y: 4, ...box, edgeGrabPx: 7, headerPx: 18 })).toBe("clip.edge");
  });

  it("respects a wider edge-grab zone (feel slider)", () => {
    // x=14 is body at 7px grab, but edge at a 20px grab
    expect(classifyClipRegion({ x: 14, y: 50, ...box, edgeGrabPx: 7, headerPx: 18 })).toBe("clip.body");
    expect(classifyClipRegion({ x: 14, y: 50, ...box, edgeGrabPx: 20, headerPx: 18 })).toBe("clip.edge");
  });

  it("never reports both edges on a clip narrower than 2×edgeGrab (left wins)", () => {
    // a 10px clip with 7px grab: x=6 is within both bands — deterministic left edge
    expect(classifyClipRegion({ x: 6, y: 8, width: 10, height: 76, edgeGrabPx: 7, headerPx: 18 })).toBe("clip.edge");
  });

  it("collapses the header into body when headerPx is 0", () => {
    expect(classifyClipRegion({ x: 100, y: 2, ...box, edgeGrabPx: 7, headerPx: 0 })).toBe("clip.body");
  });
});
