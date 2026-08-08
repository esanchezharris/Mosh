// Unit pins for the pure velocity-tool logic (the mock mirrors the engine with
// this; the engine pins its own path in the native selftest).

import { describe, expect, it } from "vitest";
import { clampVelocity, transformVelocities } from "./velocityTransform";

const NOTES = [
  { start: 2.0, pitch: 64, velocity: 90 },
  { start: 0.0, pitch: 60, velocity: 80 },
  { start: 0.0, pitch: 62, velocity: 70 },   // ties with the 0.0 note — pitch breaks it
  { start: 3.0, pitch: 65, velocity: 100 },
];

describe("transformVelocities — ramp", () => {
  it("linear lo→hi across the targets in TIME order, ties by pitch", () => {
    // time order: (0.0,60) → (0.0,62) → (2.0,64) → (3.0,65)
    const out = transformVelocities(NOTES, "ramp", { lo: 20, hi: 120 });
    expect(out[1]).toBe(20);    // first in time (0.0, pitch 60)
    expect(out[2]).toBe(53);    // tie broken by pitch: 20 + 100/3
    expect(out[0]).toBe(87);    // 20 + 2·100/3
    expect(out[3]).toBe(120);   // last in time
  });

  it("a single note lands on lo", () => {
    expect(transformVelocities([{ start: 0, pitch: 60, velocity: 90 }], "ramp", { lo: 30, hi: 90 })).toEqual([30]);
  });

  it("clamps out-of-range lo/hi", () => {
    const out = transformVelocities(NOTES, "ramp", { lo: 0, hi: 200 });
    expect(out[1]).toBe(1);
    expect(out[3]).toBe(127);
  });
});

describe("transformVelocities — randomize / deviate", () => {
  it("stays within ±amount of each current velocity, clamped 1..127", () => {
    const out = transformVelocities(NOTES, "randomize", { amount: 15, clipId: "c1" });
    out.forEach((v, i) => {
      expect(Math.abs(v - NOTES[i].velocity)).toBeLessThanOrEqual(15 + 1); // +1 rounding slack
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(127);
    });
  });

  it("is deterministic for the same command + pre-state, and differs by mode", () => {
    const a = transformVelocities(NOTES, "deviate", { amount: 25, clipId: "c1" });
    const b = transformVelocities(NOTES, "deviate", { amount: 25, clipId: "c1" });
    expect(a).toEqual(b);
    const c = transformVelocities(NOTES, "randomize", { amount: 25, clipId: "c1" });
    expect(c).not.toEqual(a);   // each mode seeds independently
  });

  it("amount 0 is the identity", () => {
    const out = transformVelocities(NOTES, "deviate", { amount: 0 });
    expect(out).toEqual(NOTES.map((n) => n.velocity));
  });

  it("clamps at the rails for extreme velocities", () => {
    const edge = [
      { start: 0, pitch: 60, velocity: 1 },
      { start: 1, pitch: 62, velocity: 127 },
    ];
    const out = transformVelocities(edge, "randomize", { amount: 127, clipId: "c2" });
    out.forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(127);
    });
  });
});

describe("clampVelocity", () => {
  it("rails and rounding", () => {
    expect(clampVelocity(0)).toBe(1);
    expect(clampVelocity(200)).toBe(127);
    expect(clampVelocity(63.6)).toBe(64);
  });
});
