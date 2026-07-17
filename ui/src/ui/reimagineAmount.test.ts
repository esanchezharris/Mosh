import { describe, it, expect } from "vitest";
import { amountToNl, nlToAmount, NL_MIN, NL_MAX, NL_GENERATE } from "./reimagineAmount";

describe("reimagineAmount — 0–100 keep↔reimagine dial ↔ nl float", () => {
  it("amount 0 → NL_MIN (never 0, which the adapter rejects)", () => {
    expect(amountToNl(0, false)).toBeCloseTo(NL_MIN, 6);
    expect(amountToNl(0, true)).toBeCloseTo(NL_MIN, 6);
  });

  it("amount 100 → 0.5 normal, 1.0 in Lab", () => {
    expect(amountToNl(100, false)).toBeCloseTo(NL_MAX, 6);
    expect(amountToNl(100, true)).toBeCloseTo(NL_GENERATE, 6);
  });

  it("round-trips nl→amount→nl within one slider step (0.01 of the range)", () => {
    for (const lab of [false, true]) {
      for (const nl of [0.05, 0.2, 0.4, 0.5]) {
        const rt = amountToNl(nlToAmount(nl, lab), lab);
        expect(Math.abs(rt - nl)).toBeLessThan(0.01);
      }
    }
  });

  it("default nl 0.4 reads ~80 on the normal dial", () => {
    expect(nlToAmount(0.4, false)).toBe(80);
  });

  it("an nl above the Lab slider top clamps the DISPLAY to 100 (guard is uncapped service-side)", () => {
    expect(nlToAmount(1.5, true)).toBe(100);
  });

  it("clamps out-of-range amounts to [0,100]", () => {
    expect(amountToNl(150, false)).toBeCloseTo(NL_MAX, 6);
    expect(amountToNl(-10, false)).toBeCloseTo(NL_MIN, 6);
  });
});
