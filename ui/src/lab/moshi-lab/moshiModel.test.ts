// Moshi redesign lab model — headless checks for the shared brain + geometry so the
// candidates can never silently drift from the semantic contract they all implement.
import { describe, expect, it } from "vitest";
import {
  MoshiBrain, Spring, mouthPath, mouthShape, LOBES, MOSHI_STATES,
} from "./moshiModel";

describe("Spring", () => {
  it("settles on its target", () => {
    const s = new Spring(0, 140, 13);
    s.target = 1;
    for (let i = 0; i < 600; i++) s.step(1 / 60);
    expect(s.x).toBeCloseTo(1, 2);
  });
  it("an impulse overshoots then returns", () => {
    const s = new Spring(0, 170, 15);
    s.impulse(3);
    let peak = 0;
    for (let i = 0; i < 30; i++) { s.step(1 / 60); peak = Math.max(peak, s.x); }
    expect(peak).toBeGreaterThan(0.05);
    for (let i = 0; i < 600; i++) s.step(1 / 60);
    expect(Math.abs(s.x)).toBeLessThan(0.01);
  });
});

describe("mouth", () => {
  it("closed is a shallow smile, open is deep with a throat", () => {
    const closed = mouthShape(0, 0.5, 0.6);
    const open = mouthShape(1, 0.5, 0.6);
    expect(open.depth).toBeGreaterThan(closed.depth * 3);
    expect(open.throatOpacity).toBeGreaterThan(0.9);
    expect(closed.throatOpacity).toBe(0);
  });
  it("mouthPath emits a closed SVG path", () => {
    const d = mouthPath(mouthShape(0.7, 0.5, 0.5));
    expect(d.startsWith("M ")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
  });
});

describe("MoshiBrain", () => {
  it("accepts every product state and returns finite pose numbers", () => {
    const b = new MoshiBrain();
    for (const s of MOSHI_STATES) {
      b.setState(s);
      const p = b.tick(1 / 60);
      expect(Number.isFinite(p.sx)).toBe(true);
      expect(Number.isFinite(p.mouthOpen)).toBe(true);
      expect(p.lobes).toHaveLength(LOBES.length);
    }
  });
  it("celebrate launches him up and opens the mouth", () => {
    const b = new MoshiBrain();
    b.celebrate();
    const p = b.tick(1 / 60);
    b.tick(1 / 60);
    expect(p.y).toBeLessThan(0); // airborne (y is down in viewBox space)
    for (let i = 0; i < 15; i++) b.tick(1 / 60); // the grin eases in over ~10 frames
    expect(b.tick(1 / 60).mouthOpen).toBeGreaterThan(0.5);
  });
  it("sleeping droops + lidded; recording heats up", () => {
    const b = new MoshiBrain();
    b.setState("SLEEPING");
    for (let i = 0; i < 240; i++) b.tick(1 / 60);
    const p = b.tick(1 / 60);
    expect(p.droop).toBeGreaterThan(0.3);
    expect(p.blink).toBeGreaterThan(0.5); // resting lid, not a blink
    b.setState("RECORDING");
    b.set("heat", 1);
    for (let i = 0; i < 240; i++) b.tick(1 / 60);
    expect(b.tick(1 / 60).heat).toBeGreaterThan(0.8);
  });
  it("speaking drives the mouth above the idle base", () => {
    const b = new MoshiBrain();
    b.speak(true);
    let peak = 0;
    for (let i = 0; i < 60; i++) peak = Math.max(peak, b.tick(1 / 60).mouthOpen);
    expect(peak).toBeGreaterThan(0.4);
  });
  it("gaze eases toward lookAt", () => {
    const b = new MoshiBrain();
    b.lookAt(1, 0);
    for (let i = 0; i < 120; i++) b.tick(1 / 60);
    expect(b.tick(1 / 60).gazeX).toBeGreaterThan(0.9);
  });
});
