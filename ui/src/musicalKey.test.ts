import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  TONICS,
  MODES,
  NOTE_PC,
  SCALES,
  DEFAULT_KEY,
  pitchClass,
  noteName,
  resolveKey,
  scaleMask,
  inScale,
  snapToScale,
  keyLabel,
  isMode,
  type Mode,
} from "./musicalKey";

// ── the lockstep golden ──────────────────────────────────────────────────────
// musicalKey.ts claims to mirror ui/src/vendor/voice.js. Parse the vendored file
// and prove it, so a voice.js update can't silently desync the piano roll's
// shading/snapping from the earcons Moshi sings.

const here = dirname(fileURLToPath(import.meta.url)); // ui/src
const VOICE_PATH = resolve(here, "vendor/voice.js");

function vendorLiteral(name: string): Record<string, unknown> {
  const src = readFileSync(VOICE_PATH, "utf8");
  const start = src.indexOf(`const ${name} = {`);
  expect(start, `voice.js must declare ${name}`).toBeGreaterThan(-1);
  const open = src.indexOf("{", start);
  const close = src.indexOf("};", open);
  expect(close, `voice.js ${name} must terminate`).toBeGreaterThan(open);
  const literal = src.slice(open, close + 1);
  return Function(`"use strict"; return (${literal});`)() as Record<string, unknown>;
}

