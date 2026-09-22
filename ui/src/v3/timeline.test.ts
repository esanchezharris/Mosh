import { describe, expect, it } from "vitest";
import { LANE_LEFT_PX, beatLabelsVisible, beatPx, clipBeatCount, clipBeats, clipBox, clipGridLines, gridBeatCount, laneContentPx, playheadLeftPx, secondsAtLaneX, sectionBox, sectionStartSec, sessionBeatCount } from "./timeline";

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
  it("hides beat labels once a beat is narrower than 18 px", () => {
    expect(beatLabelsVisible(40)).toBe(true);      // 80 px/s at 120 BPM
    expect(beatLabelsVisible(10)).toBe(false);     // 20 px/s
    expect(beatLabelsVisible(16.55)).toBe(false);  // 40 px/s at 145 BPM — bars only
    expect(beatLabelsVisible(18)).toBe(true);      // exactly 18
    expect(beatLabelsVisible(0)).toBe(false);
  });
  it("puts the ruler, the lane grid and the clip grids on one beat scale", () => {
    expect(beatPx(120, 80)).toBe(40);
    expect(beatPx(145, 40)).toBeCloseTo(16.5517, 3);
    expect(gridBeatCount({ length: 16, tempo: 120 } as never, 80, 1280)).toBe(32);   // the session fills the lane
    expect(gridBeatCount({ length: 16, tempo: 120 } as never, 20, 1100)).toBe(110);  // a lane wider than the session keeps its beat cells (was 32 cells of 34 px)
    expect(clipBeats({ start: 2, length: 6 }, 120)).toEqual({ startBeat: 4, lengthBeats: 12 });
    expect(clipBeats({ start: 1.5, length: 1.7 }, 120).lengthBeats).toBeCloseTo(3.4, 9);    // exact, never rounded
  });
  it("draws a clip's grid at the session's beats, bars where the ruler has them", () => {
    const onGrid = clipGridLines(4, 12);                     // beats 4..16
    expect(onGrid).toHaveLength(13);
    expect(onGrid[0]).toEqual({ x: 0, bar: true });
    expect(onGrid[12]).toEqual({ x: 1, bar: true });
    expect(onGrid.filter((l) => l.bar).map((l) => l.x)).toEqual([0, 4 / 12, 8 / 12, 1]);
    const midBar = clipGridLines(1.5, 4);                    // beats 2,3,4,5 inside 1.5..5.5
    expect(midBar.map((l) => l.x)).toEqual([0.125, 0.375, 0.625, 0.875]);
    expect(midBar.map((l) => l.bar)).toEqual([false, false, true, false]);   // beat 4 is the bar
    expect(clipGridLines(0, 0)).toEqual([]);
  });
  it("maps a ruler click back to seconds and clamps at zero", () => {
    expect(secondsAtLaneX(160, 80)).toBe(2);
    expect(secondsAtLaneX(-5, 80)).toBe(0);
  });
});
