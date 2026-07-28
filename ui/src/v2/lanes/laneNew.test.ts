import { describe, it, expect } from "vitest";
import { resolveLaneNew } from "./laneNew";

// isInstrument is DERIVED per-snapshot by the backend (trackHasInstrument, MoshOps.cpp),
// so it is true iff the track genuinely hosts a synth and can never be stale.
describe("resolveLaneNew", () => {
  it("a track that already hosts an instrument gets a clip", () => {
    expect(resolveLaneNew({ isInstrument: true })).toEqual({ kind: "clip" });
  });
  it("a bare track gets the menu instead of a silent clip", () => {
    expect(resolveLaneNew({ isInstrument: false })).toEqual({ kind: "menu" });
  });
  it("an absent flag is treated as bare, not as an instrument", () => {
    expect(resolveLaneNew({})).toEqual({ kind: "menu" });
  });
});
