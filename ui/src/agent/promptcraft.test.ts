import { describe, it, expect } from "vitest";
import { craftPrompt, allStyles, PROMPT_STYLES, type Brief } from "./promptcraft";

const BRIEF: Brief = {
  genre: "lo-fi hip-hop",
  bpm: 85,
  key: "A minor",
  instruments: ["dusty boom-bap drums", "warm Rhodes chords", "mellow sub bass"],
  mood: ["nostalgic", "mellow"],
  production: ["vinyl crackle", "tape saturation"],
  era: "90s",
  refs: ["J Dilla", "SP-1200"],
};

describe("promptcraft", () => {
  it("emits a non-empty prompt for every style", () => {
    for (const style of PROMPT_STYLES) {
      const p = craftPrompt(BRIEF, style);
      expect(p.length).toBeGreaterThan(8);
      expect(p).not.toMatch(/\s,|,,|\s{2,}/); // no formatting cruft
    }
  });

  it("tag style carries the load-bearing SA3 cues (genre, BPM, key, an instrument)", () => {
    const p = craftPrompt(BRIEF, "tag");
    expect(p).toContain("lo-fi hip-hop");
    expect(p).toContain("85 BPM");
    expect(p).toContain("A minor");
    expect(p.toLowerCase()).toContain("rhodes");
  });

  it("the four styles are genuinely different phrasings", () => {
    const ps = allStyles(BRIEF).map((s) => s.prompt);
    expect(new Set(ps).size).toBe(4);
  });

  it("reference style leans on era + refs", () => {
    const p = craftPrompt(BRIEF, "reference");
    expect(p).toContain("90s");
    expect(p).toMatch(/Dilla|SP-1200/);
  });

  it("stem focus isolates one element (drums) and drops the rest", () => {
    const p = craftPrompt({ ...BRIEF, stem: "drums" }, "tag");
    expect(p.toLowerCase()).toContain("drums");
    expect(p.toLowerCase()).not.toContain("rhodes");
    expect(p.toLowerCase()).not.toContain("sub bass");
  });

  it("degrades gracefully on a minimal brief", () => {
    const p = craftPrompt({ genre: "ambient" }, "descriptive");
    expect(p.toLowerCase()).toContain("ambient");
  });
});
