import { describe, it, expect } from "vitest";
import { tokenSetScore, levenshtein } from "./fuzzy";

describe("levenshtein", () => {
  it("is 0 for equal strings and grows with edits", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("abc", "abd")).toBe(1);
    expect(levenshtein("", "abc")).toBe(3);
  });
});

describe("tokenSetScore — order-independent, filler/subset tolerant", () => {
  it("scores an exact token set 1", () => {
    expect(tokenSetScore("keep that take", "keep that take")).toBe(1);
  });
  it("scores a phrase whose tokens are a subset of the utterance highly", () => {
    expect(tokenSetScore("okay keep that take", "keep that take")).toBeGreaterThan(0.9);
  });
  it("is token-order independent", () => {
    expect(tokenSetScore("take that keep", "keep that take")).toBeGreaterThan(0.9);
  });
  it("tolerates a one-character STT slip", () => {
    expect(tokenSetScore("keep that takes", "keep that take")).toBeGreaterThan(0.8);
  });
  it("scores unrelated text low", () => {
    expect(tokenSetScore("play the drums louder", "keep that take")).toBeLessThan(0.5);
  });
  it("returns 0 against an empty phrase", () => {
    expect(tokenSetScore("anything", "")).toBe(0);
  });
});
