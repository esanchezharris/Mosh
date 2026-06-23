import { describe, it, expect, beforeEach } from "vitest";
import { mockExecute, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { Snapshot, CommandResult } from "./types";

// Route B — the transform render mode flows through the same command/snapshot contract
// as SA3 re-imagine, on the model-agnostic target+strength surface. This exercises the
// dev mock the WebView/e2e run against.

const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });
const snap = () => mockSnapshot<Snapshot>();
const clipById = async (id: string) =>
  (await snap()).tracks.flatMap((t) => t.clips).find((c) => c.id === id);

describe("mock transform render layer (Route B)", () => {
  beforeEach(() => __resetMockForTests());

  it("list_transform_targets returns a target list + free-text flag", async () => {
    const r = await exec("list_transform_targets");
    expect(r.ok).toBe(true);
    const d = r.data as { targets: string[]; freeText: boolean };
    expect(d.targets.length).toBeGreaterThan(0);
    expect(d.freeText).toBe(true);
  });

  it("create transform layer → set target/strength → render → accept", async () => {
    const s = await snap();
    const trackWithClip = s.tracks.find((t) => t.clips.length > 0);
    expect(trackWithClip).toBeTruthy();
    const clipId = trackWithClip!.clips[0].id;

    expect((await exec("create_render_layer", { clipId, adapter: "transform", mode: "transform" })).ok).toBe(true);
    expect((await clipById(clipId))?.renderLayer?.mode).toBe("transform");

    await exec("set_render_param", { clipId, target: "flute", strength: 80 });
    let rl = (await clipById(clipId))?.renderLayer;
    expect(rl?.target).toBe("flute");
    expect(rl?.strength).toBe(80);
    expect(rl?.status).toBe("dirty");

    await exec("render_layer", { clipId });
    rl = (await clipById(clipId))?.renderLayer;
    expect(rl?.status).toBe("ready");
    expect(rl?.hasArtifact).toBe(true);

    expect((await exec("accept_render", { clipId })).ok).toBe(true);
    expect((await clipById(clipId))?.renderLayer?.userKept).toBe(true);
  });
});
