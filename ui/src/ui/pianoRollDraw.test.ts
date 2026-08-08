// Unit pins for drawNoteSpan — the live shell's draw-mode (pencil) gesture, SPEC §7
// of docs/live-clone/SPEC.md: draw ON paints a note whose length follows the drag;
// a plain click still paints a grid-step note.

import { describe, it, expect } from "vitest";
import { drawNoteSpan } from "./pianoRollEdit";

describe("drawNoteSpan (snap on, 1-beat grid)", () => {
  const STEP = 1;

  it("a plain click (no travel) paints exactly one grid step", () => {
    expect(drawNoteSpan({ downBeat: 4.2, currentBeat: 4.2, stepBeats: STEP }))
      .toEqual({ start: 4, length: 1 });
  });

  it("the start FLOORS to the grid line at/below the pointer-down", () => {
    // Round would put this at 5 — a full step from where the producer aimed.
    expect(drawNoteSpan({ downBeat: 4.6, currentBeat: 4.6, stepBeats: STEP }).start).toBe(4);
  });

  it("the length follows the drag, snapped", () => {
    expect(drawNoteSpan({ downBeat: 4.1, currentBeat: 6.4, stepBeats: STEP }))
      .toEqual({ start: 4, length: 2 });
    // a long drag across several steps
    expect(drawNoteSpan({ downBeat: 0.1, currentBeat: 7.6, stepBeats: STEP }))
      .toEqual({ start: 0, length: 8 });
  });

  it("a short drag still lands the minimum (one grid step)", () => {
    expect(drawNoteSpan({ downBeat: 4.1, currentBeat: 4.3, stepBeats: STEP }))
      .toEqual({ start: 4, length: 1 });
  });

  it("dragging LEFT of the start still paints rightward from the floor", () => {
    expect(drawNoteSpan({ downBeat: 4.4, currentBeat: 2.0, stepBeats: STEP }))
      .toEqual({ start: 4, length: 1 });
  });

  it("finer grids floor and snap to their own step", () => {
    expect(drawNoteSpan({ downBeat: 1.1, currentBeat: 1.8, stepBeats: 0.25 }))
      .toEqual({ start: 1, length: 0.75 });
  });

  it("never starts before beat 0", () => {
    expect(drawNoteSpan({ downBeat: -0.4, currentBeat: 0.3, stepBeats: STEP }))
      .toEqual({ start: 0, length: 1 });
  });
});

describe("drawNoteSpan (freehand — snap off or Option held)", () => {
  it("no floor, no snap: start and length are exactly the drag", () => {
    const { start, length } = drawNoteSpan({ downBeat: 1.13, currentBeat: 2.87, stepBeats: 1, bypassSnap: true });
    expect(start).toBeCloseTo(1.13, 6);
    expect(length).toBeCloseTo(1.74, 6);
  });

  it("stepBeats 0 behaves the same as a bypass", () => {
    const { start, length } = drawNoteSpan({ downBeat: 1.13, currentBeat: 2.87, stepBeats: 0 });
    expect(start).toBeCloseTo(1.13, 6);
    expect(length).toBeCloseTo(1.74, 6);
  });

  it("a freehand wobble-click still lands a note (the 1/4-beat floor)", () => {
    expect(drawNoteSpan({ downBeat: 2, currentBeat: 2.01, stepBeats: 0 }))
      .toEqual({ start: 2, length: 0.25 });
  });
});
