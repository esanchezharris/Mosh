import { describe, it, expect } from "vitest";
import { sanitizeParams, DEF } from "./params";

describe("sanitizeParams (a model can never break rendering)", () => {
  it("clamps out-of-range numbers to the control min/max", () => {
    const p = sanitizeParams({ goo: 9, gloss: -3 });
    expect(p.goo).toBe(1);
    expect(p.gloss).toBe(0);
  });
  it("drops unknown keys and keeps defaults", () => {
    const p = sanitizeParams({ notAParam: 5, rhythm: 0.4 } as never);
    expect("notAParam" in p).toBe(false);
    expect(p.rhythm).toBe(0.4);
    expect(p.metal).toBe(DEF.metal);
  });
  it("accepts only valid hex colors", () => {
    const p = sanitizeParams({ low: "#00ff00", mid: "not-a-color" });
    expect(p.low).toBe("#00ff00");
    expect(p.mid).toBe(DEF.mid);
  });
  it("ignores NaN / non-finite numbers", () => {
    const p = sanitizeParams({ wake: Number.NaN, flow: Infinity });
    expect(p.wake).toBe(DEF.wake);
    expect(p.flow).toBe(DEF.flow);
  });
});
