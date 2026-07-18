// CONF-EXPORT-SECTION: section (beats) → export range (seconds) resolution.

import { describe, expect, it } from "vitest";
import { resolveSectionExportRange } from "./exportSection";
import type { Section } from "./types";

function section(overrides: Partial<Section> = {}): Section {
  return { id: "s1", name: "Hook", startBeat: 16, endBeat: 32, ...overrides };
}

describe("resolveSectionExportRange", () => {
  it("converts beats to seconds at 120bpm/4-4 (the default meter)", () => {
    const r = resolveSectionExportRange(section({ startBeat: 16, endBeat: 32 }), { tempo: 120 });
    // 60/120 = 0.5s/beat -> 8s .. 16s
    expect(r).toEqual({ start: 8, end: 16 });
  });

  it("scales with tempo (90bpm)", () => {
    const r = resolveSectionExportRange(section({ startBeat: 4, endBeat: 8 }), { tempo: 90 });
    // 60/90 = 0.6667s/beat -> 2.667s .. 5.333s
    expect(r!.start).toBeCloseTo(2.6667, 3);
    expect(r!.end).toBeCloseTo(5.3333, 3);
  });

  it("accounts for the time-signature denominator (x/8 halves the beat length vs x/4)", () => {
    const r48 = resolveSectionExportRange(section({ startBeat: 8, endBeat: 16 }), { tempo: 120, timeSigDenominator: 8 });
    // den:8 -> beatSeconds = (4/8)*(60/120) = 0.25s/beat -> 2s .. 4s
    expect(r48).toEqual({ start: 2, end: 4 });
  });

  it("defaults to 120bpm / 4/4 when the session is missing/incomplete", () => {
    const r = resolveSectionExportRange(section({ startBeat: 4, endBeat: 8 }));
    expect(r).toEqual({ start: 2, end: 4 });
  });

  it("returns null for an undefined section (caller falls back to full-mix)", () => {
    expect(resolveSectionExportRange(undefined, { tempo: 120 })).toBeNull();
  });
});
