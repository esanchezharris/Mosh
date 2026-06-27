import { describe, it, expect } from "vitest";
import {
  syllablesForWord,
  countSyllables,
  parseSeed,
  gridTarget,
  flowStatus,
} from "./flowMeter";

// The live flow meter does an INSTANT, local (no round-trip) syllable estimate so the
// producer sees "does this fit the beat" as they type. It mirrors the service's stdlib
// vowel-group heuristic (service/phonology/core.py::heuristic_syllables) so the live
// meter agrees with the precise backend on the common case.
describe("syllablesForWord (vowel-group heuristic, matches the Python core)", () => {
  it("counts a single vowel group as one syllable", () => {
    expect(syllablesForWord("beat")).toBe(1);
  });
  it("counts two vowel groups", () => {
    expect(syllablesForWord("rapping")).toBe(2);
    expect(syllablesForWord("hello")).toBe(2);
  });
  it("treats a trailing y as a vowel", () => {
    expect(syllablesForWord("money")).toBe(2);
  });
  it("drops a silent trailing e but keeps -le", () => {
    expect(syllablesForWord("came")).toBe(1); // a, e -> 2, minus silent e -> 1
    expect(syllablesForWord("table")).toBe(2); // -le stays
  });
  it("clamps a no-vowel token to 1 and an empty token to 0", () => {
    expect(syllablesForWord("skrt")).toBe(1);
    expect(syllablesForWord("")).toBe(0);
  });
});

describe("countSyllables (sum over the words in a line)", () => {
  it("sums word syllables across a line", () => {
    // yeah(1) I(1) came(1) back(1) = 4
    expect(countSyllables("yeah I came back")).toBe(4);
  });
  it("ignores gap markers and punctuation", () => {
    expect(countSyllables("yeah I came back ___ ___ the ___")).toBe(
      countSyllables("yeah I came back the"),
    );
  });
  it("is 0 for empty / whitespace", () => {
    expect(countSyllables("")).toBe(0);
    expect(countSyllables("   ")).toBe(0);
  });
});

describe("parseSeed (tokenize a seed line, mark ___ gaps)", () => {
  it("splits words and gaps", () => {
    const r = parseSeed("yeah I came back ___ ___ the ___");
    expect(r.tokens).toHaveLength(8);
    expect(r.gaps).toBe(3);
    expect(r.words).toBe(5);
    expect(r.tokens[4].gap).toBe(true);
    expect(r.tokens[0].gap).toBe(false);
    expect(r.tokens[0].text).toBe("yeah");
  });
  it("treats a run of 2+ underscores as a single gap", () => {
    const r = parseSeed("hold the _____ down");
    expect(r.gaps).toBe(1);
    expect(r.words).toBe(3);
  });
  it("handles an empty seed", () => {
    const r = parseSeed("");
    expect(r.tokens).toHaveLength(0);
    expect(r.gaps).toBe(0);
  });
});

describe("gridTarget (default syllable target from the beat grid)", () => {
  it("derives slots-per-bar from the subdivision", () => {
    expect(gridTarget("1/16", 1)).toBe(16);
    expect(gridTarget("1/8", 1)).toBe(8);
    expect(gridTarget("1/4", 1)).toBe(4);
  });
  it("scales by bars", () => {
    expect(gridTarget("1/4", 2)).toBe(8);
  });
  it("defaults to 1 bar and falls back to 16ths on an unknown grid", () => {
    expect(gridTarget("1/16")).toBe(16);
    expect(gridTarget("weird")).toBe(16);
  });
});

describe("flowStatus (does the line fit the target within tolerance)", () => {
  it("is 'ok' inside tolerance", () => {
    expect(flowStatus(9, 9, 1)).toBe("ok");
    expect(flowStatus(8, 9, 1)).toBe("ok");
  });
  it("is 'under' below tolerance and 'over' above", () => {
    expect(flowStatus(7, 9, 1)).toBe("under");
    expect(flowStatus(11, 9, 1)).toBe("over");
  });
  it("is 'ok' when there is no target (0)", () => {
    expect(flowStatus(5, 0, 1)).toBe("ok");
  });
});
