import { describe, expect, it } from "vitest";
import { computeLaneLayout } from "./laneLayout";

describe("Open Lanes measured layout", () => {
  it("expands every lane when all minimum editors fit", () => {
    const layout = computeLaneLayout(["drums", "bass", "vocal"], 364, 1);
    expect(layout.mode).toBe("fill-all");
    expect(layout.expandedTrackIds).toEqual(["drums", "bass", "vocal"]);
    expect(layout.heightsPx).toEqual([116, 116, 116]);
  });

  it("uses one focused editor and compact siblings when minimum editors do not fit", () => {
    const layout = computeLaneLayout(["drums", "bass", "vocal"], 347, 1);
    expect(layout.mode).toBe("accordion");
    expect(layout.expandedTrackIds).toEqual(["bass"]);
    expect(layout.heightsPx).toEqual([60, 190, 60]);
  });

  it("caps evenly filled lanes at 190px and preserves the gaps", () => {
    const layout = computeLaneLayout(["a", "b"], 600, 0);
    expect(layout.heightsPx).toEqual([190, 190]);
    expect(layout.usedHeightPx).toBe(388);
  });

  it("switches focus without changing the measured heights", () => {
    const first = computeLaneLayout(["a", "b", "c", "d"], 400, 0);
    const last = computeLaneLayout(["a", "b", "c", "d"], 400, 3);
    expect(first.expandedTrackIds).toEqual(["a"]);
    expect(last.expandedTrackIds).toEqual(["d"]);
    expect(first.heightsPx).toEqual([190, 60, 60, 60]);
    expect(last.heightsPx).toEqual([60, 60, 60, 190]);
  });

  it("transitions back to fill-all after a resize crosses the exact fit boundary", () => {
    expect(computeLaneLayout(["a", "b"], 239, 0).mode).toBe("accordion");
    expect(computeLaneLayout(["a", "b"], 240, 0).mode).toBe("fill-all");
  });

  it("returns an empty, stable result for an empty song", () => {
    expect(computeLaneLayout([], 500, 0)).toEqual({
      mode: "fill-all",
      expandedTrackIds: [],
      heightsPx: [],
      usedHeightPx: 0,
    });
  });
});
