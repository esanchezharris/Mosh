import { describe, expect, it } from "vitest";
import { isSilhouettePath, silhouettePath } from "./silhouette";

describe("silhouettePath", () => {
  it("builds a single filled mirrored path from min/max peaks", () => {
    const d = silhouettePath([[-1, 1], [-0.5, 0.5], [-0.2, 0.8]], 100, 40);
    expect(isSilhouettePath(d)).toBe(true);
    expect(d.startsWith("M ")).toBe(true);
    expect(d.endsWith(" Z")).toBe(true);
    expect(d.includes("rect")).toBe(false);
    // three top points + three bottom points = five " L " joins inside the path
    expect(d.split(" L ").length).toBeGreaterThan(3);
  });

  it("returns empty for no peaks", () => {
    expect(silhouettePath([], 100, 40)).toBe("");
  });
});
