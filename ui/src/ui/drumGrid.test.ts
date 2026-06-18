import { describe, it, expect } from "vitest";
import {
  DRUM_LANES, STEPS, stepBeats, noteStart, laneIndexForPitch,
  cellForNote, buildGrid, cycleVelocity,
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

describe("stepBeats / noteStart", () => {
  it("splits a 4/4 bar into 16 quarter-step beats", () => {
    expect(stepBeats(4)).toBeCloseTo(0.25, 10);
  });
  it("splits a 3/4 bar into 16 steps", () => {
    expect(stepBeats(3)).toBeCloseTo(0.1875, 10);
  });
  it("noteStart(step) = step * stepBeats", () => {
    expect(noteStart(4, 0.25)).toBeCloseTo(1.0, 10);
    expect(noteStart(0, 0.25)).toBe(0);
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
