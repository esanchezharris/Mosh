import { describe, it, expect } from "vitest";
import { describeTuner, formatCents, noteName, tunerKey, tunerView } from "./tuner";

const cents = (hz: number, c: number) => hz * 2 ** (c / 1200);

describe("noteName", () => {
  it("names notes with their octave, A4 = 440 Hz", () => {
    expect(noteName(440)).toBe("A4");
    expect(noteName(220)).toBe("A3");
    expect(noteName(261.63)).toBe("C4");
    expect(noteName(246.94)).toBe("B3");     // the octave changes at C, not at A
    expect(noteName(233.08)).toBe("A#3");
  });

  it("gives the nearest note to an off-pitch frequency", () => {
    expect(noteName(cents(220, 40))).toBe("A3");
    expect(noteName(cents(220, 60))).toBe("A#3");
    expect(noteName(cents(220, -60))).toBe("G#3");
  });

  it("has no name for silence or nonsense", () => {
    expect(noteName(0)).toBeNull();
    expect(noteName(-5)).toBeNull();
    expect(noteName(Number.NaN)).toBeNull();
    expect(noteName(1e9)).toBeNull();
  });
});

describe("tunerView", () => {
  it("reads a slightly sharp A3 being pulled to A3", () => {
    const v = tunerView({ inputHz: cents(220, 23), targetHz: 220 })!;
    expect(v).toMatchObject({ heard: "A3", target: "A3", cents: 23, inTune: false });
    expect(v.position).toBeCloseTo(0.5 + 23 / 200, 6);
  });

  it("measures the offset against the TARGET, which the scale can put a note away", () => {
    // 60 cents under B3 is nearer A#3, but in A major the tuner pulls it up to B3.
    const v = tunerView({ inputHz: cents(246.94, -60), targetHz: 246.94 })!;
    expect(v).toMatchObject({ heard: "A#3", target: "B3", cents: -60 });
    expect(v.position).toBeCloseTo(0.2, 6);
  });

  it("calls it in tune within five cents, and never shows minus zero", () => {
    expect(tunerView({ inputHz: cents(220, 4), targetHz: 220 })!.inTune).toBe(true);
    expect(tunerView({ inputHz: cents(220, -6), targetHz: 220 })!.inTune).toBe(false);
    const flatHair = tunerView({ inputHz: cents(220, -0.3), targetHz: 220 })!;
    expect(Object.is(flatHair.cents, -0)).toBe(false);
    expect(flatHair.cents).toBe(0);
  });

  it("keeps the needle on the scale for a pitch far from the target", () => {
    expect(tunerView({ inputHz: cents(220, 250), targetHz: 220 })!.position).toBe(1);
    expect(tunerView({ inputHz: cents(220, -250), targetHz: 220 })!.position).toBe(0);
  });

  it("shows nothing without a pitch and a target", () => {
    expect(tunerView(undefined)).toBeNull();
    expect(tunerView(null)).toBeNull();
    expect(tunerView({ inputHz: 0, targetHz: 220 })).toBeNull();
    expect(tunerView({ inputHz: 220, targetHz: 0 })).toBeNull();
  });
});

describe("formatCents / describeTuner / tunerKey", () => {
  it("signs sharp, leaves flat and zero as they are", () => {
    expect(formatCents(23)).toBe("+23 c");
    expect(formatCents(-8)).toBe("-8 c");
    expect(formatCents(0)).toBe("0 c");
  });

  it("says the display in words", () => {
    expect(describeTuner(tunerView({ inputHz: cents(220, 23), targetHz: 220 })))
      .toBe("Live pitch: singing A3, 23 cents sharp, pulling to A3");
    expect(describeTuner(tunerView({ inputHz: cents(220, -8), targetHz: 220 })))
      .toBe("Live pitch: singing A3, 8 cents flat, pulling to A3");
    expect(describeTuner(tunerView({ inputHz: 220, targetHz: 220 }))).toBe("Live pitch: singing A3, in tune, pulling to A3");
    expect(describeTuner(null)).toBe("Live pitch: no note");
  });

  it("keys a tuner by its track and chain position", () => {
    expect(tunerKey("1013", 2)).toBe("1013:2");
  });
});