describe("lockstep with vendor/voice.js", () => {
  it("NOTE_PC matches voice.js exactly", () => {
    expect(NOTE_PC).toEqual(vendorLiteral("NOTE_PC"));
  });

  it("SCALES matches voice.js exactly", () => {
    const vendor = vendorLiteral("SCALES");
    // Same modes, same intervals, same order — no extra or missing scale.
    expect(Object.keys(SCALES).sort()).toEqual(Object.keys(vendor).sort());
    for (const [mode, intervals] of Object.entries(vendor)) {
      expect(SCALES[mode as Mode], `scale ${mode}`).toEqual(intervals);
    }
  });

  it("MODES is exactly the SCALES keys (the set_key domain the backend validates)", () => {
    expect([...MODES].sort()).toEqual(Object.keys(SCALES).sort());
  });

  it("every TONIC is a valid NOTE_PC spelling, one per pitch class", () => {
    expect(TONICS).toHaveLength(12);
    expect(TONICS.map((t) => NOTE_PC[t])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("the default key is a valid tonic + mode", () => {
    expect(NOTE_PC[DEFAULT_KEY.tonic]).toBe(9);
    expect(isMode(DEFAULT_KEY.mode)).toBe(true);
  });
});

describe("pitchClass / noteName", () => {
  it("wraps into 0..11 including negatives", () => {
    expect(pitchClass(60)).toBe(0);
    expect(pitchClass(61)).toBe(1);
    expect(pitchClass(-1)).toBe(11);
    expect(pitchClass(-13)).toBe(11);
  });

  it("names pitches on the MIDI-60-is-C4 convention", () => {
    expect(noteName(60)).toBe("C4");
    expect(noteName(61)).toBe("C#4");
    expect(noteName(0)).toBe("C-1");
    expect(noteName(127)).toBe("G9");
    expect(noteName(69)).toBe("A4"); // A440
  });
});

describe("resolveKey", () => {
  it("resolves a normal key", () => {
    expect(resolveKey({ tonic: "F#", mode: "dorian" })).toEqual({ tonic: 6, mode: "dorian" });
  });

  it("accepts flat enharmonic spellings from voice.js NOTE_PC", () => {
    expect(resolveKey({ tonic: "Db", mode: "major" }).tonic).toBe(1);
    expect(resolveKey({ tonic: "Bb", mode: "major" }).tonic).toBe(10);
  });

  it("falls back to the backend default rather than throwing", () => {
    expect(resolveKey(undefined)).toEqual({ tonic: 9, mode: "minor" });
    expect(resolveKey({})).toEqual({ tonic: 9, mode: "minor" });
    expect(resolveKey({ tonic: "H", mode: "lydian" })).toEqual({ tonic: 9, mode: "minor" });
  });
});

describe("scaleMask / inScale", () => {
  it("A minor is the white keys", () => {
    const mask = scaleMask({ tonic: 9, mode: "minor" });
    const members = mask.map((v, pc) => (v ? pc : -1)).filter((pc) => pc >= 0);
    expect(members).toEqual([0, 2, 4, 5, 7, 9, 11]); // C D E F G A B
  });

  it("C major is the white keys too, and excludes every black key", () => {
    const mask = scaleMask({ tonic: 0, mode: "major" });
    expect([0, 2, 4, 5, 7, 9, 11].every((pc) => mask[pc])).toBe(true);
    expect([1, 3, 6, 8, 10].some((pc) => mask[pc])).toBe(false);
  });

  it("chromatic admits everything", () => {
    const mask = scaleMask({ tonic: 4, mode: "chromatic" });
    expect(mask.every(Boolean)).toBe(true);
  });

  it("pentatonic is the 5-note minor pentatonic", () => {
    const mask = scaleMask({ tonic: 0, mode: "pentatonic" });
    expect(mask.filter(Boolean)).toHaveLength(5);
    expect([0, 3, 5, 7, 10].every((pc) => mask[pc])).toBe(true);
  });

  it("inScale reads the mask across octaves", () => {
    const mask = scaleMask({ tonic: 0, mode: "major" });
    expect(inScale(60, mask)).toBe(true); // C4
    expect(inScale(72, mask)).toBe(true); // C5
    expect(inScale(61, mask)).toBe(false); // C#4
  });
});

describe("snapToScale", () => {
  const cMajor = scaleMask({ tonic: 0, mode: "major" });

  it("leaves in-scale pitches untouched", () => {
    for (const p of [60, 62, 64, 65, 67, 69, 71, 72]) {
      expect(snapToScale(p, cMajor)).toBe(p);
    }
  });

  it("resolves a semitone tie DOWNWARD so the result never depends on drag direction", () => {
    // C# sits one semitone from both C and D; F# from both F and G.
    expect(snapToScale(61, cMajor)).toBe(60);
    expect(snapToScale(66, cMajor)).toBe(65);
    expect(snapToScale(63, cMajor)).toBe(62);
  });

  it("is idempotent — snapping an already-snapped pitch is a no-op", () => {
    for (let p = 0; p <= 127; p++) {
      const once = snapToScale(p, cMajor);
      expect(snapToScale(once, cMajor)).toBe(once);
    }
  });

  it("never leaves the MIDI range, and always lands in scale", () => {
    for (const mode of MODES) {
      for (let tonic = 0; tonic < 12; tonic++) {
        const mask = scaleMask({ tonic, mode });
        for (let p = -20; p <= 150; p++) {
          const s = snapToScale(p, mask);
          expect(s).toBeGreaterThanOrEqual(0);
          expect(s).toBeLessThanOrEqual(127);
          expect(inScale(s, mask)).toBe(true);
        }
      }
    }
  });

  it("snaps upward when the lower neighbour is off the bottom of the range", () => {
    const dMajor = scaleMask({ tonic: 2, mode: "major" }); // pc 0 (C natural) is out
    expect(snapToScale(0, dMajor)).toBe(1); // C-1 → C#-1, since -1 does not exist
  });

  it("snaps downward when the upper neighbour is off the top of the range", () => {
    // 127 is G9 (pc 7). In C# major (pcs 1,3,5,6,8,10,0) pc 7 is out and the
    // nearest tone above would be 128, which does not exist — resolve downward.
    const csMajor = scaleMask({ tonic: 1, mode: "major" });
    expect(inScale(127, csMajor)).toBe(false);
    expect(snapToScale(127, csMajor)).toBe(126);
  });

  it("is a no-op for a chromatic key", () => {
    const chrom = scaleMask({ tonic: 0, mode: "chromatic" });
    for (let p = 0; p <= 127; p++) expect(snapToScale(p, chrom)).toBe(p);
  });

  it("rounds fractional pitches before snapping", () => {
    expect(snapToScale(60.4, cMajor)).toBe(60);
    expect(snapToScale(61.6, cMajor)).toBe(62); // rounds to 62 (D), already in scale
  });

  it("degenerate all-false mask behaves chromatically instead of inventing a pitch", () => {
    const dead = new Array<boolean>(12).fill(false);
    expect(snapToScale(64, dead)).toBe(64);
  });
});

describe("keyLabel", () => {
  it("reads as a producer would say it", () => {
    expect(keyLabel({ tonic: "F#", mode: "minor" })).toBe("F# minor");
    expect(keyLabel({})).toBe("A minor");
  });
});
