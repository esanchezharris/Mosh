// Unit pins for expandLoopedNotes (midi/midiLoop.ts) — Live's ghost-repeat
// geometry: the loop region repeats at loopLength intervals across the clip;
// outside notes play once; deactivated returns originals.

import { describe, expect, it } from "vitest";
import type { MidiNote } from "../types";
import { expandLoopedNotes } from "./midiLoop";

const note = (start: number, pitch = 60, length = 0.5): MidiNote =>
  ({ i: 0, pitch, start, length, velocity: 100 });

describe("expandLoopedNotes", () => {
  it("repeats the loop region at loopLength intervals across the clip, ghosts flagged", () => {
    // clip 8 beats, loop [0,2): the note at beat 1 repeats at 3, 5, 7
    const out = expandLoopedNotes([note(1)], 8, 0, 2);
    expect(out.map((n) => n.start)).toEqual([1, 3, 5, 7]);
    expect(out[0].ghost).toBeUndefined();
    expect(out.slice(1).every((n) => n.ghost)).toBe(true);
  });

  it("notes outside the loop region play once", () => {
    const out = expandLoopedNotes([note(1), note(5)], 8, 0, 2);
    expect(out.map((n) => n.start).sort((a, b) => a - b)).toEqual([1, 3, 5, 5, 7]);
    expect(out.filter((n) => n.ghost)).toHaveLength(3);
  });

  it("stops at the clip end (a partial trailing repeat is not painted)", () => {
    const out = expandLoopedNotes([note(1)], 8, 0, 2);
    expect(out[out.length - 1].start).toBe(7);
  });

  it("a deactivated loop (zero length) returns the originals unchanged", () => {
    const src = [note(1), note(3)];
    const out = expandLoopedNotes(src, 8, 0, 0);
    expect(out).toEqual(src);
    expect(out.every((n) => !n.ghost)).toBe(true);
  });

  it("a loop region not starting at 0 repeats from its own offset", () => {
    // loop [2,4) — the note at beat 3 repeats at 5, 7
    const out = expandLoopedNotes([note(3)], 8, 2, 2);
    expect(out.map((n) => n.start)).toEqual([3, 5, 7]);
  });
});
