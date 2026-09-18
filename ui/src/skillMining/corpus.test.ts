import { describe, expect, it } from "vitest";
import { frozenSelection, hash, shapes, shapeSummary, selectedGroups } from "./corpus";

describe("corpus shape measurement", () => {
  it("preserves order, exact repetitions, and empty rows", () => {
    const rows = [
      { id: "1", shape: ["a", "b"] }, { id: "2", shape: ["b", "a"] },
      { id: "3", shape: ["a", "a"] }, { id: "4", shape: [] }, { id: "5", shape: ["a", "b"] },
    ];
    expect(shapes(rows)).toEqual([
      { shape: ["a", "b"], rows: ["1", "5"] }, { shape: [], rows: ["4"] },
      { shape: ["a", "a"], rows: ["3"] }, { shape: ["b", "a"], rows: ["2"] },
    ]);
    expect(shapeSummary(shapes(rows))).toEqual({ rows: 5, distinctShapes: 4, thresholds: { 50: 2, 80: 3, 95: 4 } });
  });
  it("selects at most 40 executable shapes and retains empty rows in the coverage denominator", () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: String(i), shape: [`c${String(i).padStart(2, "0")}`] }));
    const groups = shapes([...rows, ...Array.from({ length: 100 }, (_, i) => ({ id: `empty${i}`, shape: [] }))]);
    expect(selectedGroups(groups)).toHaveLength(40);
    expect(selectedGroups(groups).some((g) => !g.shape.length)).toBe(false);
  });
  it("uses the existing evaluator's stable hash order including ties", () => {
    const rows = [{ id: "b", shape: [] }, { id: "aa", shape: [] }, { id: "a", shape: [] }, { id: "a", shape: ["second"] }];
    expect(frozenSelection(rows).map((r) => r.id)).toEqual(["a", "a", "b", "aa"]);
    expect(frozenSelection(rows)[1].shape).toEqual(["second"]);
    expect(hash("a\na\nb\naa\n")).toHaveLength(64);
    expect(frozenSelection(Array.from({ length: 400 }, (_, i) => ({ id: String(i), shape: [] })))).toHaveLength(300);
  });
});
