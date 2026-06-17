import { describe, it, expect } from "vitest";
import { verdictBucket, goldenOk } from "./evalABVerdict";

// The pre-registered verdict for the injection-redesign sweep. Pure → tested offline.
// control = intent@k3 (the config that measured the −30% harm); decision = concrete@k1.
describe("verdictBucket", () => {
  it("concrete removes the intent@k3 harm but doesn't clear +10pp → HARM-REMOVED-NO-LIFT", () => {
    expect(verdictBucket({ concreteK1: 0.72, intentK3: 0.4, baseline: 0.7, goldenOk: true })).toBe("HARM-REMOVED-NO-LIFT");
  });

  it("concrete clears +10pp over baseline and beats intent → LIFT", () => {
    expect(verdictBucket({ concreteK1: 0.85, intentK3: 0.4, baseline: 0.7, goldenOk: true })).toBe("LIFT");
  });

  it("a golden no-regression drop fails the whole run regardless of targeted numbers", () => {
    expect(verdictBucket({ concreteK1: 0.9, intentK3: 0.4, baseline: 0.7, goldenOk: false })).toBe("FAIL");
  });

  it("concrete ≈ intent ≈ baseline → NO-CHANGE", () => {
    expect(verdictBucket({ concreteK1: 0.7, intentK3: 0.68, baseline: 0.7, goldenOk: true })).toBe("NO-CHANGE");
  });

  it("concrete below baseline beyond the noise floor → REGRESSION", () => {
    expect(verdictBucket({ concreteK1: 0.5, intentK3: 0.4, baseline: 0.7, goldenOk: true })).toBe("REGRESSION");
  });

  it("a lift that does NOT beat the intent control is not counted as LIFT", () => {
    // concrete clears +10pp over baseline, but intent@k3 is even higher → not a card win
    expect(verdictBucket({ concreteK1: 0.85, intentK3: 0.95, baseline: 0.7, goldenOk: true })).not.toBe("LIFT");
  });
});

describe("goldenOk — no-regression of the shipped concrete arm vs the no-cards baseline", () => {
  it("concrete at/above baseline (within noise) holds", () => {
    expect(goldenOk(0.99, 1.0)).toBe(true);
    expect(goldenOk(1.0, 0.97)).toBe(true); // 0.97 ≥ 1.0 − 0.05
  });
  it("concrete dropping below baseline beyond noise is a regression", () => {
    expect(goldenOk(1.0, 0.8)).toBe(false);
  });
  it("is null (no coverage) when a golden arm was not run — not a silent pass", () => {
    expect(goldenOk(null, 1.0)).toBeNull();
    expect(goldenOk(1.0, null)).toBeNull();
  });
});
