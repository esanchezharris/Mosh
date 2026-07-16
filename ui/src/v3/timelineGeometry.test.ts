import { describe, expect, it } from "vitest";
import {
  clipRectInRange,
  navigatorFraction,
  playheadX,
  songEndSeconds,
  visibleRange,
  visibleSpanSeconds,
  zoomedViewStart,
  type TimelineSnapshot,
  type VisibleRange,
} from "./timelineGeometry";

function snapshot(overrides: Partial<TimelineSnapshot> = {}): TimelineSnapshot {
  return {
    session: { tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4 },
    tracks: [],
    ...overrides,
  };
}

describe("Open Lanes timeline geometry", () => {
  it("keeps an empty project at the v2 32-second floor", () => {
    expect(songEndSeconds(snapshot())).toBe(32);
  });

  it("includes visible clips and ignores hidden clips when deriving the song end", () => {
    const snap = snapshot({
      tracks: [{ clips: [
        { start: 12, length: 8 },
        { start: 100, length: 5, hidden: true },
        { start: 40, length: 10 },
      ] }],
    });
    expect(songEndSeconds(snap)).toBe(54);
  });

  it("includes beat-based sections when they extend beyond clips", () => {
    const snap = snapshot({ sections: [{ id: "outro", name: "Outro", startBeat: 160, endBeat: 200 }] });
    expect(songEndSeconds(snap)).toBe(104);
  });

  it("maps 8, 16, and full zooms onto the project bar span", () => {
    const snap = snapshot({ session: { tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, length: 60 } });
    expect(visibleSpanSeconds(snap, 8)).toBe(16);
    expect(visibleSpanSeconds(snap, 16)).toBe(32);
    expect(visibleSpanSeconds(snap, "full")).toBe(64);
  });

  it("clamps the visible range at both song boundaries", () => {
    const snap = snapshot({ session: { tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, length: 60 } });
    expect(visibleRange(snap, 8, -10)).toEqual({ startSec: 0, endSec: 16, spanSec: 16 });
    expect(visibleRange(snap, 8, 100)).toEqual({ startSec: 48, endSec: 64, spanSec: 16 });
  });

  it("anchors zoom on a visible transport and clamps near the song edges", () => {
    const current = { startSec: 24, endSec: 40, spanSec: 16 };
    expect(zoomedViewStart({ range: current, nextSpanSec: 8, totalSec: 64, transportSec: 28 })).toBe(24);
    expect(zoomedViewStart({ range: { startSec: 0, endSec: 64, spanSec: 64 }, nextSpanSec: 16, totalSec: 64, transportSec: 0 })).toBe(0);
    expect(zoomedViewStart({ range: { startSec: 48, endSec: 64, spanSec: 16 }, nextSpanSec: 32, totalSec: 64, transportSec: 60 })).toBe(32);
  });

  it("preserves the viewport center when transport is outside the current range", () => {
    expect(zoomedViewStart({ range: { startSec: 24, endSec: 40, spanSec: 16 }, nextSpanSec: 8, totalSec: 64, transportSec: 4 })).toBe(28);
  });

  it("clips partially visible clips to the active range", () => {
    const range: VisibleRange = { startSec: 10, endSec: 20, spanSec: 10 };
    expect(clipRectInRange(5, 8, range)).toEqual({ leftFrac: 0, widthFrac: 0.3 });
    expect(clipRectInRange(18, 8, range)).toEqual({ leftFrac: 0.8, widthFrac: 0.2 });
    expect(clipRectInRange(21, 2, range)).toBeNull();
  });

  it("maps playheads only while they are inside the active range", () => {
    const range: VisibleRange = { startSec: 10, endSec: 20, spanSec: 10 };
    expect(playheadX(15, range, 200)).toBe(100);
    expect(playheadX(9, range, 200)).toBeNull();
    expect(playheadX(20, range, 200)).toBe(200);
  });

  it("clamps navigator fractions outside the full-song extent", () => {
    expect(navigatorFraction(-2, 40)).toBe(0);
    expect(navigatorFraction(10, 40)).toBe(0.25);
    expect(navigatorFraction(80, 40)).toBe(1);
  });
});
