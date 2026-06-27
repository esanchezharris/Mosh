import { describe, it, expect } from "vitest";
import { beatToSec, secToBeat, beatsPerBar, contentSeconds } from "./geom";
import type { Snapshot } from "../../types";

// Minimal snapshot stub for the pure geometry helpers.
const snap = (over: Partial<Snapshot["session"]> = {}, rest: Partial<Snapshot> = {}): Snapshot =>
  ({
    schemaVersion: 1,
    session: { sampleRate: 48000, tempo: 120, key: { tonic: "C", mode: "major" } as never, editFile: "", ...over },
    tracks: [],
    transport: { playing: false, position: 0, loop: false } as never,
    ...rest,
  }) as Snapshot;

describe("timeline geom", () => {
  it("beatToSec / secToBeat round-trip at 120bpm 4/4 (0.5s per beat)", () => {
    const s = snap();
    expect(beatToSec(s, 1)).toBeCloseTo(0.5, 6);
    expect(secToBeat(s, 0.5)).toBeCloseTo(1, 6);
    for (const b of [0, 4, 7.25, 32]) expect(secToBeat(s, beatToSec(s, b))).toBeCloseTo(b, 6);
  });

  it("respects tempo (60bpm → 1s per quarter)", () => {
    const s = snap({ tempo: 60 });
    expect(beatToSec(s, 1)).toBeCloseTo(1, 6);
    expect(secToBeat(s, 2)).toBeCloseTo(2, 6);
  });

  it("beatsPerBar reads the time-sig numerator (default 4)", () => {
    expect(beatsPerBar(snap())).toBe(4);
    expect(beatsPerBar(snap({ timeSigNumerator: 3 }))).toBe(3);
  });

  it("contentSeconds stretches to cover the last section end", () => {
    const s = snap({}, { sections: [{ id: "x", name: "Outro", startBeat: 0, endBeat: 200 }] });
    // 200 beats * 0.5s = 100s, plus tail, so well past the 32s floor.
    expect(contentSeconds(s)).toBeGreaterThanOrEqual(100);
  });
});
