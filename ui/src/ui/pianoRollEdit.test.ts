// Gesture arithmetic at GROUP scale. PianoRoll.dragAxes.test.ts pins axis independence for
// one note through the real component; this pins the same rule for N notes, plus the
// property that only appears with more than one: a selection keeps its internal shape.

import { describe, expect, it } from "vitest";
import { moveEdits, resizeEdits, resizeStartEdits, transposeEdits, nudgeEdits, velocityEdits,
         toggleActiveEdits, previewFrom, type GestureGeom } from "./pianoRollEdit";
import type { MidiNote } from "../types";

const ROW_H = 15, BEAT_PX = 42, STEP = 1; // 1/4 grid at 4/4

const GEOM: GestureGeom = {
  beatPx: BEAT_PX, rowH: ROW_H, dragThreshold: 3,
  snapBeat: (b, bypass) => (bypass ? b : Math.round(b / STEP) * STEP),
  lockPitch: (p) => p,
  minLengthBeats: STEP,
};

const note = (i: number, pitch: number, start: number, length = 1, velocity = 100): MidiNote =>
  ({ i, pitch, start, length, velocity });

// Deliberately off-grid and unevenly spaced, so a bug that collapses the selection onto
// one note, or straightens it, is visible.
const SEL = new Map<number, MidiNote>([
  [0, note(0, 60, 1.3)],
  [1, note(1, 64, 2.8)],
  [2, note(2, 67, 5.1)],
]);

describe("moveEdits", () => {
  it("a purely VERTICAL drag transposes every note and rewrites no start", () => {
    const edits = moveEdits({ orig: SEL, dxPx: 0, dyPx: 2 * ROW_H, bypassSnap: false }, GEOM);
    expect(edits.map((e) => e.pitch)).toEqual([58, 62, 65]);
    expect(edits.map((e) => e.start)).toEqual([1.3, 2.8, 5.1]);
  });

  it("a sub-threshold horizontal wobble during a vertical drag still rewrites no start", () => {
    const edits = moveEdits({ orig: SEL, dxPx: 3, dyPx: 2 * ROW_H, bypassSnap: false }, GEOM);
    expect(edits.map((e) => e.start)).toEqual([1.3, 2.8, 5.1]);
  });

  it("a purely HORIZONTAL drag re-times every note and rewrites no pitch", () => {
    const edits = moveEdits({ orig: SEL, dxPx: BEAT_PX, dyPx: 0, bypassSnap: false }, GEOM);
    expect(edits.map((e) => e.pitch)).toEqual([60, 64, 67]);
  });

  it("preserves the selection's internal spacing — each note moves by its own delta", () => {
    // The bug this exists for: deriving every note from the ANCHOR's new position, which
    // stacks the whole selection onto one beat.
    const edits = moveEdits({ orig: SEL, dxPx: 2 * BEAT_PX, dyPx: 0, bypassSnap: true }, GEOM);
    expect(edits.map((e) => e.start)).toEqual([3.3, 4.8, 7.1]);
  });

  it("snaps every note independently when snap is on", () => {
    const edits = moveEdits({ orig: SEL, dxPx: BEAT_PX, dyPx: 0, bypassSnap: false }, GEOM);
    expect(edits.map((e) => e.start)).toEqual([2, 4, 6]);
  });

  it("commits NOTHING when neither axis moved", () => {
    expect(moveEdits({ orig: SEL, dxPx: 2, dyPx: 4, bypassSnap: false }, GEOM)).toEqual([]);
  });

  it("never drags a note before beat 0 or past pitch 0/127", () => {
    const edge = new Map([[0, note(0, 2, 0.5)]]);
    const edits = moveEdits({ orig: edge, dxPx: -20 * BEAT_PX, dyPx: 40 * ROW_H, bypassSnap: true }, GEOM);
    expect(edits[0].start).toBe(0);
    expect(edits[0].pitch).toBe(0);
  });

  it("applies scale lock to the pitch axis only", () => {
    const toC = { ...GEOM, lockPitch: () => 60 };
    const edits = moveEdits({ orig: SEL, dxPx: 0, dyPx: ROW_H, bypassSnap: false }, toC);
    expect(edits.every((e) => e.pitch === 60)).toBe(true);
  });
});

