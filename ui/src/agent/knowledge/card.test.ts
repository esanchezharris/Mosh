import { describe, it, expect } from "vitest";
import { stableId, judgeAcceptance, judgeConformance, isShippable, deltaConfidence, dedupByMove, moveSignature, ACCEPT_MARGIN, type CardEvidence, type CardRecipe, type TechniqueCard } from "./card";

describe("moveSignature — identity of the actual move (drives dedup + the mining novelty gate)", () => {
  const mk = (over: Partial<TechniqueCard>): TechniqueCard => ({
    id: "x", source: "distill", skill_name: "s", task_type: "drum_programming",
    genre_context: [], producer_intent: "p", when: "w",
    recipe: { kind: "recipe", commands: [{ command: "quantize_notes", args: { clipId: "$hatsClipId", division: 0.5, swing: 0.58 } }] },
    evidence: [], confidence: 0.75, status: "conformant", ...over,
  });

  it("is the same for identical commands under different labels, different for different commands", () => {
    const a = mk({ id: "a", skill_name: "hat swing programming" });
    const b = mk({ id: "b", skill_name: "Add swing to straight eighth-note hats" }); // same move, relabeled
    const c = mk({ id: "c", recipe: { kind: "recipe", commands: [{ command: "quantize_notes", args: { clipId: "$hatsClipId", division: 0.5, swing: 0.62 } }] } });
    expect(moveSignature(a)).toBe(moveSignature(b));
    expect(moveSignature(a)).not.toBe(moveSignature(c));
  });

  it("the novelty gate: a move already in the corpus is NOT novel; a genuinely new move IS", () => {
    const existing = mk({ id: "e" });
    const seen = new Set([moveSignature(existing)]);
    const dup = mk({ id: "d", skill_name: "boom bap hat swing programming" }); // re-extracted, same move
    const novel = mk({ id: "n", recipe: { kind: "recipe", commands: [{ command: "humanize_notes", args: { clipId: "$keysClipId", timing: 0.2, seed: 42 } }] } });
    expect(seen.has(moveSignature(dup))).toBe(true); // rejected — already have this move
    expect(seen.has(moveSignature(novel))).toBe(false); // passes — a new move
  });
});

describe("dedupByMove — collapse byte-identical moves in the shipped bundle", () => {
  const mk = (over: Partial<TechniqueCard>): TechniqueCard => ({
    id: "x", source: "distill", skill_name: "s", task_type: "drum_programming",
    genre_context: [], producer_intent: "p", when: "w",
    recipe: { kind: "recipe", commands: [{ command: "quantize_notes", args: { clipId: "$hatsClipId", division: 0.5, swing: 0.58 } }] },
    evidence: [], confidence: 0.75, status: "conformant", ...over,
  });

  it("collapses cards with identical commands into one, unioning their genres", () => {
    const a = mk({ id: "a", skill_name: "hat swing programming", genre_context: ["boom-bap"] });
    const b = mk({ id: "b", skill_name: "Add swing to hats", genre_context: ["lo-fi", "neo-soul"] });
    const out = dedupByMove([a, b]);
    expect(out.length).toBe(1);
    expect([...out[0].genre_context].sort()).toEqual(["boom-bap", "lo-fi", "neo-soul"]);
  });

  it("keeps cards with DIFFERENT commands (pattern variety is preserved)", () => {
    const a = mk({ id: "a", recipe: { kind: "recipe", commands: [{ command: "add_note", args: { clipId: "$drumClipId", pitch: 36, start: 0, length: 0.25 } }] } });
    const b = mk({ id: "b", recipe: { kind: "recipe", commands: [{ command: "add_note", args: { clipId: "$drumClipId", pitch: 36, start: 1, length: 0.25 } }] } });
    expect(dedupByMove([a, b]).length).toBe(2);
  });

  it("prefers a 'preferred' (ear-upgraded) representative over a conformant one", () => {
    const conf = mk({ id: "a", skill_name: "conf", status: "conformant" });
    const pref = mk({ id: "b", skill_name: "pref", status: "preferred" });
    const out = dedupByMove([conf, pref]);
    expect(out.length).toBe(1);
    expect(out[0].skill_name).toBe("pref");
  });

  it("dedups prompt cards by guidance, keeping distinct guidance", () => {
    const p1 = mk({ id: "p1", recipe: { kind: "prompt", guidance: "dusty drums" } });
    const p2 = mk({ id: "p2", recipe: { kind: "prompt", guidance: "dusty drums" } });
    const p3 = mk({ id: "p3", recipe: { kind: "prompt", guidance: "warm rhodes" } });
    expect(dedupByMove([p1, p2, p3]).length).toBe(2);
  });
});

const promptRecipe: CardRecipe = { kind: "prompt", guidance: "name every instrument" };

const ev = (brief: string, delta: number, metric: CardEvidence["metric"] = "clap_brief"): CardEvidence => ({
  brief, metric, withScore: 0.5 + delta, withoutScore: 0.5, delta,
});

describe("stableId — reproducible from content", () => {
  it("is stable across calls for the same content", () => {
    expect(stableId({ skill_name: "X", recipe: promptRecipe })).toBe(stableId({ skill_name: "X", recipe: promptRecipe }));
  });
  it("ignores case/whitespace in the skill name", () => {
    expect(stableId({ skill_name: "  Lo-Fi  ", recipe: promptRecipe })).toBe(stableId({ skill_name: "lo-fi", recipe: promptRecipe }));
  });
  it("changes when the recipe changes", () => {
    const other: CardRecipe = { kind: "prompt", guidance: "different" };
    expect(stableId({ skill_name: "X", recipe: promptRecipe })).not.toBe(stableId({ skill_name: "X", recipe: other }));
  });
});

