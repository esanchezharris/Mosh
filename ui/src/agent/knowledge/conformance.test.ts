import { describe, it, expect } from "vitest";
import { patternConformance, swingConformance, humanizeConformance, automationConformance, sendConformance } from "./conformance";
import type { MidiNote, PluginParam, Track } from "../../types";

const note = (i: number, pitch: number, start: number, velocity = 90, length = 0.5): MidiNote => ({ i, pitch, start, length, velocity });

// patternConformance is the load-bearing reader: did the agent reproduce a producer's
// drum GRID (kick/snare/hat placement)? — the actual mineable value, not a single knob.
describe("patternConformance — the laid notes match a producer's drum grid", () => {
  const pattern = { hits: [
    { pitch: 36, beats: [0, 2.5] },                       // kick
    { pitch: 38, beats: [1, 3] },                         // snare on the backbeat
    { pitch: 42, beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] }, // hats on every 8th
  ] };
  const full = (): MidiNote[] => [
    note(0, 36, 0), note(1, 36, 2.5),
    note(2, 38, 1), note(3, 38, 3),
    ...[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((b, k) => note(10 + k, 42, b)),
  ];
  it("passes when every expected hit is present", () => {
    expect(patternConformance(full(), pattern).conformant).toBe(true);
  });
  it("fails when a hit is missing (no snare on beat 3)", () => {
    const notes = full().filter((n) => !(n.pitch === 38 && Math.abs(n.start - 3) < 1e-6));
    expect(patternConformance(notes, pattern).conformant).toBe(false);
  });
  it("tolerates small timing jitter on a hit (still the same grid)", () => {
    const notes = full().map((n) => (n.pitch === 42 && n.start === 1 ? { ...n, start: 1.02 } : n));
    expect(patternConformance(notes, pattern).conformant).toBe(true);
  });
});

describe("swingConformance — off-beats pushed late by ~swing*division", () => {
  const div = 0.5, swing = 0.58;
  it("passes when odd 8ths are delayed by the requested swing", () => {
    const notes = Array.from({ length: 8 }, (_, s) => note(s, 42, s * div + (s % 2 ? swing * div : 0)));
    expect(swingConformance(notes, { division: div, swing }).conformant).toBe(true);
  });
  it("fails when notes are straight (no swing applied)", () => {
    const notes = Array.from({ length: 8 }, (_, s) => note(s, 42, s * div));
    expect(swingConformance(notes, { division: div, swing }).conformant).toBe(false);
  });
  it("is inconclusive with no off-beat notes to measure", () => {
    const notes = [note(0, 42, 0), note(1, 42, 1)]; // subs 0 and 2 — both even
    expect(swingConformance(notes, { division: div, swing }).inconclusive).toBe(true);
  });
});

describe("humanizeConformance — bounded, non-zero jitter; count + pitch preserved", () => {
  const before = [note(0, 60, 0, 90), note(1, 62, 1, 90), note(2, 64, 2, 90)];
  it("passes when notes jittered within the bound", () => {
    const after = [note(0, 60, 0.03, 96), note(1, 62, 0.98, 84), note(2, 64, 2.05, 92)];
    expect(humanizeConformance(before, after, { maxOffsetBeats: 0.125 }).conformant).toBe(true);
  });
  it("fails when a note moved MORE than the bound (sloppy, not humanized)", () => {
    const after = [note(0, 60, 0.3, 96), note(1, 62, 0.98, 84), note(2, 64, 2.05, 92)];
    expect(humanizeConformance(before, after, { maxOffsetBeats: 0.125 }).conformant).toBe(false);
  });
  it("fails when nothing changed (a no-op)", () => {
    expect(humanizeConformance(before, before, { maxOffsetBeats: 0.125 }).conformant).toBe(false);
  });
  it("is inconclusive when the note count changed (can't pair)", () => {
    expect(humanizeConformance(before, [...before, note(3, 65, 3)], { maxOffsetBeats: 0.125 }).inconclusive).toBe(true);
  });
});

describe("automationConformance — the param carries a directional curve", () => {
  const param = (points: { t: number; v: number }[]): PluginParam => ({ index: 1, name: "Frequency", value: 0.5, automated: points.length > 0, points });
  it("passes for a rising sweep (≥2 points, last > first)", () => {
    expect(automationConformance(param([{ t: 0, v: 0.2 }, { t: 4, v: 0.9 }]), { direction: "up" }).conformant).toBe(true);
  });
  it("fails when the direction is wrong", () => {
    expect(automationConformance(param([{ t: 0, v: 0.2 }, { t: 4, v: 0.9 }]), { direction: "down" }).conformant).toBe(false);
  });
  it("fails with no automation", () => {
    expect(automationConformance(param([]), { direction: "up" }).conformant).toBe(false);
  });
});

describe("sendConformance — the track routes to the bus", () => {
  const track = (sends: { bus: number; db: number; mute: boolean }[]): Track => ({ id: "t", index: 0, name: "Keys", type: "audio", clips: [], sends });
  it("passes when a send to the bus exists", () => {
    expect(sendConformance(track([{ bus: 0, db: -12, mute: false }]), { bus: 0 }).conformant).toBe(true);
  });
  it("checks the level when db is specified", () => {
    expect(sendConformance(track([{ bus: 0, db: -12, mute: false }]), { bus: 0, db: -12 }).conformant).toBe(true);
    expect(sendConformance(track([{ bus: 0, db: -3, mute: false }]), { bus: 0, db: -12 }).conformant).toBe(false);
  });
  it("fails when there is no send to the bus", () => {
    expect(sendConformance(track([]), { bus: 0 }).conformant).toBe(false);
  });
});
