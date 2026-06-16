import { describe, it, expect } from "vitest";
import { stableId, judgeAcceptance, deltaConfidence, ACCEPT_MARGIN, type CardEvidence, type CardRecipe } from "./card";

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

describe("deltaConfidence — bigger validated lift = higher confidence", () => {
  it("rises with the mean delta and stays in 0..1", () => {
    const lo = deltaConfidence([ev("b1", 0.01), ev("b2", 0.01)]);
    const hi = deltaConfidence([ev("b1", 0.2), ev("b2", 0.2)]);
    expect(hi).toBeGreaterThan(lo);
    expect(hi).toBeLessThanOrEqual(1);
    expect(lo).toBeGreaterThanOrEqual(0);
  });
});
