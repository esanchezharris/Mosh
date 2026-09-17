import { beforeEach, describe, expect, it } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

const exec = (command: string, args: Record<string, unknown>) => mockExecute<CommandResult>({ command, args });
const snapshot = () => mockSnapshot<Snapshot>();
const source = async () => {
  const found = (await snapshot()).tracks.flatMap((track) => track.clips).find((clip) => clip.type === "wave");
  if (!found) throw new Error("Missing wave fixture");
  return found;
};
const prepare = async () => {
  const { id: clipId } = await source();
  await exec("create_render_layer", { clipId, decisionPolicy: "explicit", adapter: "stable_audio3", mode: "reimagine", modelVariant: "sa3-medium" });
  await exec("render_layer", { clipId });
  return clipId;
};

describe("mock direct Re-Imagine contract", () => {
  beforeEach(__resetMockForTests);
  it("stores a clearly labelled pending fixture without auto-applying it", async () => {
    const before = await source();
    await prepare();
    const after = await source();
    expect(after.renderLayer).toMatchObject({ decisionPolicy: "explicit", hasPending: true, testFixture: true, audition: "committed" });
    expect(after.renderLayer?.appliedInPlace).not.toBe(true);
    expect(after.sourceFile).toBe(before.sourceFile);
  });
  it("keeps a pending fixture in place without adding a render track", async () => {
    const clipId = await prepare();
    const count = (await snapshot()).tracks.length;
    await exec("accept_render", { clipId });
    expect((await source()).renderLayer).toMatchObject({ hasPending: false, userKept: true, audition: "committed" });
    expect((await snapshot()).tracks.length).toBe(count);
  });
  it("rejects a later fixture without discarding the previously kept decision", async () => {
    const clipId = await prepare();
    await exec("accept_render", { clipId });
    await exec("render_layer", { clipId });
    await exec("bypass_layer", { clipId, audition: "result" });
    await exec("reject_render", { clipId });
    expect((await source()).renderLayer).toMatchObject({ hasPending: false, userKept: true, audition: "committed" });
  });
  it("reports fixture capability without claiming a real SA3 backend", async () => {
    const result = await exec("list_colors", {});
    expect(result.data).toMatchObject({ sa3: false, explicitRenderDecision: true, testFixture: true });
  });

  it("can audition the kept result when no pending result remains", async () => {
    const clipId = await prepare();
    await exec("accept_render", { clipId });
    expect((await exec("bypass_layer", { clipId, audition: "result" })).ok).toBe(true);
    expect((await source()).renderLayer?.audition).toBe("result");
  });

});