describe("resizeEdits", () => {
  it("resizes every selected note from its OWN end, not a shared one", () => {
    const sel = new Map([[0, note(0, 60, 0, 1)], [1, note(1, 64, 4, 3)]]);
    const edits = resizeEdits({ orig: sel, dxPx: BEAT_PX, dyPx: 0, bypassSnap: true }, GEOM);
    expect(edits.map((e) => e.length)).toEqual([2, 4]);
  });

  it("commits nothing inside the deadzone", () => {
    expect(resizeEdits({ orig: SEL, dxPx: 2, dyPx: 0, bypassSnap: false }, GEOM)).toEqual([]);
  });

  it("never produces a note shorter than the minimum", () => {
    const sel = new Map([[0, note(0, 60, 0, 1)]]);
    const edits = resizeEdits({ orig: sel, dxPx: -10 * BEAT_PX, dyPx: 0, bypassSnap: true }, GEOM);
    expect(edits[0].length).toBe(STEP);
  });
});

describe("resizeStartEdits", () => {
  it("moves the left edge while preserving each selected note's own end", () => {
    const sel = new Map([[0, note(0, 60, 1, 1)], [1, note(1, 64, 4, 3)]]);
    const edits = resizeStartEdits({ orig: sel, dxPx: -BEAT_PX / 2, dyPx: 0, bypassSnap: true }, GEOM);

    expect(edits).toEqual([
      { i: 0, start: 0.5, length: 1.5 },
      { i: 1, start: 3.5, length: 3.5 },
    ]);
  });

  it("clamps at beat zero and at the minimum note length", () => {
    const sel = new Map([[0, note(0, 60, 1, 2)]]);

    expect(resizeStartEdits({ orig: sel, dxPx: -10 * BEAT_PX, dyPx: 0, bypassSnap: true }, GEOM)[0])
      .toEqual({ i: 0, start: 0, length: 3 });
    expect(resizeStartEdits({ orig: sel, dxPx: 10 * BEAT_PX, dyPx: 0, bypassSnap: true }, GEOM)[0])
      .toEqual({ i: 0, start: 2, length: 1 });
  });

  it("commits nothing inside the deadzone", () => {
    expect(resizeStartEdits({ orig: SEL, dxPx: 2, dyPx: 0, bypassSnap: false }, GEOM)).toEqual([]);
  });
});

describe("keyboard edits", () => {
  const notes = [...SEL.values()];
  const sel = new Set([0, 2]);

  it("transposes only the selection", () => {
    expect(transposeEdits(notes, sel, 12, (p) => p)).toEqual([{ i: 0, pitch: 72 }, { i: 2, pitch: 79 }]);
  });

  it("nudges only the selection and never past beat 0", () => {
    const starts = nudgeEdits(notes, sel, -2).map((e) => e.start!);
    expect(starts[0]).toBe(0);            // clamped, not -0.7
    expect(starts[1]).toBeCloseTo(3.1, 6); // 5.1 - 2, in binary floating point
    expect(starts).toHaveLength(2);
  });

  it("clamps velocity to the engine's 1..127", () => {
    expect(velocityEdits(notes, sel, 500).map((e) => e.velocity)).toEqual([127, 127]);
    expect(velocityEdits(notes, sel, -500).map((e) => e.velocity)).toEqual([1, 1]);
  });

  it("a MIXED selection activates everything rather than flipping each note", () => {
    // Flipping per note makes the key useless on a mixed selection: pressing it twice
    // returns you to the start by a different route each time.
    const mixed = [note(0, 60, 0), { ...note(1, 64, 1), mute: true }];
    expect(toggleActiveEdits(mixed, new Set([0, 1]))).toEqual([{ i: 0, mute: true }, { i: 1, mute: true }]);
    const allMuted = mixed.map((n) => ({ ...n, mute: true }));
    expect(toggleActiveEdits(allMuted, new Set([0, 1]))).toEqual([{ i: 0, mute: false }, { i: 1, mute: false }]);
  });
});

describe("previewFrom", () => {
  it("overlays edits on the frozen originals, leaving untouched fields alone", () => {
    const preview = previewFrom(SEL, [{ i: 1, pitch: 70 }]);
    expect(preview.get(1)).toMatchObject({ i: 1, pitch: 70, start: 2.8, length: 1, velocity: 100 });
    expect(preview.size).toBe(1);
  });
});
