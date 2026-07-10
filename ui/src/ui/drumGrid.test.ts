import { describe, it, expect } from "vitest";
import {
  DRUM_LANES, STEPS, STEP_OPTIONS, stepBeats, laneIndexForPitch,
  cellForNote, buildGrid, cycleVelocity,
  swingOffsetBeats, stepStartBeats, velocityFromFraction,
} from "./drumGrid";
import type { MidiNote } from "../types";

const note = (over: Partial<MidiNote>): MidiNote => ({
  i: 0, pitch: 36, start: 0, length: 0.25, velocity: 100, ...over,
});

describe("drum lane table", () => {
  it("has 8 distinct GM lanes including kick (36) and snare (38)", () => {
    expect(DRUM_LANES).toHaveLength(8);
    const pitches = DRUM_LANES.map((l) => l.pitch);
    expect(new Set(pitches).size).toBe(8);
    expect(pitches).toContain(36);
    expect(pitches).toContain(38);
  });
});

describe("stepBeats", () => {
  it("splits a 4/4 bar into 16 quarter-step beats", () => {
    expect(stepBeats(4)).toBeCloseTo(0.25, 10);
  });
  it("splits a 3/4 bar into 16 steps", () => {
    expect(stepBeats(3)).toBeCloseTo(0.1875, 10);
  });
});

describe("laneIndexForPitch", () => {
  it("resolves a lane pitch to its row index", () => {
    expect(laneIndexForPitch(36)).toBe(DRUM_LANES.findIndex((l) => l.pitch === 36));
  });
  it("returns -1 for an off-lane pitch", () => {
    expect(laneIndexForPitch(60)).toBe(-1);
  });
});

describe("cellForNote", () => {
  const sb = stepBeats(4); // 0.25
  it("maps a snare on the 3rd sixteenth to its (lane, step)", () => {
    const c = cellForNote(note({ pitch: 38, start: 0.5 }), sb);
    expect(c).toEqual({ lane: laneIndexForPitch(38), step: 2 });
  });
  it("is null for an off-lane pitch", () => {
    expect(cellForNote(note({ pitch: 60, start: 0 }), sb)).toBeNull();
  });
  it("is null for a note past the first bar (step >= 16)", () => {
    expect(cellForNote(note({ pitch: 36, start: 4.0 }), sb)).toBeNull();
  });
});

describe("buildGrid", () => {
  const notes: MidiNote[] = [
    note({ i: 0, pitch: 36, start: 0, velocity: 100 }),     // kick step 0
    note({ i: 1, pitch: 38, start: 0.5, velocity: 80 }),    // snare step 2
    note({ i: 2, pitch: 60, start: 0 }),                    // off-lane, ignored
  ];
  it("produces a laneCount x STEPS grid", () => {
    const g = buildGrid(notes, 4);
    expect(g).toHaveLength(DRUM_LANES.length);
    expect(g[0]).toHaveLength(STEPS);
  });
  it("marks on-cells with their note index + velocity, off-cells off", () => {
    const g = buildGrid(notes, 4);
    const kick = laneIndexForPitch(36), snare = laneIndexForPitch(38);
    expect(g[kick][0]).toEqual({ on: true, velocity: 100, noteIndex: 0 });
    expect(g[snare][2]).toEqual({ on: true, velocity: 80, noteIndex: 1 });
    expect(g[kick][1].on).toBe(false);
  });
});

describe("cycleVelocity (shift-click accent cycle)", () => {
  it("cycles loud -> med -> soft -> loud", () => {
    expect(cycleVelocity(127)).toBe(90);
    expect(cycleVelocity(90)).toBe(50);
    expect(cycleVelocity(50)).toBe(127);
  });
});

// ── Phase 6 (FL feel): pattern length · swing · velocity mapping ──────────────

describe("pattern length (configurable step count)", () => {
  it("stepBeats divides the bar by the step count", () => {
    expect(stepBeats(4, 8)).toBeCloseTo(0.5, 10);
    expect(stepBeats(4, 16)).toBeCloseTo(0.25, 10);
    expect(stepBeats(4, 32)).toBeCloseTo(0.125, 10);
    expect(stepBeats(4, 12)).toBeCloseTo(1 / 3, 10);
    expect(stepBeats(4, 24)).toBeCloseTo(1 / 6, 10);
    expect(stepBeats(4)).toBeCloseTo(0.25, 10); // default 16 unchanged
  });
  it("buildGrid honours the step count (row width)", () => {
    expect(buildGrid([], 4, 8)[0]).toHaveLength(8);
    expect(buildGrid([], 4, 32)[0]).toHaveLength(32);
    expect(buildGrid([], 4, 12)[0]).toHaveLength(12);
    expect(buildGrid([], 4, 24)[0]).toHaveLength(24);
    expect(buildGrid([], 4)[0]).toHaveLength(STEPS);
  });
  it("exposes triplet-friendly length options", () => {
    expect(STEP_OPTIONS).toEqual(expect.arrayContaining([12, 24]));
  });
  it("cellForNote maps within a 32-step pattern", () => {
    const sb = stepBeats(4, 32); // 0.125
    expect(cellForNote(note({ pitch: 36, start: 0.125 }), sb, 32)).toEqual({ lane: laneIndexForPitch(36), step: 1 });
    expect(cellForNote(note({ pitch: 36, start: 0.875 }), sb, 32)).toEqual({ lane: laneIndexForPitch(36), step: 7 });
  });
});

describe("swing", () => {
  const sb = stepBeats(4); // 0.25
  it("leaves on-beats (even steps) put, delays off-beats (odd steps)", () => {
    expect(swingOffsetBeats(0, sb, 0.5)).toBe(0);
    expect(swingOffsetBeats(2, sb, 0.5)).toBe(0);
    expect(swingOffsetBeats(1, sb, 0.5)).toBeGreaterThan(0);
    expect(swingOffsetBeats(3, sb, 1)).toBeCloseTo(sb * (2 / 3), 10); // hard shuffle
  });
  it("is straight at swing 0", () => {
    expect(swingOffsetBeats(1, sb, 0)).toBe(0);
    expect(stepStartBeats(1, sb, 0)).toBeCloseTo(sb, 10);
  });
  it("stepStartBeats pushes the off-beat later under swing", () => {
    expect(stepStartBeats(1, sb, 0.5)).toBeGreaterThan(sb);
  });
  it("a swung note still maps back to its step (round-trip)", () => {
    const swing = 0.5;
    const start = stepStartBeats(3, sb, swing);
    expect(cellForNote(note({ pitch: 36, start }), sb, STEPS, swing)).toEqual({ lane: laneIndexForPitch(36), step: 3 });
  });
});

describe("velocityFromFraction", () => {
  it("maps a drag fraction (bottom→top) to 1..127, clamped", () => {
    expect(velocityFromFraction(0)).toBe(1);     // never silent (min 1)
    expect(velocityFromFraction(1)).toBe(127);
    expect(velocityFromFraction(0.5)).toBe(64);  // round(63.5)
    expect(velocityFromFraction(-5)).toBe(1);
    expect(velocityFromFraction(9)).toBe(127);
  });
});
