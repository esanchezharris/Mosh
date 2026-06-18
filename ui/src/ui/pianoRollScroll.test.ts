import { describe, it, expect } from "vitest";
import { centerScrollTopForNotes } from "./pianoRollScroll";

// Piano-roll layout under test: pitches HIGH(96)..LOW(36) laid top-to-bottom,
// rowH=15 → scrollHeight = (96-36+1)*15 = 915. Viewport (clientHeight) = 300,
// so the scrollable range is [0, 615].
const GEOM = { high: 96, rowH: 15, clientHeight: 300, scrollHeight: 915 };

describe("centerScrollTopForNotes", () => {
  it("returns null for an empty clip (nothing to frame)", () => {
    expect(centerScrollTopForNotes([], GEOM)).toBeNull();
  });

  it("clamps to 0 when the notes sit at the very top (C7)", () => {
    // mean pitch 96 → rowTop 0 → target -142.5 → clamped to 0
    expect(centerScrollTopForNotes([{ pitch: 96 }], GEOM)).toBe(0);
  });

  it("clamps to the bottom of the range for a low bassline (E2/A2)", () => {
    // mean pitch 36 → rowTop 900 → target 757.5 → clamped to maxTop 615
    expect(centerScrollTopForNotes([{ pitch: 36 }], GEOM)).toBe(615);
  });

  it("centres the viewport on a mid-register note", () => {
    // pitch 66 → rowTop (96-66)*15=450 → target 450-150+7.5 = 307.5 (in range)
    expect(centerScrollTopForNotes([{ pitch: 66 }], GEOM)).toBe(307.5);
  });

  it("centres on the MEAN pitch across several notes", () => {
    // mean of 60 & 64 = 62 → rowTop (96-62)*15=510 → target 510-150+7.5 = 367.5
    expect(centerScrollTopForNotes([{ pitch: 60 }, { pitch: 64 }], GEOM)).toBe(367.5);
  });

  it("never returns a negative scrollTop or one past the range", () => {
    const top = centerScrollTopForNotes([{ pitch: 40 }, { pitch: 41 }], GEOM)!;
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThanOrEqual(GEOM.scrollHeight - GEOM.clientHeight);
  });
});
