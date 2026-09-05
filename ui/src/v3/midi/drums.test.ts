import { describe, expect, it } from "vitest";
import { extraGmLanesCollapsed, notesOnLane, v3DrumLane, V3_DRUM_LANES } from "./drums";

describe("v3 drum lanes", () => {
  it("uses exactly Kick / Snare / Hat", () => {
    expect(V3_DRUM_LANES).toEqual(["kick", "snare", "hat"]);
  });

  it("maps GM kick/snare/hat pitches onto the three lanes", () => {
    expect(v3DrumLane(36)).toBe("kick");
    expect(v3DrumLane(38)).toBe("snare");
    expect(v3DrumLane(39)).toBe("snare");
    expect(v3DrumLane(42)).toBe("hat");
    expect(v3DrumLane(46)).toBe("hat");
  });

  it("collapses extra GM lanes into the three-lane preview", () => {
    expect(extraGmLanesCollapsed()).toBeGreaterThan(0);
    expect(notesOnLane([{ i: 0, pitch: 45, start: 0, length: 0.25, velocity: 100 }], "hat")).toHaveLength(1);
  });
});
