// Mock parity for the SECTION-SCOPED render — the one shape where accept_render and
// bounce_layer_to_clip do real work.
//
// The mock used to ignore regionStart/regionEnd completely and auto-apply every wave render
// in place, which made the sub-region branch unrepresentable: any UI test built on it would
// have been green against a backend behaviour that does not exist. The native rules being
// mirrored here, read off MoshOps.cpp rather than assumed:
//
//   - cmdCreateRenderLayer clamps an explicit region to the clip, and IGNORES a degenerate
//     one (< 1ms), falling back to the whole clip.
//   - snapshot() always emits regionStart/regionEnd — a whole-clip layer reports the clip's
//     own span — so "is this section-scoped?" is a comparison, never a presence check.
//   - applyRenderInPlace returns false for a sub-region (it can only repoint a whole source),
//     so the render falls through to the legacy "Neural Renders" lane landing.
//   - accept_render lands ONE clip on a shared lane; a second accept must not duplicate it.

import { beforeEach, describe, expect, it } from "vitest";
import { mockExecute, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });
const snap = () => mockSnapshot<Snapshot>();

describe("mock parity — section-scoped render layers", () => {
  let clipId: string;
  let clipStart: number;
  let clipLen: number;

  beforeEach(async () => {
    __resetMockForTests();
    const s = await snap();
    const wave = s.tracks.flatMap((t) => t.clips).find((c) => c.type === "wave")!;
    clipId = wave.id; clipStart = wave.start; clipLen = wave.length;
  });

  const layerOf = async () => {
    const s = await snap();
    return s.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!.renderLayer!;
  };
  const laneClips = async () =>
    (await snap()).tracks.find((t) => t.name === "Neural Renders")?.clips ?? [];

  it("a whole-clip layer reports the clip's own span, not an absent region", async () => {
    await exec("create_render_layer", { clipId, adapter: "fake" });
    const rl = await layerOf();
    expect(rl.regionStart).toBeCloseTo(clipStart, 5);
    expect(rl.regionEnd).toBeCloseTo(clipStart + clipLen, 5);
  });

  it("an explicit region is stored, clamped to the clip", async () => {
    // Ask for more than the clip holds on both ends; expect the clip's bounds back.
    await exec("create_render_layer", {
      clipId, adapter: "fake", regionStart: clipStart - 99, regionEnd: clipStart + clipLen + 99,
    });
    const rl = await layerOf();
    expect(rl.regionStart).toBeCloseTo(clipStart, 5);
    expect(rl.regionEnd).toBeCloseTo(clipStart + clipLen, 5);
  });

  it("a degenerate region falls back to the whole clip rather than making a 0-length render", async () => {
    const mid = clipStart + clipLen / 2;
    await exec("create_render_layer", { clipId, adapter: "fake", regionStart: mid, regionEnd: mid });
    const rl = await layerOf();
    expect(rl.regionStart).toBeCloseTo(clipStart, 5);
    expect(rl.regionEnd).toBeCloseTo(clipStart + clipLen, 5);
  });

  it("a WHOLE-clip wave render auto-applies in place and lands nothing", async () => {
    await exec("create_render_layer", { clipId, adapter: "fake" });
    await exec("render_layer", { clipId });
    expect((await layerOf()).appliedInPlace).toBe(true);
    await exec("accept_render", { clipId });
    expect(await laneClips(), "landed a lane clip for a render that already applied in place").toHaveLength(0);
  });

  it("a SUB-REGION render does NOT auto-apply — it waits for the lane landing", async () => {
    const half = clipStart + clipLen / 2;
    await exec("create_render_layer", { clipId, adapter: "fake", regionStart: clipStart, regionEnd: half });
    await exec("render_layer", { clipId });
    const rl = await layerOf();
    expect(rl.status).toBe("ready");
    expect(rl.hasArtifact).toBe(true);
    expect(rl.appliedInPlace, "a sub-region cannot repoint the clip's whole source").toBeFalsy();
  });

  it("bounce_layer_to_clip lands the section on the Neural Renders lane, spanning the region", async () => {
    const half = clipStart + clipLen / 2;
    await exec("create_render_layer", { clipId, adapter: "fake", regionStart: clipStart, regionEnd: half });
    await exec("render_layer", { clipId });
    expect(await laneClips()).toHaveLength(0);

    await exec("bounce_layer_to_clip", { clipId });
    const landed = await laneClips();
    expect(landed, "bounce did no work on the one shape where it is supposed to").toHaveLength(1);
    expect(landed[0]!.start).toBeCloseTo(clipStart, 5);
    expect(landed[0]!.length).toBeCloseTo(half - clipStart, 5);
    expect((await layerOf()).status).toBe("bounced");
  });

  it("accepting twice reuses the one lane and does not duplicate the clip", async () => {
    const half = clipStart + clipLen / 2;
    await exec("create_render_layer", { clipId, adapter: "fake", regionStart: half, regionEnd: clipStart + clipLen });
    await exec("render_layer", { clipId });
    await exec("accept_render", { clipId });
    await exec("bounce_layer_to_clip", { clipId });
    expect(await laneClips()).toHaveLength(1);
    expect((await snap()).tracks.filter((t) => t.name === "Neural Renders")).toHaveLength(1);
  });
});
