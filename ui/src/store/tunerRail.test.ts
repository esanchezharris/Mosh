import { describe, it, expect } from "vitest";
import { onTuner } from "./events";
import { tunerKey } from "../ui/tuner";
import type { TunerReading } from "../types";

// The "tuner" rail's handler: every payload is the full set of tuners hearing a pitch.
function apply(payload: unknown, before: Record<string, TunerReading> = {}): Record<string, TunerReading> {
  let state = { tuners: before };
  const set = (patch: { tuners: Record<string, TunerReading> }) => { state = { ...state, ...patch }; };
  onTuner({ type: "tuner", payload } as never, set as never);
  return state.tuners;
}

const reading = (trackId: string, index: number, inputHz = 224, targetHz = 220): TunerReading =>
  ({ trackId, index, inputHz, targetHz, confidence: 0.9 });

describe("onTuner", () => {
  it("keys each tuner by its track and chain position", () => {
    const tuners = apply({ tuners: [reading("1013", 2), reading("1013", 5, 330, 329.63), reading("1020", 2)] });
    expect(Object.keys(tuners).sort()).toEqual(["1013:2", "1013:5", "1020:2"]);
    expect(tuners[tunerKey("1013", 5)]).toEqual(reading("1013", 5, 330, 329.63));
  });

  it("replaces the whole set, so a tuner that stopped hearing a pitch disappears", () => {
    const before = apply({ tuners: [reading("1013", 2), reading("1020", 2)] });
    const after = apply({ tuners: [reading("1020", 2, 262, 261.63)] }, before);
    expect(Object.keys(after)).toEqual(["1020:2"]);
    expect(after["1020:2"].inputHz).toBe(262);
  });

  it("clears on the empty payload the engine sends when the singing stops", () => {
    const before = apply({ tuners: [reading("1013", 2)] });
    expect(apply({ tuners: [] }, before)).toEqual({});
    expect(apply({}, before)).toEqual({});
    expect(apply(undefined, before)).toEqual({});
  });

  it("drops entries that are not a usable reading", () => {
    const tuners = apply({ tuners: [
      { trackId: "1013", index: 2, inputHz: 0, targetHz: 220 },          // no pitch
      { trackId: "1013", index: 3, inputHz: 224, targetHz: 0 },          // no target
      { trackId: "1013", inputHz: 224, targetHz: 220 },                  // no position
      { index: 4, inputHz: 224, targetHz: 220 },                         // no track
      { trackId: "1013", index: 6, inputHz: 224, targetHz: 220 },        // fine, confidence defaulted
    ] });
    expect(Object.keys(tuners)).toEqual(["1013:6"]);
    expect(tuners["1013:6"].confidence).toBe(0);
  });
});
