import { describe, expect, it } from "vitest";
import {
  automationClipboardFromSelection,
  automationLinePoints,
  automationPointsForPaste,
  automationRange,
  automationReplacementBounds,
  automationSegmentPreview,
  nudgeAutomationPoints,
  selectedAutomationPointIndices,
} from "./automationEditing";

describe("Pro Tools automation editing geometry", () => {
  const points = [{ t: 1, v: 0.2 }, { t: 3, v: 0.7 }, { t: 5, v: 0.4 }];

  it("keeps a positive selected-range nudge before the next unselected node", () => {
    expect(nudgeAutomationPoints(points, automationRange(0.5, 3.5), 4)).toEqual([
      { t: 2.999999, v: 0.2 },
      { t: 4.999999, v: 0.7 },
      { t: 5, v: 0.4 },
    ]);
  });

  it("keeps a negative selected-range nudge at or after time zero", () => {
    expect(nudgeAutomationPoints(points, automationRange(0.5, 3.5), -4)).toEqual([
      { t: 0, v: 0.2 },
      { t: 2, v: 0.7 },
      { t: 5, v: 0.4 },
    ]);
  });

  it("keeps a negative selected-range nudge after the previous unselected node", () => {
    expect(nudgeAutomationPoints(points, automationRange(2.5, 5.5), -4)).toEqual([
      { t: 1, v: 0.2 },
      { t: 1.000001, v: 0.7 },
      { t: 3.000001, v: 0.4 },
    ]);
  });

  it("replaces the union of old and new edge-point bounds", () => {
    expect(automationReplacementBounds(points, [
      { t: 1.25, v: 0.2 }, { t: 3.25, v: 0.7 }, { t: 5, v: 0.4 },
    ])).toEqual({ start: 1, end: 5 });
  });

  it("copies selected points relative to the time selection and addresses cut indices backwards", () => {
    const selection = automationRange(0.5, 3.5);

    expect(automationClipboardFromSelection(points, selection, "Level")).toEqual({
      duration: 3,
      sourceParamName: "Level",
      points: [{ t: 0.5, v: 0.2 }, { t: 2.5, v: 0.7 }],
    });
    expect(selectedAutomationPointIndices(points, selection)).toEqual([1, 0]);
  });

  it("places clipboard points relative to the edit insertion", () => {
    expect(automationPointsForPaste({
      duration: 3,
      sourceParamName: "Level",
      points: [{ t: 0.5, v: 0.2 }, { t: 2.5, v: 0.7 }],
    }, 7)).toEqual([{ t: 7.5, v: 0.2 }, { t: 9.5, v: 0.7 }]);
  });

  it("normalizes a reverse line gesture and previews it without disturbing outside points", () => {
    const line = automationLinePoints({ t: 3, v: 0.7 }, { t: 1, v: 0.2 });

    expect(line).toEqual([{ t: 1, v: 0.2 }, { t: 3, v: 0.7 }]);
    expect(automationSegmentPreview(points, line)).toEqual([
      { t: 1, v: 0.2 }, { t: 3, v: 0.7 }, { t: 5, v: 0.4 },
    ]);
  });
});
