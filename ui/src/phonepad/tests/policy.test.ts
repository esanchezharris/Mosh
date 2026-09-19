import { describe, expect, it } from "vitest";
import { partIdSchema, stateSchema } from "../src/contract";
import { available, contributionLabel, target, targetLabel } from "../src/policy";
import type { PadContext } from "../src/policy";
import { ready } from "./fixture";

const context: PadContext = { state: ready, connected: true, pending: false, selected: partIdSchema.parse("part-2") };
describe("recording action policy", () => {
  it.each([
    { keeper: true, rejected: true, status: "preserved redo" },
    { keeper: false, rejected: true, status: "preserved redo" },
    { keeper: true, rejected: false, status: "kept" },
    { keeper: false, rejected: false, status: "preserved" },
  ])("labels keeper=$keeper rejected=$rejected as $status", ({ keeper, rejected, status }) => {
    expect(contributionLabel({ id: partIdSchema.parse("part-1"), label: "Part 1", keeper, rejected })).toBe(`Part 1 · ${status}`);
  });
  it("targets the active capture when an older take is explicitly selected", () => {
    // Given: an active recording with an older selection.
    const recording = { ...context, state: { ...ready, recording: true } };
    // When: resolving the action target.
    const actual = target(recording);
    // Then: no action can accidentally redo the older take.
    expect(actual).toBe("part-3");
    expect(targetLabel(recording)).toBe("current recording");
  });
  it("prefers an explicit preserved take when capture is stopped", () => {
    // Given: ready state with selection. When: target is resolved. Then:
    expect(target(context)).toBe("part-2");
  });
  it("uses the auditioned take before the last take when selection is automatic", () => {
    // Given: no explicit selection. When: target is resolved. Then:
    expect(target({ ...context, selected: null })).toBe("part-1");
  });
  it("requires an explicit selection to review a stopped take", () => {
    expect(available("hear", { ...context, selected: null })).toBe(false);
    expect(available("hear", context)).toBe(true);
  });
  it("keeps Play All untargeted and available without recorded takes", () => {
    const empty = { ...context, selected: null, state: { ...ready, currentId: null, lastId: null, auditionedId: null, contributions: [] } };
    expect(available("play_all", empty)).toBe(true);
  });
  it("allows Play All while recording so capture can finalize into the mix", () => {
    expect(available("play_all", { ...context, state: { ...ready, recording: true, playing: true } })).toBe(true);
  });
  it("leaves Stop available when the controller is busy with an uncertain action", () => {
    // Given: both local and host work are pending.
    const busy = { ...context, pending: true, state: { ...ready, busy: true } };
    // When: resolving button availability. Then:
    expect(available("stop", busy)).toBe(true);
    expect(available("keep", busy)).toBe(false);
  });
  it("blocks transport when setup is disengaged", () => {
    // Given: desktop engagement is off. When: Stop is considered. Then:
    expect(available("stop", { ...context, state: { ...ready, engaged: false } })).toBe(false);
  });
  it("blocks bar navigation during playback", () => {
    // Given: playback is active. When: navigation is considered. Then:
    expect(available("navigate", { ...context, state: { ...ready, playing: true } })).toBe(false);
  });
  it("allows stopped project-start and lead-in changes only", () => {
    expect(available("home", context)).toBe(true);
    expect(available("lead_in", context)).toBe(true);
    expect(available("home", { ...context, state: { ...ready, playing: true } })).toBe(false);
    expect(available("lead_in", { ...context, state: { ...ready, recording: true } })).toBe(false);
  });
  it("rejects malformed transport state at the network boundary", () => {
    // Given: wrong boolean shape. When: decoding a state. Then:
    expect(stateSchema.safeParse({ ...ready, recording: "true" }).success).toBe(false);
  });
  it("requires an explicit playback scope in additive schema v1 state", () => {
    expect(stateSchema.safeParse({ ...ready, playbackScope: "arrangement", playing: true }).success).toBe(true);
    expect(stateSchema.safeParse({ ...ready, playbackScope: "latest" }).success).toBe(false);
  });
});
