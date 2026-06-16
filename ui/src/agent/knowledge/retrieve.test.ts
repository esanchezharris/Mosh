import { describe, it, expect } from "vitest";
import { retrieveCards } from "./retrieve";
import { VALIDATED_CARDS } from "./cards.data";
import type { TechniqueCard } from "./card";

const card = (over: Partial<TechniqueCard>): TechniqueCard => ({
  id: "x", source: "distill", skill_name: "s", task_type: "prompt_craft",
  genre_context: [], producer_intent: "", when: "", recipe: { kind: "prompt", guidance: "g" },
  evidence: [], confidence: 0.5, status: "validated", ...over,
});

const cards: TechniqueCard[] = [
  card({ id: "lofi", genre_context: ["lo-fi hip-hop", "boom-bap"], when: "generating a lo-fi beat", skill_name: "lo-fi recipe", confidence: 0.8 }),
  card({ id: "drill", genre_context: ["drill", "trap"], when: "generating a drill beat", skill_name: "drill recipe", confidence: 0.7 }),
  card({ id: "cand", genre_context: ["lo-fi hip-hop"], when: "lo-fi", skill_name: "unproven", status: "candidate" }),
];

describe("retrieveCards", () => {
  it("matches the right genre for a request", () => {
    const r = retrieveCards("make me a lo-fi hip-hop beat", 3, cards);
    expect(r.map((c) => c.id)).toContain("lofi");
    expect(r.map((c) => c.id)).not.toContain("drill");
  });
  it("never returns non-validated (candidate) cards", () => {
    expect(retrieveCards("lo-fi", 5, cards).map((c) => c.id)).not.toContain("cand");
  });
  it("returns nothing for an unrelated request", () => {
    expect(retrieveCards("set the master volume to -6 dB", 3, cards)).toEqual([]);
  });
  it("returns nothing for an empty query", () => {
    expect(retrieveCards("", 3, cards)).toEqual([]);
  });
  it("respects the top-K cap", () => {
    expect(retrieveCards("lo-fi drill beat", 1, cards).length).toBeLessThanOrEqual(1);
  });
  it("the shipped seed KB surfaces for a lo-fi request", () => {
    expect(retrieveCards("can you make a lofi beat", 3, VALIDATED_CARDS).length).toBeGreaterThan(0);
  });
  it("is robust to hyphenation: a card tagged only 'lo-fi hip-hop' matches 'lofi'/'lo-fi'", () => {
    const c = [card({ id: "h", genre_context: ["lo-fi hip-hop"], when: "generating a beat", skill_name: "x" })];
    expect(retrieveCards("make a lofi beat", 3, c).map((x) => x.id)).toContain("h");
    expect(retrieveCards("a lo-fi thing", 3, c).map((x) => x.id)).toContain("h");
    expect(retrieveCards("a techno thing", 3, c)).toEqual([]);
  });
});
