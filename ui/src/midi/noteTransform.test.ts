// Unit pins for the pure note-transform logic (the mock mirrors the engine with
// this; the engine pins its own path in the native selftest).

import { describe, expect, it } from "vitest";
import { transformNotes, type NoteTransformTarget } from "./noteTransform";

// The selftest's fixture shape: span [0, 8], a chord at 4 (two same-start notes).
const NOTES: NoteTransformTarget[] = [
  { start: 0, length: 1, pitch: 60, velocity: 40 },
  { start: 2, length: 1, pitch: 64, velocity: 80 },
  { start: 4, length: 2, pitch: 67, velocity: 100 },
  { start: 4, length: 1, pitch: 70, velocity: 90 },   // chord tone — shares the 4.0 onset
  { start: 7, length: 1, pitch: 72, velocity: 127 },
];

const startsOf = (out: NoteTransformTarget[]) => out.map((n) => n.start);
const lensOf = (out: NoteTransformTarget[]) => out.map((n) => n.length);

describe("transformNotes — reverse", () => {
  it("mirrors every note inside the targets' span, pitches/lengths kept", () => {
    const out = transformNotes(NOTES, "reverse");
    // span [0,8]: 0-1→7, 2-3→5, 4-6→2, 4-5→3, 7-8→0
    expect(startsOf(out)).toEqual([7, 5, 2, 3, 0]);
    expect(lensOf(out)).toEqual([1, 1, 2, 1, 1]);
    expect(out.map((n) => n.pitch)).toEqual(NOTES.map((n) => n.pitch));
    expect(out.map((n) => n.velocity)).toEqual(NOTES.map((n) => n.velocity));
  });

  it("works inside a SELECTION's own span", () => {
    const sel = [NOTES[0], NOTES[4]];   // span [0, 8] over just these two
    const out = transformNotes(sel, "reverse");
    expect(startsOf(out)).toEqual([7, 0]);
  });
});

describe("transformNotes — invert", () => {
  it("flips pitches around the HIGHEST target pitch (Live's rule)", () => {
    const out = transformNotes(NOTES, "invert");
    // top 72: 60→84, 64→80, 67→77, 70→74, 72→72
    expect(out.map((n) => n.pitch)).toEqual([84, 80, 77, 74, 72]);
    expect(startsOf(out)).toEqual(startsOf(NOTES));
  });

  it("clamps at the 0/127 rails", () => {
    const edge = [
      { start: 0, length: 1, pitch: 127, velocity: 100 },
      { start: 1, length: 1, pitch: 0, velocity: 100 },
    ];
    const out = transformNotes(edge, "invert");
    expect(out[1].pitch).toBe(127);   // 2·127 − 0 clamps to 127
    expect(out[0].pitch).toBe(127);
  });
});

describe("transformNotes — legato", () => {
  it("extends each note to the NEXT DISTINCT onset, last group to the span end", () => {
    const out = transformNotes(NOTES, "legato");
    // onsets 0, 2, 4, 7: 0→2, 2→4, both 4.0 notes→7, 7→spanEnd 8
    expect(lensOf(out)).toEqual([2, 2, 3, 3, 1]);
    expect(startsOf(out)).toEqual(startsOf(NOTES));   // starts/pitches untouched
    expect(out.map((n) => n.pitch)).toEqual(NOTES.map((n) => n.pitch));
  });

  it("chord tones never collapse to zero length", () => {
    const out = transformNotes(NOTES, "legato");
    for (const n of out) expect(n.length).toBeGreaterThan(0);
  });
});

describe("transformNotes — ×2 / /2", () => {
  it("doubles starts relative to the span start AND lengths", () => {
    const out = transformNotes(NOTES, "x2");
    expect(startsOf(out)).toEqual([0, 4, 8, 8, 14]);
    expect(lensOf(out)).toEqual([2, 2, 4, 2, 2]);
  });

  it("halves starts relative to the span start AND lengths", () => {
    const out = transformNotes(NOTES, "d2");
    expect(startsOf(out)).toEqual([0, 1, 2, 2, 3.5]);
    expect(lensOf(out)).toEqual([0.5, 0.5, 1, 0.5, 0.5]);
  });

  it("honours a non-zero span start", () => {
    const sel = [NOTES[1], NOTES[4]];   // span start 2
    expect(startsOf(transformNotes(sel, "x2"))).toEqual([2, 12]);   // 2+2·0, 2+2·5
    expect(startsOf(transformNotes(sel, "d2"))).toEqual([2, 4.5]);  // 2+0, 2+2.5
  });
});

