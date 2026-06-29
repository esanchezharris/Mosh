import { describe, it, expect, beforeEach } from "vitest";
import { mockExecute, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { Snapshot, CommandResult } from "./types";

// The prompt compiler (generative-only v1): compile_render turns a loose instruction into a
// VALIDATED render layer (re-imagine colours / transform target) — or honestly declines a
// corrective/vocal request. This exercises the dev mock the WebView/e2e run against (a
// minimal mirror of service/compiler/core.py).

const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });
const snap = () => mockSnapshot<Snapshot>();
const clipById = async (id: string) =>
  (await snap()).tracks.flatMap((t) => t.clips).find((c) => c.id === id);
const waveClipId = async () =>
  (await snap()).tracks.flatMap((t) => t.clips).find((c) => c.type === "wave")!.id;

describe("mock compile_render (prompt compiler)", () => {
  beforeEach(() => __resetMockForTests());

  it("re-imagine: a descriptive instruction fills a render layer with the right colour", async () => {
    const clipId = await waveClipId();
    const r = await exec("compile_render", { clipId, instruction: "make it lo-fi and gritty", wait: true });
    expect(r.ok).toBe(true);
    const d = r.data as { mode: string; backend: string; envelope: { colors: Array<{ name: string }> } };
    expect(d.mode).toBe("reimagine");
    expect(d.backend).toBe("fake");
    expect(d.envelope.colors.some((c) => c.name === "grit")).toBe(true);
    const rl = (await clipById(clipId))?.renderLayer;
    expect(rl?.mode).toBe("reimagine");
    expect(rl?.colors?.some((c) => c.name === "grit")).toBe(true);
    expect(rl?.status).toBe("dirty");
  });

  it("'darker' picks the brightness colour below 50 (reversed)", async () => {
    const clipId = await waveClipId();
    await exec("compile_render", { clipId, instruction: "make it darker", wait: true });
    const bri = (await clipById(clipId))?.renderLayer?.colors?.find((c) => c.name === "brightness");
    expect(bri).toBeTruthy();
    expect(bri!.value).toBeLessThan(50);
  });

  it("transform: 'as a violin' routes to a transform layer with the target", async () => {
    const clipId = await waveClipId();
    const r = await exec("compile_render", { clipId, instruction: "re-imagine this as a violin", wait: true });
    const d = r.data as { mode: string; envelope: { target: string } };
    expect(d.mode).toBe("transform");
    expect(d.envelope.target).toContain("violin");
    const rl = (await clipById(clipId))?.renderLayer;
    expect(rl?.mode).toBe("transform");
    expect(rl?.target).toContain("violin");
  });

  it("then render → accept works on the compiled layer", async () => {
    const clipId = await waveClipId();
    await exec("compile_render", { clipId, instruction: "make it epic", wait: true });
    await exec("render_layer", { clipId });
    expect((await clipById(clipId))?.renderLayer?.hasArtifact).toBe(true);
    expect((await exec("accept_render", { clipId })).ok).toBe(true);
    expect((await clipById(clipId))?.renderLayer?.userKept).toBe(true);
  });

  it("honest boundary: a corrective request is declined, NO layer is created", async () => {
    const clipId = await waveClipId();
    const r = await exec("compile_render", { clipId, instruction: "fix my guitar", wait: true });
    expect(r.ok).toBe(true);
    const d = r.data as { mode: string; say: string; envelope: unknown };
    expect(d.mode).toBe("unsupported");
    expect(d.say.toLowerCase()).toContain("repair");
    expect(d.envelope).toBeNull();
    expect((await clipById(clipId))?.renderLayer).toBeUndefined();   // nothing re-performed
  });

  it("honest boundary: a vocal request is declined as instrumental-only", async () => {
    const clipId = await waveClipId();
    const r = await exec("compile_render", { clipId, instruction: "add a sung chorus", wait: true });
    const d = r.data as { mode: string; say: string };
    expect(d.mode).toBe("unsupported");
    expect(d.say.toLowerCase()).toContain("instrumental");
  });
});
