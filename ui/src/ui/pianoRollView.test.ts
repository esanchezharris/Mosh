import { describe, expect, it } from "vitest";
import { visiblePitches, pitchAxis, PITCH_MIN, PITCH_MAX } from "./pianoRollView";
import type { MidiNote } from "../types";

const note = (pitch: number): MidiNote => ({ i: 0, pitch, start: 0, length: 1, velocity: 100 });
// A minor: A B C D E F G
const A_MINOR = [true, false, true, false, true, true, false, true, false, true, false, true];

describe("visiblePitches", () => {
  it("shows the whole MIDI range unfolded, top-down", () => {
    const v = visiblePitches({ mode: "off" });
    expect(v).toHaveLength(128);
    expect(v[0]).toBe(PITCH_MAX);
    expect(v[v.length - 1]).toBe(PITCH_MIN);
  });

  it("content fold keeps only the pitches in use — a drum clip becomes a handful of rows", () => {
    const notes = [36, 38, 42].map(note);
    expect(visiblePitches({ mode: "content", notes })).toEqual([42, 38, 36]);
  });

  it("scale fold NEVER hides a pitch that has a note", () => {
    // The load-bearing case. Without the union an out-of-key note the producer wrote
    // becomes invisible and unselectable — data-loss-shaped, not a view preference.
    const outOfKey = 61; // C# is not in A minor
    const v = visiblePitches({ mode: "scale", keyMask: A_MINOR, notes: [note(outOfKey)] });
    expect(v).toContain(outOfKey);
  });

  it("scale fold drops out-of-key rows that have no notes", () => {
    const v = visiblePitches({ mode: "scale", keyMask: A_MINOR, notes: [] });
    expect(v).not.toContain(61);
    expect(v).toContain(60);   // C is in A minor
  });

  it("never folds to nothing — an empty clip falls back to the full range", () => {
    // Folding an empty clip to zero rows would render a zero-height grid with no way back.
    expect(visiblePitches({ mode: "content", notes: [] })).toHaveLength(128);
    expect(visiblePitches({ mode: "scale", keyMask: new Array(12).fill(false), notes: [] })).toHaveLength(128);
  });
});

describe("pitchAxis", () => {
  const ROW_H = 15;

  it("round-trips pitch → y → pitch on row boundaries", () => {
    const axis = pitchAxis(visiblePitches({ mode: "off" }), ROW_H);
    for (const p of [0, 36, 60, 96, 127]) expect(axis.pitchAt(axis.yOf(p))).toBe(p);
  });

  it("reports -1 for a folded-away pitch rather than a plausible wrong row", () => {
    const axis = pitchAxis(visiblePitches({ mode: "content", notes: [36, 42].map(note) }), ROW_H);
    expect(axis.yOf(60)).toBe(-1);
    expect(axis.yOf(42)).toBe(0);
    expect(axis.yOf(36)).toBe(ROW_H);
  });

  it("height follows the visible rows, so folding shrinks the grid", () => {
    expect(pitchAxis(visiblePitches({ mode: "off" }), ROW_H).height).toBe(128 * ROW_H);
    expect(pitchAxis(visiblePitches({ mode: "content", notes: [36, 42].map(note) }), ROW_H).height).toBe(2 * ROW_H);
  });

  it("clamps a click outside the grid instead of returning a phantom pitch", () => {
    const axis = pitchAxis(visiblePitches({ mode: "off" }), ROW_H);
    expect(axis.pitchAt(-500)).toBe(PITCH_MAX);
    expect(axis.pitchAt(999999)).toBe(PITCH_MIN);
  });
});
