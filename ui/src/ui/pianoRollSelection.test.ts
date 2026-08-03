import { describe, expect, it } from "vitest";
import { marqueeHit, toggleSelection, selectAll, invertSelection, selectAtPitch,
         stepSelection, noteIdentity, reselectByIdentity } from "./pianoRollSelection";
import type { MidiNote } from "../types";

const note = (i: number, pitch: number, start: number, length = 1): MidiNote =>
  ({ i, pitch, start, length, velocity: 100 });

const NOTES = [note(0, 60, 0), note(1, 64, 1), note(2, 60, 2), note(3, 67, 3)];
const ROW_H = 15, BEAT_PX = 42;
const boxOf = (n: MidiNote) => ({ x: n.start * BEAT_PX, y: (96 - n.pitch) * ROW_H, w: n.length * BEAT_PX, h: ROW_H });

describe("marqueeHit", () => {
  it("selects notes whose box intersects the rect, in any drag direction", () => {
    const rect = { x0: 0, y0: 0, x1: 2.5 * BEAT_PX, y1: 40 * ROW_H };
    const backwards = { x0: 2.5 * BEAT_PX, y0: 40 * ROW_H, x1: 0, y1: 0 };
    expect(marqueeHit(NOTES, rect, boxOf)).toEqual(marqueeHit(NOTES, backwards, boxOf));
    expect(marqueeHit(NOTES, rect, boxOf).length).toBeGreaterThan(0);
  });

  it("excludes notes outside the rect", () => {
    const tiny = { x0: 0, y0: 0, x1: 1, y1: 1 };
    expect(marqueeHit(NOTES, tiny, boxOf)).toEqual([]);
  });
});

describe("toggleSelection", () => {
  it("replaces the selection on a plain click", () => {
    expect([...toggleSelection(new Set([1, 2]), 3, false)]).toEqual([3]);
  });
  it("adds and removes on shift-click", () => {
    expect([...toggleSelection(new Set([1]), 2, true)].sort()).toEqual([1, 2]);
    expect([...toggleSelection(new Set([1, 2]), 2, true)]).toEqual([1]);
  });
});

describe("selectAll / invertSelection", () => {
  it("selects everything", () => {
    expect([...selectAll(NOTES)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });
  it("inverts", () => {
    expect([...invertSelection(NOTES, new Set([0, 2]))].sort((a, b) => a - b)).toEqual([1, 3]);
  });
  it("inverting twice returns the original selection", () => {
    const once = invertSelection(NOTES, new Set([0, 2]));
    expect([...invertSelection(NOTES, once)].sort((a, b) => a - b)).toEqual([0, 2]);
  });
});

describe("selectAtPitch", () => {
  it("selects every note at that pitch", () => {
    expect([...selectAtPitch(NOTES, 60, false, new Set())].sort((a, b) => a - b)).toEqual([0, 2]);
  });
  it("shift-click adds the pitch to an existing selection", () => {
    expect([...selectAtPitch(NOTES, 60, true, new Set([1]))].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });
  it("shift-clicking an already-fully-selected pitch clears just that pitch", () => {
    // Without this the gesture is one-way: you could never undo it without abandoning
    // the rest of the selection.
    expect([...selectAtPitch(NOTES, 60, true, new Set([0, 1, 2]))]).toEqual([1]);
  });
});

describe("stepSelection", () => {
  it("enters at the first note going forward, the last going backward", () => {
    expect([...stepSelection(NOTES, new Set(), 1)]).toEqual([0]);
    expect([...stepSelection(NOTES, new Set(), -1)]).toEqual([3]);
  });
  it("walks in TIME order, not index order", () => {
    const shuffled = [note(9, 60, 0), note(4, 62, 1), note(7, 64, 2)];
    expect([...stepSelection(shuffled, new Set([9]), 1)]).toEqual([4]);
    expect([...stepSelection(shuffled, new Set([4]), 1)]).toEqual([7]);
  });
  it("stops at the ends instead of wrapping", () => {
    expect([...stepSelection(NOTES, new Set([3]), 1)]).toEqual([3]);
    expect([...stepSelection(NOTES, new Set([0]), -1)]).toEqual([0]);
  });
  it("steps from the edge of a multi-note selection in the direction of travel", () => {
    expect([...stepSelection(NOTES, new Set([0, 1]), 1)]).toEqual([2]);
    expect([...stepSelection(NOTES, new Set([1, 2]), -1)]).toEqual([0]);
  });
});

describe("reselectByIdentity", () => {
  it("finds notes again after their indices have shifted", () => {
    // The engine's MidiList sorts by start, so inserting a note renumbers the rest. A
    // selection held as indices would silently point at the wrong notes after a paste.
    const wanted = [noteIdentity(note(0, 64, 1)), noteIdentity(note(0, 67, 3))];
    const after = [note(0, 60, 0), note(1, 62, 0.5), note(2, 64, 1), note(3, 67, 3)];
    expect([...reselectByIdentity(after, wanted)].sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it("ignores identities that no longer exist", () => {
    expect([...reselectByIdentity(NOTES, [noteIdentity(note(0, 99, 42))])]).toEqual([]);
  });
});
