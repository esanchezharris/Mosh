import { describe, it, expect } from "vitest";
import { qaReadoutView, type RenderQA } from "./qaReadout";

describe("qaReadoutView", () => {
  it("returns null when there is no pq score", () => {
    expect(qaReadoutView(undefined)).toBeNull();
    expect(qaReadoutView({ flags: ["clipping"] })).toBeNull();
    expect(qaReadoutView({ pq: null })).toBeNull();
  });

  it("formats pq alone (no base)", () => {
    const v = qaReadoutView({ pq: 7.3 });
    expect(v).not.toBeNull();
    expect(v!.pqText).toBe("pq 7.3");
  });

  it("formats pq / pq_base when a base is present", () => {
    const v = qaReadoutView({ pq: 5.1, pq_base: 5.66 });
    expect(v!.pqText).toBe("pq 5.1 / 5.66");
  });

  it("surfaces the judge reasoning string when present", () => {
    const reasoning = "Good production quality (7.3/10); flagged: heavy_drive.";
    const v = qaReadoutView({ pq: 7.3, reasoning });
    expect(v!.reasoning).toBe(reasoning);
  });

  it("omits reasoning when absent or blank", () => {
    expect(qaReadoutView({ pq: 7.3 })!.reasoning).toBeNull();
    expect(qaReadoutView({ pq: 7.3, reasoning: "   " })!.reasoning).toBeNull();
  });

  it("passes flags through, marking quality_degraded as a warning", () => {
    const v = qaReadoutView({ pq: 4.0, pq_base: 5.0, flags: ["quality_degraded", "clipping"] });
    expect(v!.flags).toEqual([
      { label: "quality_degraded", warn: true },
      { label: "clipping", warn: false },
    ]);
  });

  it("treats a missing flags array as empty", () => {
    const v = qaReadoutView({ pq: 6.0 });
    expect(v!.flags).toEqual([]);
  });

  it("accepts a RenderQA value (type contract)", () => {
    const qa: RenderQA = { pq: 6.0, pq_base: 6.2, flags: [], reasoning: "Good production quality (6.0/10)." };
    expect(qaReadoutView(qa)!.reasoning).toContain("Good");
  });
});
