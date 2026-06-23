import { describe, it, expect } from "vitest";
import { laneRows, lanesTotal } from "./laneLayout";

describe("laneRows", () => {
  it("uniform heights → fixed grid offsets (i*h), unchanged from the old layout", () => {
    expect(laneRows([76, 76, 76])).toEqual([
      { top: 0, height: 76 },
      { top: 76, height: 76 },
      { top: 152, height: 76 },
    ]);
  });
  it("an expanded (taller) row pushes the rows below it down", () => {
    expect(laneRows([76, 236, 76])).toEqual([
      { top: 0, height: 76 },
      { top: 76, height: 236 },
      { top: 312, height: 76 },
    ]);
  });
  it("empty input → empty layout", () => {
    expect(laneRows([])).toEqual([]);
  });
});

describe("lanesTotal", () => {
  it("sums the row heights", () => {
    expect(lanesTotal([76, 236, 76])).toBe(388);
    expect(lanesTotal([])).toBe(0);
  });
});
