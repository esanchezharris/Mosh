import { describe, it, expect } from "vitest";
import {
  retrieveContext,
  rankMemoryEntries,
  renderMemorySection,
  MEMORY_BUDGET_BYTES,
  type MemoryRecord,
  type MemoryPools,
} from "./retrieveContext";
import type { KnowledgeCard } from "../knowledge";

const rec = (item: unknown, ts = 1, kind = "preference", explicit = false): MemoryRecord => ({
  ts, kind, explicit, item,
});

describe("retrieveContext: empty inputs", () => {
  it("returns \"\" for an empty query and empty pools", () => {
    expect(retrieveContext("", {})).toBe("");
    expect(retrieveContext("kick pattern", {})).toBe("");
  });

  it("returns \"\" when nothing in the pools overlaps the query and there are no notes", () => {
    const pools: MemoryPools = { preferences: [rec("loves wide low end")] };
    expect(retrieveContext("completely unrelated words about nothing", pools)).toBe("");
  });
});

describe("rankMemoryEntries: pool weights 3/2/1 (knowledge/preference/pattern)", () => {
  // Same scoreable text ("kick pattern") in all three pools — token-overlap score is
  // identical before pool weighting, so the ranking order is a direct, unambiguous
  // proof of the 3 > 2 > 1 pool-weight ordering.
  const card: KnowledgeCard = {
    id: "k1", topic: "t", maps_to: "kick pattern", plain: "kick pattern basics",
    when: "kick pattern basics", tags: ["kick", "pattern"],
  };
  const pref = rec("kick pattern preference", 1, "preference");
  const patt = rec("kick pattern habit", 2, "drum_pattern");

  it("ranks knowledge > preference > pattern when token overlap is equal", () => {
    const ranked = rankMemoryEntries("kick pattern", {
      knowledge: [card],
      preferences: [pref],
      patterns: [patt],
    });
    expect(ranked.map((r) => r.pool)).toEqual(["knowledge", "preference", "pattern"]);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
    expect(ranked[1]!.score).toBeGreaterThan(ranked[2]!.score);
  });

  it("a strongly-matching pattern can still outrank a weakly-matching knowledge card", () => {
    // The pool weight is a multiplier, not an absolute floor: "kick" only appears in
    // weakCard's LOWEST-tier fields (plain/when, internal weight 1) -> 1 * pool-weight
    // 3 = 3. strongPattern overlaps FOUR query tokens at flat weight 1 * pool-weight
    // 1 = 4 total. 4 > 3, so more raw overlap in the lower-weight pool wins.
    const weakCard: KnowledgeCard = {
      id: "k2", topic: "unrelated topic", maps_to: "unrelated_target",
      plain: "kick is mentioned only here in passing", when: "kick comes up rarely",
      tags: ["something", "else"],
    };
    const strongPattern = rec("kick snare hat pattern all four here", 3, "drum_pattern");
    const ranked = rankMemoryEntries("kick snare hat pattern", {
      knowledge: [weakCard],
      patterns: [strongPattern],
    });
    expect(ranked[0]!.pool).toBe("pattern");
  });

  it("is deterministic and ties break by id", () => {
    const a = rankMemoryEntries("kick pattern", { knowledge: [card], preferences: [pref], patterns: [patt] });
    const b = rankMemoryEntries("kick pattern", { knowledge: [card], preferences: [pref], patterns: [patt] });
    expect(a).toEqual(b);
  });

  it("drops zero-overlap entries", () => {
    const ranked = rankMemoryEntries("nothing at all relevant", { preferences: [pref], patterns: [patt] });
    expect(ranked).toEqual([]);
  });
});

describe("renderMemorySection: project notes are UNSCORED and always first", () => {
  it("includes a project note even when the query matches nothing else", () => {
    const notes = [rec("verse 2 needs a bigger lift", 1, "note")];
    const section = renderMemorySection(notes, []);
    expect(section).toContain("verse 2 needs a bigger lift");
    expect(section).toContain("(this project)");
  });

  it("puts project notes before any ranked (scored) entries", () => {
    const notes = [rec("always keep the bridge short", 1, "note")];
    const ranked = rankMemoryEntries("kick pattern", {
      patterns: [rec("kick pattern habit", 2, "drum_pattern")],
    });
    const section = renderMemorySection(notes, ranked);
    expect(section.indexOf("always keep the bridge short")).toBeLessThan(section.indexOf("kick pattern habit"));
  });

  it("returns \"\" when there are no notes and nothing ranked", () => {
    expect(renderMemorySection([], [])).toBe("");
  });
});

describe("renderMemorySection: ~2KB budget", () => {
  it("never exceeds the byte budget, and omits (not truncates) an overflowing line", () => {
    // 40 long ranked lines guarantee an overflow of the ~2KB budget.
    const ranked = Array.from({ length: 40 }, (_, i) => ({
      id: `x${i}`, pool: "preference" as const, score: 40 - i,
      render: `- a fairly long preference line number ${i} that repeats a bunch of words to take up real byte budget space here`,
    }));
    const section = renderMemorySection([], ranked, MEMORY_BUDGET_BYTES);
    expect(new TextEncoder().encode(section).length).toBeLessThanOrEqual(MEMORY_BUDGET_BYTES);
    // Not every line fit — budget enforcement actually did something.
    expect(section).not.toContain("number 39");
    // Whatever DID make it in is a COMPLETE line, never a cut-off fragment.
    for (const line of section.split("\n").slice(1)) {
      expect(line.startsWith("- a fairly long preference line number ")).toBe(true);
      expect(line.endsWith("space here")).toBe(true);
    }
  });

  it("a tiny budget still returns \"\" rather than a header with zero lines", () => {
    const ranked = [{ id: "x", pool: "preference" as const, score: 1, render: "- " + "a".repeat(5000) }];
    const section = renderMemorySection([], ranked, 64);
    expect(section).toBe("");
  });

  it("project notes count against the SAME budget as ranked entries", () => {
    const notes = Array.from({ length: 40 }, (_, i) =>
      rec(`a fairly long project note number ${i} padded out with extra words to burn budget`, i, "note"));
    const section = renderMemorySection(notes, [], MEMORY_BUDGET_BYTES);
    expect(new TextEncoder().encode(section).length).toBeLessThanOrEqual(MEMORY_BUDGET_BYTES);
    expect(section).not.toContain("number 39");
  });
});

describe("retrieveContext: end-to-end", () => {
  it("combines notes + ranked entries deterministically", () => {
    const pools: MemoryPools = {
      preferences: [rec("likes heavy 808s")],
      patterns: [rec("kick on 1 and 3", 2, "drum_pattern")],
      projectNotes: [rec("chorus needs more energy", 3, "note")],
    };
    const a = retrieveContext("kick drum pattern", pools);
    const b = retrieveContext("kick drum pattern", pools);
    expect(a).toBe(b);
    expect(a).toContain("chorus needs more energy"); // note: always present
    expect(a).toContain("kick on 1 and 3");            // pattern: matched the query
    expect(a).not.toContain("likes heavy 808s");        // preference: no overlap, dropped
  });

  it("never mentions raw JSON for an object item — it stringifies for the prompt", () => {
    const pools: MemoryPools = { preferences: [rec({ note: "wide low end always" })] };
    const out = retrieveContext("wide low end", pools);
    expect(out).toContain("wide low end always");
  });
});
