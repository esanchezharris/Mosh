import { describe, it, expect } from "vitest";
import { tokenize, scorePool, STOP } from "./scoring";

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumerics, drops stopwords and single chars", () => {
    expect(tokenize("The Beat Starts Strong, then thins out!")).toEqual([
      "beat", "starts", "strong", "thins",
    ]);
  });

  it("returns [] for empty/whitespace input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });

  it("every STOP word is actually dropped", () => {
    for (const w of STOP) expect(tokenize(w)).toEqual([]);
  });
});

type Item = { id: string; text: string };
const weightsOf = (i: Item): Map<string, number> => {
  const w = new Map<string, number>();
  for (const t of tokenize(i.text)) w.set(t, 1);
  return w;
};
const byId = (i: Item) => i.id;

describe("scorePool", () => {
  const pool: Item[] = [
    { id: "a", text: "kick and snare pattern" },
    { id: "b", text: "reverb send on the bus" },
    { id: "c", text: "kick drum only" },
  ];

  it("drops zero-overlap items", () => {
    const scored = scorePool("nothing relevant here whatsoever", pool, weightsOf, byId);
    expect(scored).toEqual([]);
  });

  it("returns [] for an empty query", () => {
    expect(scorePool("", pool, weightsOf, byId)).toEqual([]);
  });

  it("ranks by summed overlap score, highest first", () => {
    const scored = scorePool("kick pattern", pool, weightsOf, byId);
    // "a" overlaps kick+pattern (2), "c" overlaps kick only (1), "b" overlaps nothing.
    expect(scored.map((s) => s.item.id)).toEqual(["a", "c"]);
    expect(scored[0]!.score).toBe(2);
    expect(scored[1]!.score).toBe(1);
  });

  it("breaks ties deterministically by tieBreakKey", () => {
    const tied: Item[] = [
      { id: "z", text: "kick" },
      { id: "a", text: "kick" },
      { id: "m", text: "kick" },
    ];
    const scored = scorePool("kick", tied, weightsOf, byId);
    expect(scored.map((s) => s.item.id)).toEqual(["a", "m", "z"]);
  });

  it("respects a per-item weight map (not just presence)", () => {
    const weighted: Item[] = [
      { id: "low", text: "kick" },
      { id: "high", text: "kick" },
    ];
    const customWeights = (i: Item): Map<string, number> =>
      new Map([["kick", i.id === "high" ? 9 : 1]]);
    const scored = scorePool("kick", weighted, customWeights, byId);
    expect(scored.map((s) => s.item.id)).toEqual(["high", "low"]);
  });

  it("is deterministic across repeated calls", () => {
    const a = scorePool("kick pattern", pool, weightsOf, byId);
    const b = scorePool("kick pattern", pool, weightsOf, byId);
    expect(a).toEqual(b);
  });
});
