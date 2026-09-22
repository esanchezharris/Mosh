import { describe, expect, it } from "vitest";
import { LANE_LEFT_PX, beatLabelsVisible, clipBeatCount, clipBox, laneContentPx, playheadLeftPx, secondsAtLaneX, sectionBox, sectionStartSec, sessionBeatCount } from "./timeline";

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

describe("V3 playhead / sections / ruler geometry", () => {
  it("places the playhead on the lane scale, never left of the lane", () => {
    expect(playheadLeftPx(0, 80)).toBe(LANE_LEFT_PX);
    expect(playheadLeftPx(2, 80)).toBe(LANE_LEFT_PX + 160);
    expect(playheadLeftPx(2, 100)).toBe(LANE_LEFT_PX + 200);   // zoom moves it (anti-vacuity)
    expect(playheadLeftPx(-1, 80)).toBe(LANE_LEFT_PX);
  });
  it("boxes a section from beats at the session tempo", () => {
    expect(sectionBox({ startBeat: 8, endBeat: 24 }, 120, 80)).toEqual({ left: 320, width: 640 });
    expect(sectionBox({ startBeat: 8, endBeat: 24 }, 60, 80)).toEqual({ left: 640, width: 1280 });   // tempo changes it
    expect(sectionBox({ startBeat: 1, endBeat: 1 }, 120, 80).width).toBe(2);
    expect(sectionStartSec({ startBeat: 8, endBeat: 24 }, 120)).toBe(4);
  });
  it("hides beat labels once a beat cell is narrower than 18 px", () => {
    expect(beatLabelsVisible(1280, 32)).toBe(true);    // 40 px cells (80 px/s at 120 BPM)
    expect(beatLabelsVisible(320, 32)).toBe(false);    // 10 px cells (20 px/s)
    expect(beatLabelsVisible(528, 32)).toBe(false);    // 16.5 px cells (40 px/s at 145 BPM) — bars only
    expect(beatLabelsVisible(576, 32)).toBe(true);     // exactly 18
    expect(beatLabelsVisible(0, 0)).toBe(false);
  });
  it("maps a ruler click back to seconds and clamps at zero", () => {
    expect(secondsAtLaneX(160, 80)).toBe(2);
    expect(secondsAtLaneX(-5, 80)).toBe(0);
  });
});
