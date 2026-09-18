import { describe, expect, it } from "vitest";
import { clipBeatCount, clipBox, laneContentPx, sessionBeatCount } from "./timeline";

describe("V3 timeline geometry", () => {
  it("maps seconds to pixels through pxPerSec, with a grab floor", () => {
    expect(clipBox({ start: 2, length: 6 }, 80)).toEqual({ left: 160, width: 480 });
    expect(clipBox({ start: 2, length: 6 }, 100)).toEqual({ left: 200, width: 600 });   // zoom in ×1.25 scales both
    expect(clipBox({ start: 0, length: 0.01 }, 80).width).toBe(6);
  });
  it("sizes the lane to the session or the viewport, whichever is wider", () => {
    expect(laneContentPx({ length: 32, tempo: 120 } as never, 80, 1100)).toBe(2560);
    expect(laneContentPx({ length: 4, tempo: 120 } as never, 80, 1100)).toBe(1100);
  });
  it("counts beats at the session tempo (anti-vacuity: tempo changes the count)", () => {
    expect(sessionBeatCount({ length: 32, tempo: 120 } as never)).toBe(64);
    expect(sessionBeatCount({ length: 32, tempo: 90 } as never)).toBe(48);
    expect(clipBeatCount(8, 120)).toBe(16);
    expect(clipBeatCount(8, 60)).toBe(8);
  });
});
