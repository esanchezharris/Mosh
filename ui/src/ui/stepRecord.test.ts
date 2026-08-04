import { describe, expect, it } from "vitest";
import { stepReduce, STEP_INITIAL, type StepState } from "./stepRecord";

const STEP = 0.25; // a 1/16 grid at 4/4

/** Drive a sequence of actions, collecting every note the reducer asked to write. */
const run = (actions: Parameters<typeof stepReduce>[1][], from: StepState = STEP_INITIAL) => {
  let s = from;
  const added: { pitch: number; start: number }[] = [];
  for (const a of actions) {
    const r = stepReduce(s, a, STEP);
    s = r.next;
    if (r.add) added.push(r.add);
  }
  return { state: s, added };
};

describe("step record", () => {
  it("a CHORD lands on one beat and advances the marker exactly once", () => {
    // The rule the whole reducer exists for. Advancing on key-DOWN would spread a chord
    // across three steps and make chord entry impossible.
    const { state, added } = run([
      { t: "down", pitch: 60 }, { t: "down", pitch: 64 }, { t: "down", pitch: 67 },
      { t: "up", pitch: 60 }, { t: "up", pitch: 64 }, { t: "up", pitch: 67 },
    ]);
    expect(added.map((a) => a.start)).toEqual([0, 0, 0]);
    expect(added.map((a) => a.pitch)).toEqual([60, 64, 67]);
    expect(state.insertBeat).toBe(STEP);
  });

  it("SEQUENTIAL presses land on consecutive steps", () => {
    const { state, added } = run([
      { t: "down", pitch: 60 }, { t: "up", pitch: 60 },
      { t: "down", pitch: 62 }, { t: "up", pitch: 62 },
      { t: "down", pitch: 64 }, { t: "up", pitch: 64 },
    ]);
    expect(added.map((a) => a.start)).toEqual([0, STEP, STEP * 2]);
    expect(state.insertBeat).toBe(STEP * 3);
  });

  it("an overlapping (legato) release still advances only once per emptied chord", () => {
    // down A, down B, up A, up B — the marker moves when the LAST key clears, not the first.
    const { state, added } = run([
      { t: "down", pitch: 60 }, { t: "down", pitch: 64 },
      { t: "up", pitch: 60 }, { t: "up", pitch: 64 },
    ]);
    expect(added.map((a) => a.start)).toEqual([0, 0]);
    expect(state.insertBeat).toBe(STEP);
  });

  it("OS key-repeat does not stack duplicate notes", () => {
    // The OS fires keydown repeatedly while a key is held; each one would otherwise write
    // another note onto the same beat.
    const { added } = run([{ t: "down", pitch: 60 }, { t: "down", pitch: 60 }, { t: "down", pitch: 60 }]);
    expect(added).toHaveLength(1);
  });

  it("ignores a key-up for something never held", () => {
    const { state, added } = run([{ t: "up", pitch: 60 }]);
    expect(added).toEqual([]);
    expect(state.insertBeat).toBe(0);   // no phantom advance
  });

  it("back steps the marker without deleting, and never before the clip start", () => {
    const { state } = run([
      { t: "down", pitch: 60 }, { t: "up", pitch: 60 },   // marker at STEP
      { t: "back" }, { t: "back" }, { t: "back" },
    ]);
    expect(state.insertBeat).toBe(0);
  });

  it("setInsert moves the marker (clicking the ruler) and clamps at zero", () => {
    expect(run([{ t: "setInsert", beat: 3 }]).state.insertBeat).toBe(3);
    expect(run([{ t: "setInsert", beat: -5 }]).state.insertBeat).toBe(0);
  });
});
