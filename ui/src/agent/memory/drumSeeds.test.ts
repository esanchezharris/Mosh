import { describe, expect, it } from "vitest";
import { DRUM_PATTERN_SEEDS } from "./drumSeeds";
import { isDrumPatternCard } from "./patternCards";
import { parseDrumPattern } from "../../ui/drumPatternUtil";

describe("DRUM_PATTERN_SEEDS", () => {
  it("has 4-6 tasteful seeds", () => {
    expect(DRUM_PATTERN_SEEDS.length).toBeGreaterThanOrEqual(4);
    expect(DRUM_PATTERN_SEEDS.length).toBeLessThanOrEqual(6);
  });

  it("every seed is a well-formed DrumPatternCard with source:'seed' and uses:0", () => {
    for (const s of DRUM_PATTERN_SEEDS) {
      expect(isDrumPatternCard(s)).toBe(true);
      expect(s.source).toBe("seed");
      expect(s.uses).toBe(0);
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.tags.length).toBeGreaterThan(0);
    }
  });

  it("every seed's pattern string is actually parseable by add_drum_pattern's own parser", () => {
    for (const s of DRUM_PATTERN_SEEDS) {
      const r = parseDrumPattern(s.pattern, s.stepsPerBar, 0, 100);
      if (!r.ok) throw new Error(`seed "${s.name}" failed to parse: ${r.error}`);
      expect(r.ok).toBe(true);
      expect(r.stepsPerBar).toBe(s.stepsPerBar);
      expect(r.bars).toBe(s.bars);
      expect(r.steps.length).toBeGreaterThan(0); // no accidental all-rest seed
    }
  });

  it("every seed has a plausible bpmRange (low < high, both positive)", () => {
    for (const s of DRUM_PATTERN_SEEDS) {
      expect(s.bpmRange).toBeDefined();
      const [lo, hi] = s.bpmRange!;
      expect(lo).toBeGreaterThan(0);
      expect(hi).toBeGreaterThan(lo);
    }
  });

  it("seed names are unique", () => {
    const names = DRUM_PATTERN_SEEDS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("covers a genre spread (not 6 variations on one style)", () => {
    const allTags = new Set(DRUM_PATTERN_SEEDS.flatMap((s) => s.tags));
    // sanity: several distinct genre-ish tags across the set, not one repeated tag
    expect(allTags.size).toBeGreaterThanOrEqual(DRUM_PATTERN_SEEDS.length);
  });
});
