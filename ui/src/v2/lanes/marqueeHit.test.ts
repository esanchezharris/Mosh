import { describe, expect, it } from "vitest";
import { boundsOf, isDrag, marqueeHits, MARQUEE_MIN_DRAG_PX, type ClipBox, type LaneBox } from "./marqueeHit";

// Two lanes, three clips. Lane A holds a long clip and a short one; lane B holds one
// clip that starts where A's long clip ends, so a rectangle can straddle lanes and
// clip boundaries in every direction.
const LANES: LaneBox[] = [
  { trackId: "A", top: 0, bottom: 60 },
  { trackId: "B", top: 61, bottom: 121 },
];
const CLIPS: ClipBox[] = [
  { id: "a-long", trackId: "A", left: 0, right: 400 },
  { id: "a-short", trackId: "A", left: 600, right: 610 },
  { id: "b-one", trackId: "B", left: 400, right: 800 },
];

describe("marqueeHit", () => {
  it("selects by TOUCH, not enclosure — the 2-of-4 DAW behaviour", () => {
    // A rectangle covering only the middle of the long clip selects it. Enclosure
    // semantics would return [] here and make a long clip unselectable at high zoom.
    expect(marqueeHits({ x0: 100, y0: 10, x1: 200, y1: 50 }, LANES, CLIPS)).toEqual(["a-long"]);
  });

  it("is drag-direction independent", () => {
    const ltr = marqueeHits({ x0: 100, y0: 10, x1: 700, y1: 110 }, LANES, CLIPS);
    const rtl = marqueeHits({ x0: 700, y0: 110, x1: 100, y1: 10 }, LANES, CLIPS);
    expect(ltr).toEqual(rtl);
    expect(ltr.sort()).toEqual(["a-long", "a-short", "b-one"]);
  });

  it("respects lane bounds — a rectangle inside lane A never selects lane B's clip", () => {
    expect(marqueeHits({ x0: 0, y0: 0, x1: 800, y1: 55 }, LANES, CLIPS).sort())
      .toEqual(["a-long", "a-short"]);
  });

  it("a rectangle in the gap between lanes selects nothing", () => {
    // y 60..61 is the 1px border between lanes: touching neither lane's interior.
    expect(marqueeHits({ x0: 0, y0: 60.2, x1: 800, y1: 60.8 }, LANES, CLIPS)).toEqual([]);
  });

  it("an edge-grazing rectangle still counts as a touch", () => {
    // x exactly at a-long's right edge (400) and b-one's left edge (400).
    expect(marqueeHits({ x0: 400, y0: 0, x1: 400, y1: 121 }, LANES, CLIPS).sort())
      .toEqual(["a-long", "b-one"]);
  });

  it("returns [] for a rectangle past every clip", () => {
    expect(marqueeHits({ x0: 900, y0: 0, x1: 1000, y1: 121 }, LANES, CLIPS)).toEqual([]);
  });

  it("boundsOf normalizes any drag direction", () => {
    expect(boundsOf({ x0: 10, y0: 20, x1: 5, y1: 2 }))
      .toEqual({ xMin: 5, xMax: 10, yMin: 2, yMax: 20 });
  });

  it("isDrag separates a click from a lasso on both axes", () => {
    const at = MARQUEE_MIN_DRAG_PX;
    expect(isDrag({ x0: 0, y0: 0, x1: 0, y1: 0 })).toBe(false);
    expect(isDrag({ x0: 0, y0: 0, x1: at - 0.01, y1: at - 0.01 })).toBe(false);
    expect(isDrag({ x0: 0, y0: 0, x1: at, y1: 0 })).toBe(true);   // horizontal only
    expect(isDrag({ x0: 0, y0: 0, x1: 0, y1: at })).toBe(true);   // vertical only
    // Direction-independent: a leftward/upward drag is still a drag.
    expect(isDrag({ x0: 100, y0: 100, x1: 100 - at, y1: 100 })).toBe(true);
  });
});
