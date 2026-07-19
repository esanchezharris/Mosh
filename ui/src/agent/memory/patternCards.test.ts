import { describe, expect, it } from "vitest";
import {
  isDrumPatternCard, isLyricFrameworkCard, validateNoLyricText,
  buildLyricFrameworkCard, buildDrumPatternCard,
  summarizeDrumPatternCard, summarizeLyricFrameworkCard,
  type DrumPatternCard, type LyricFrameworkCard,
} from "./patternCards";
import type { LyricLine } from "../../types";
import { parseDrumPattern } from "../../ui/drumPatternUtil";

const line = (over: Partial<LyricLine>): LyricLine => ({
  index: 0, role: "verse", seedText: "", text: "", syllableTarget: 8, syllableTol: 1,
  stress: "xXxxxXxx", rhymeGroup: "A", rhymeStrictness: "", locked: false, sectionId: "",
  status: "seed", ...over,
});

describe("isDrumPatternCard / isLyricFrameworkCard", () => {
  it("recognizes a well-formed DrumPatternCard", () => {
    const card: DrumPatternCard = { name: "x", pattern: "kick: x...", stepsPerBar: 16, bars: 1, tags: [], source: "seed", uses: 0 };
    expect(isDrumPatternCard(card)).toBe(true);
    expect(isLyricFrameworkCard(card)).toBe(false);
  });

  it("recognizes a well-formed LyricFrameworkCard", () => {
    const card: LyricFrameworkCard = { name: "x", grid: "1/16", rhymeStrictness: "slant", frame: [], tags: [], source: "seed", uses: 0 };
    expect(isLyricFrameworkCard(card)).toBe(true);
    expect(isDrumPatternCard(card)).toBe(false);
  });

  it("rejects strings, null, arrays, and plain unrelated objects", () => {
    for (const bad of ["kick: x...", null, undefined, [], {}, { foo: "bar" }]) {
      expect(isDrumPatternCard(bad)).toBe(false);
      expect(isLyricFrameworkCard(bad)).toBe(false);
    }
  });
});

