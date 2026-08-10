import { describe, expect, it } from "vitest";
import { formatElapsedTime, TIME_RULER_MAX_TICKS, timeRulerTicks } from "./timeRuler";

describe("bottom time ruler", () => {
  it("formats elapsed time without borrowing the bar ruler's musical labels", () => {
    expect(formatElapsedTime(0)).toBe("0:00");
    expect(formatElapsedTime(65)).toBe("1:05");
    expect(formatElapsedTime(3661)).toBe("1:01:01");
  });

  it("chooses stable readable intervals from the current horizontal zoom", () => {
    expect(timeRulerTicks(35, 10).map((tick) => tick.seconds)).toEqual([0, 10, 20, 30]);
    expect(timeRulerTicks(4, 80).map((tick) => tick.seconds)).toEqual([0, 1, 2, 3, 4]);
  });

  it("bounds rendered ticks for a day-long arrangement at maximum zoom", () => {
    const ticks = timeRulerTicks(24 * 60 * 60, 400);
    expect(ticks[0]).toEqual({ seconds: 0, label: "0:00" });
    expect(ticks.length).toBeLessThanOrEqual(TIME_RULER_MAX_TICKS);
    expect(ticks.every((tick, index) => index === 0 || tick.seconds > ticks[index - 1].seconds)).toBe(true);
  });

  it("degrades a non-finite project duration to the safe origin label", () => {
    expect(formatElapsedTime(Infinity)).toBe("0:00");
    expect(timeRulerTicks(Infinity, 400)).toEqual([{ seconds: 0, label: "0:00" }]);
  });
});
