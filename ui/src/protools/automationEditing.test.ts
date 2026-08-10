import { describe, expect, it } from "vitest";
import {
  automationRange,
  automationReplacementBounds,
  nudgeAutomationPoints,
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
});