describe("transformNotes — humanize", () => {
  it("amount 0 is the identity", () => {
    expect(transformNotes(NOTES, "humanize", { amount: 0, clipId: "c1" })).toEqual(NOTES);
  });

  it("stays within ±amount% of a 16th for timing and ±amount for velocity, clamped", () => {
    const amount = 40;
    const out = transformNotes(NOTES, "humanize", { amount, clipId: "c1" });
    out.forEach((n, i) => {
      expect(Math.abs(n.start - NOTES[i].start)).toBeLessThanOrEqual((amount / 100) * 0.25 + 1e-12);
      expect(n.start).toBeGreaterThanOrEqual(0);
      expect(Math.abs(n.velocity - NOTES[i].velocity)).toBeLessThanOrEqual(amount + 1); // +1 rounding slack
      expect(n.velocity).toBeGreaterThanOrEqual(1);
      expect(n.velocity).toBeLessThanOrEqual(127);
      expect(n.length).toBe(NOTES[i].length);   // lengths untouched
      expect(n.pitch).toBe(NOTES[i].pitch);     // pitches untouched
    });
  });

  it("is deterministic for the same command + pre-state (replay reproduces)", () => {
    const a = transformNotes(NOTES, "humanize", { amount: 25, clipId: "c1" });
    const b = transformNotes(NOTES, "humanize", { amount: 25, clipId: "c1" });
    expect(a).toEqual(b);
    const c = transformNotes(NOTES, "humanize", { amount: 26, clipId: "c1" });
    expect(c).not.toEqual(a);   // the seed rides the full command payload
  });
});

describe("transformNotes — setLength", () => {
  it("sets every target's length, starts/pitches/velocities unchanged", () => {
    const out = transformNotes(NOTES, "setLength", { lengthBeats: 0.5 });
    expect(out.map((n) => n.length)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(startsOf(out)).toEqual(startsOf(NOTES));
    expect(out.map((n) => n.pitch)).toEqual(NOTES.map((n) => n.pitch));
    expect(out.map((n) => n.velocity)).toEqual(NOTES.map((n) => n.velocity));
  });

  it("floors a tiny length at 1e-4 rather than emitting zero-length notes", () => {
    const out = transformNotes(NOTES.slice(0, 1), "setLength", { lengthBeats: 0 });
    expect(out[0].length).toBeCloseTo(1e-4, 9);
  });
});

describe("transformNotes — addInterval", () => {
  it("adds a chord tone at +N semitones per target; sources untouched (returns additions)", () => {
    const out = transformNotes(NOTES, "addInterval", { semitones: 3, clipNotes: NOTES });
    // 60→63, 64→67, 67→70 SKIPPED (the 70 chord tone already sounds at start 4),
    // 70→73, 72→75
    expect(out).toEqual([
      { start: 0, length: 1, pitch: 63, velocity: 40 },
      { start: 2, length: 1, pitch: 67, velocity: 80 },
      { start: 4, length: 1, pitch: 73, velocity: 90 },
      { start: 7, length: 1, pitch: 75, velocity: 127 },
    ]);
  });

  it("semitones 0 adds nothing (every candidate is a unison dupe)", () => {
    expect(transformNotes(NOTES, "addInterval", { semitones: 0, clipNotes: NOTES })).toEqual([]);
  });

  it("a negative interval walks down, clamped at 0; the 127 rail clamps upward", () => {
    const down = transformNotes(NOTES.slice(0, 1), "addInterval", { semitones: -5, clipNotes: NOTES });
    expect(down[0].pitch).toBe(55);
    // 72+100 clamps to 127; nothing sounds at (7, 127), so the clamped tone is ADDED
    const up = transformNotes(NOTES.slice(4), "addInterval", { semitones: 100, clipNotes: NOTES });
    expect(up).toEqual([{ start: 7, length: 1, pitch: 127, velocity: 127 }]);
    // …and a clamp that lands back ON the source pitch is a unison skip
    const atFloor = [{ start: 0, length: 1, pitch: 0, velocity: 100 }];
    expect(transformNotes(atFloor, "addInterval", { semitones: -5, clipNotes: atFloor })).toEqual([]);
  });

  it("tones added in the same pass join the dupe domain", () => {
    const two = [
      { start: 0, length: 1, pitch: 60, velocity: 100 },
      { start: 0, length: 1, pitch: 62, velocity: 100 },   // +2 also lands on 64
    ];
    const out = transformNotes(two, "addInterval", { semitones: 2, clipNotes: two });
    expect(out).toEqual([{ start: 0, length: 1, pitch: 64, velocity: 100 }]);   // one 64, not two
  });
});

describe("transformNotes — fitToScale", () => {
  it("snaps out-of-key pitches to the session key, ties DOWNWARD (D major)", () => {
    const out = transformNotes(NOTES, "fitToScale", { key: { tonic: "D", mode: "major" } });
    // D major = D E F# G A B C#. 60(C)→59(B) over 61(C#) — tie down; 64(E) in;
    // 67(G) in; 70(Bb)→69(A) over 71(B) — tie down; 72(C)→71(B) over 73(C#) — tie down
    expect(out.map((n) => n.pitch)).toEqual([59, 64, 67, 69, 71]);
    expect(startsOf(out)).toEqual(startsOf(NOTES));
  });

  it("defaults to A minor (the engine/snapshot default) when no key is passed", () => {
    const out = transformNotes(NOTES, "fitToScale");
    // A minor = all naturals; only 70 (Bb) is out → 69 (A)
    expect(out.map((n) => n.pitch)).toEqual([60, 64, 67, 69, 72]);
  });

  it("a chromatic key is the identity", () => {
    const out = transformNotes(NOTES, "fitToScale", { key: { tonic: "C", mode: "chromatic" } });
    expect(out).toEqual(NOTES);
  });
});