describe("validateNoLyricText — the style-corpus safety wall", () => {
  it("accepts a well-formed LyricFrameworkCard", () => {
    const card = buildLyricFrameworkCard({ grid: "1/16", rhymeStrictness: "slant", lines: [line({})] }, "Punchy AABB");
    expect(validateNoLyricText(card)).toEqual({ ok: true });
  });

  it("rejects a top-level 'text' field", () => {
    expect(validateNoLyricText({ name: "x", text: "some actual lyrics here" }).ok).toBe(false);
  });

  it("rejects a top-level 'lines' field (a raw sheet, not a framework)", () => {
    expect(validateNoLyricText({ name: "x", lines: [{ text: "verse one" }] }).ok).toBe(false);
  });

  it("rejects a 'text' field nested inside a frame entry", () => {
    const sneaky = { name: "x", frame: [{ role: "verse", syllables: 8, stress: "x", rhyme: "A", text: "leaked lyrics" }] };
    expect(validateNoLyricText(sneaky).ok).toBe(false);
  });

  it("names the rejection reason", () => {
    const r = validateNoLyricText({ text: "leak" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toContain("lyric text");
  });

  it("accepts primitives and non-object items (nothing to leak)", () => {
    expect(validateNoLyricText("just a string").ok).toBe(true);
    expect(validateNoLyricText(42).ok).toBe(true);
    expect(validateNoLyricText(null).ok).toBe(true);
  });
});

describe("buildLyricFrameworkCard", () => {
  it("derives structure-only fields, in sheet-index order, never text", () => {
    const sheet = {
      grid: "1/16", rhymeStrictness: "slant",
      lines: [
        line({ index: 1, role: "verse", syllableTarget: 9, stress: "xXxxxXxxx", rhymeGroup: "B", text: "should never appear" }),
        line({ index: 0, role: "verse", syllableTarget: 8, stress: "xXxxxXxx", rhymeGroup: "A", text: "nor this" }),
      ],
    };
    const card = buildLyricFrameworkCard(sheet, "Verse pair", ["boom-bap-adjacent"]);
    expect(card.name).toBe("Verse pair");
    expect(card.grid).toBe("1/16");
    expect(card.rhymeStrictness).toBe("slant");
    expect(card.tags).toEqual(["boom-bap-adjacent"]);
    expect(card.source).toBe("saved");
    expect(card.uses).toBe(0);
    // ordered by sheet INDEX, not array/insertion order
    expect(card.frame).toEqual([
      { role: "verse", syllables: 8, stress: "xXxxxXxx", rhyme: "A" },
      { role: "verse", syllables: 9, stress: "xXxxxXxxx", rhyme: "B" },
    ]);
    expect(JSON.stringify(card)).not.toContain("should never appear");
    expect(JSON.stringify(card)).not.toContain("nor this");
    expect(validateNoLyricText(card)).toEqual({ ok: true }); // built cards always pass the wall
  });

  it("derives a rhyme-scheme letter scheme (AABB) from rhymeGroup identity, not spelling", () => {
    const sheet = {
      grid: "1/8", rhymeStrictness: "perfect",
      lines: [
        line({ index: 0, rhymeGroup: "flame-group" }),
        line({ index: 1, rhymeGroup: "flame-group" }),
        line({ index: 2, rhymeGroup: "night-group" }),
        line({ index: 3, rhymeGroup: "night-group" }),
      ],
    };
    const card = buildLyricFrameworkCard(sheet, "AABB");
    expect(card.frame.map((l) => l.rhyme)).toEqual(["A", "A", "B", "B"]);
  });

  it("an empty/blank rhymeGroup renders as '-' (no constraint), not a new letter", () => {
    const sheet = {
      grid: "1/8", rhymeStrictness: "free",
      lines: [line({ index: 0, rhymeGroup: "" }), line({ index: 1, rhymeGroup: "A" })],
    };
    const card = buildLyricFrameworkCard(sheet, "Free bar + A");
    expect(card.frame[0].rhyme).toBe("-");
    expect(card.frame[1].rhyme).toBe("A");
  });

  it("defaults tags to an empty array when omitted", () => {
    const card = buildLyricFrameworkCard({ grid: "1/16", rhymeStrictness: "slant", lines: [] }, "empty");
    expect(card.tags).toEqual([]);
    expect(card.frame).toEqual([]);
  });
});

describe("buildDrumPatternCard", () => {
  it("derives a verbatim, re-parseable pattern + metadata", () => {
    const parsed = parseDrumPattern({ kick: "x...x...x...x...", hat: "x.x.x.x.x.x.x.x." }, 16, 0, 100);
    if (!parsed.ok) throw new Error(parsed.error);
    const card = buildDrumPatternCard(parsed, "Boom-ish", ["boom-bap"], [85, 95]);
    expect(card.name).toBe("Boom-ish");
    expect(card.stepsPerBar).toBe(16);
    expect(card.bars).toBe(1);
    expect(card.tags).toEqual(["boom-bap"]);
    expect(card.bpmRange).toEqual([85, 95]);
    expect(card.source).toBe("saved");
    expect(card.uses).toBe(0);
    const reparsed = parseDrumPattern(card.pattern, card.stepsPerBar, 0, 100);
    if (!reparsed.ok) throw new Error(reparsed.error);
    expect(reparsed.steps).toEqual(parsed.steps);
    expect(isDrumPatternCard(card)).toBe(true);
  });

  it("bpmRange defaults to undefined (an unknown-tempo saved pattern is still valid)", () => {
    const parsed = parseDrumPattern({ kick: "x..." }, 4, 0, 100);
    if (!parsed.ok) throw new Error(parsed.error);
    const card = buildDrumPatternCard(parsed, "no bpm");
    expect(card.bpmRange).toBeUndefined();
    expect(card.tags).toEqual([]);
  });
});

// AGT-MEM (M4) — panel-facing summaries. The concrete regression these guard: the M3
// memory panel (TopbarTools.tsx) predates these card shapes and originally fell back to
// raw JSON.stringify for ANY object item — caught by pattern-library.spec.ts's e2e test
// actually reading the panel, not by a unit test (nothing here would have caught a
// panel-side wiring gap; these only prove the SUMMARY TEXT itself is sane).
describe("summarizeDrumPatternCard / summarizeLyricFrameworkCard — panel display text", () => {
  it("a drum pattern summary includes the verbatim pattern string and bar/step/bpm metadata", () => {
    const parsed = parseDrumPattern({ kick: "x...x...x...x...", snare: "....x.......x..." }, 16, 0, 100);
    if (!parsed.ok) throw new Error(parsed.error);
    const card = buildDrumPatternCard(parsed, "Boom-ish", ["boom-bap"], [85, 95]);
    const s = summarizeDrumPatternCard(card);
    expect(s).toContain("1 bar @ 16/bar");
    expect(s).toContain("85-95 bpm");
    expect(s).toContain(card.pattern); // verbatim, not truncated
  });

  it("pluralizes 'bars' correctly and omits bpm when unset", () => {
    const parsed = parseDrumPattern({ kick: "x...x...x...x...x...x...x...x..." }, 16, 0, 100); // 2 bars
    if (!parsed.ok) throw new Error(parsed.error);
    const card = buildDrumPatternCard(parsed, "no bpm");
    const s = summarizeDrumPatternCard(card);
    expect(s).toContain("2 bars @ 16/bar");
    expect(s).not.toContain("bpm");
  });

  it("a lyric framework summary shows the grid, rhyme strictness, and per-line role/syllables/rhyme — never raw JSON", () => {
    const card = buildLyricFrameworkCard(
      { grid: "1/16", rhymeStrictness: "slant", lines: [line({ index: 0, role: "verse", syllableTarget: 8, rhymeGroup: "A" })] },
      "AABB",
    );
    const s = summarizeLyricFrameworkCard(card);
    expect(s).toContain("grid 1/16");
    expect(s).toContain("slant rhyme");
    expect(s).toContain("verse(8)/A");
    expect(s).not.toContain("{"); // never raw JSON
  });
});
