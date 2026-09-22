import { describe, expect, it } from "vitest";
import { LANE_LEFT_PX, beatPx, clipBeatCount, clipBeats, clipBox, gridBeatCount, gridDensity, gridMarks, laneContentPx, playheadLeftPx, secondsAtLaneX, sectionBox, sectionStartSec, sessionBeatCount } from "./timeline";

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
    expect(LANE_LEFT_PX).toBe(155);   // header 154 (meets its lane) + the lane's 1 px border
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
  it("puts the ruler, the lane grid and the clip grids on one beat scale", () => {
    expect(beatPx(120, 80)).toBe(40);
    expect(beatPx(145, 40)).toBeCloseTo(16.5517, 3);
    expect(gridBeatCount({ length: 16, tempo: 120 } as never, 80, 1280)).toBe(32);   // the session fills the lane
    expect(gridBeatCount({ length: 16, tempo: 120 } as never, 20, 1100)).toBe(110);  // a lane wider than the session keeps its beat cells (was 32 cells of 34 px)
    expect(clipBeats({ start: 2, length: 6 }, 120)).toEqual({ startBeat: 4, lengthBeats: 12 });
    expect(clipBeats({ start: 1.5, length: 1.7 }, 120).lengthBeats).toBeCloseTo(3.4, 9);    // exact, never rounded
  });
  it("thins the grid with zoom: beats from 20 px, bars every 1/2/4", () => {
    expect(gridDensity(40)).toEqual({ beats: true, barStep: 1 });
    expect(gridDensity(19.9)).toEqual({ beats: false, barStep: 1 });   // bar 79.6 px
    expect(gridDensity(16.55)).toEqual({ beats: false, barStep: 1 });  // 145 BPM at 40 px/s: bars only
    expect(gridDensity(10)).toEqual({ beats: false, barStep: 2 });     // bar 40 px
    expect(gridDensity(5)).toEqual({ beats: false, barStep: 4 });      // bar 20 px
  });
  it("emits the visible marks, snapped to device pixels", () => {
    const m = gridMarks(8, 40, 1);
    expect(m.map((g) => g.beat)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(m.filter((g) => g.bar).map((g) => [g.x, g.barNo])).toEqual([[0, 1], [160, 2]]);
    const frac = gridMarks(8, 16.5517, 2);                              // bars only; x on a half pixel
    expect(frac.map((g) => g.x)).toEqual([0, 66]);                      // 66.2068 → 66 at DPR 2 (132/2)
    expect(gridMarks(8, 16.5517, 1).map((g) => g.x)).toEqual([0, 66]);
    expect(gridMarks(4, 16.8, 2).length).toBe(1);
    expect(gridMarks(32, 10, 2).map((g) => g.barNo)).toEqual([1, 3, 5, 7]);   // every 2nd bar
    expect(gridMarks(32, 5, 2).map((g) => g.barNo)).toEqual([1, 5]);          // every 4th
    expect(gridMarks(0, 40)).toEqual([]);
    expect(gridMarks(8, 0)).toEqual([]);
  });

  it("maps a ruler click back to seconds and clamps at zero", () => {
    expect(secondsAtLaneX(160, 80)).toBe(2);
    expect(secondsAtLaneX(-5, 80)).toBe(0);
  });
});