describe("stableId — a recipe card's identity is what it DOES, not how it's checked", () => {
  const commands = [{ command: "add_note", args: { clipId: "$c", pitch: 36, start: 0 } }];
  const withCheck: CardRecipe = { kind: "recipe", commands, check: { kind: "pattern", clip: "$c", pattern: { hits: [{ pitch: 36, beats: [0] }] } } };
  const noCheck: CardRecipe = { kind: "recipe", commands };
  it("ignores the recipe's check (adding/changing a check never re-ids an existing card)", () => {
    expect(stableId({ skill_name: "drum", recipe: withCheck })).toBe(stableId({ skill_name: "drum", recipe: noCheck }));
  });
  it("still changes when the commands change", () => {
    const other: CardRecipe = { kind: "recipe", commands: [{ command: "add_note", args: { clipId: "$c", pitch: 38, start: 0 } }] };
    expect(stableId({ skill_name: "drum", recipe: withCheck })).not.toBe(stableId({ skill_name: "drum", recipe: other }));
  });
});

describe("judgeAcceptance — the flywheel's keep/reject bar", () => {
  it("keeps a card that improves brief-match by ≥margin on ≥2 briefs", () => {
    const r = judgeAcceptance([ev("b1", ACCEPT_MARGIN + 0.05), ev("b2", 0.01)]);
    expect(r.pass).toBe(true);
  });
  it("rejects when only one brief has evidence (not reproduced)", () => {
    expect(judgeAcceptance([ev("b1", 0.2)]).pass).toBe(false);
  });
  it("rejects when it regresses brief-match on any brief", () => {
    expect(judgeAcceptance([ev("b1", 0.2), ev("b2", -0.03)]).pass).toBe(false);
  });
  it("rejects when no brief clears the margin (noise-level gains)", () => {
    expect(judgeAcceptance([ev("b1", 0.005), ev("b2", 0.004)]).pass).toBe(false);
  });
  it("rejects when it breaks audio hygiene even if brief-match rose", () => {
    expect(judgeAcceptance([ev("b1", 0.2), ev("b2", 0.2)], { regressedHygiene: true }).pass).toBe(false);
  });
  it("honours a custom margin", () => {
    expect(judgeAcceptance([ev("b1", 0.03), ev("b2", 0.03)], { margin: 0.1 }).pass).toBe(false);
    expect(judgeAcceptance([ev("b1", 0.12), ev("b2", 0.01)], { margin: 0.1 }).pass).toBe(true);
  });
});

const conf = (brief: string, conformant: boolean): CardEvidence => ({
  brief, metric: "technique_conformance", withScore: conformant ? 1 : 0, withoutScore: 0, delta: conformant ? 1 : 0,
});

describe("judgeConformance — recipe cards validate by symbolic conformance across arrangements", () => {
  it("passes when conformant on ≥2 arrangements with no broken state", () => {
    expect(judgeConformance([conf("base-A", true), conf("base-B", true)]).pass).toBe(true);
  });
  it("fails when only one arrangement was tested (not reproduced)", () => {
    expect(judgeConformance([conf("base-A", true)]).pass).toBe(false);
  });
  it("fails when the move didn't take effect on an arrangement", () => {
    expect(judgeConformance([conf("base-A", true), conf("base-B", false)]).pass).toBe(false);
  });
  it("vetoes when the move broke the mix (hygiene regressed)", () => {
    expect(judgeConformance([conf("base-A", true), conf("base-B", true)], { regressedHygiene: true }).pass).toBe(false);
  });
  it("ignores non-conformance evidence rows (e.g. a pq nudge)", () => {
    const mixed = [conf("base-A", true), conf("base-B", true), ev("base-A", 0, "pq_perceptual")];
    expect(judgeConformance(mixed).pass).toBe(true);
  });
});

const cardWith = (status: TechniqueCard["status"]): TechniqueCard => ({
  id: "x", source: "distill", skill_name: "s", task_type: "other", genre_context: [], producer_intent: "", when: "", recipe: promptRecipe, evidence: [], confidence: 0.5, status,
});

describe("isShippable — which cards reach the product (validated prompt OR conformant/preferred recipe)", () => {
  it("ships validated, conformant, and preferred; not candidate/rejected", () => {
    expect(isShippable(cardWith("validated"))).toBe(true);
    expect(isShippable(cardWith("conformant"))).toBe(true);
    expect(isShippable(cardWith("preferred"))).toBe(true);
    expect(isShippable(cardWith("candidate"))).toBe(false);
    expect(isShippable(cardWith("rejected"))).toBe(false);
  });
});

describe("deltaConfidence — bigger validated lift = higher confidence", () => {
  it("rises with the mean delta and stays in 0..1", () => {
    const lo = deltaConfidence([ev("b1", 0.01), ev("b2", 0.01)]);
    const hi = deltaConfidence([ev("b1", 0.2), ev("b2", 0.2)]);
    expect(hi).toBeGreaterThan(lo);
    expect(hi).toBeLessThanOrEqual(1);
    expect(lo).toBeGreaterThanOrEqual(0);
  });
});
