import { describe, it, expect, beforeEach } from "vitest";
import { mockExecute, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { Snapshot, CommandResult } from "./types";

// Route B — the transform render mode flows through the same command/snapshot contract
// as SA3 re-imagine, on the model-agnostic target+strength surface. This exercises the
// dev mock the WebView/e2e run against.

const exec = <T = unknown>(command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult<T>>({ command, args });
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
    // Transform is an audio operation — target a WAVE clip explicitly (the seed now also
    // carries typed MIDI/drum clips).
    const wave = s.tracks.flatMap((t) => t.clips).find((c) => c.type === "wave");
    expect(wave).toBeTruthy();
    const clipId = wave!.id;

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

describe("bridge.mock transform_notes noteIndexes parity", () => {
  beforeEach(() => __resetMockForTests());

  async function midiFixture() {
    const s = await snap();
    const clip = s.tracks.flatMap((track) => track.clips).find((candidate) => candidate.type === "midi");
    expect(clip?.notes?.length).toBeGreaterThan(1);
    return clip!;
  }

  it("rejects an explicit selection larger than the clip note count", async () => {
    const clip = await midiFixture();
    const result = await exec("transform_notes", {
      clipId: clip.id,
      mode: "invert",
      noteIndexes: Array((clip.notes?.length ?? 0) + 1).fill(0),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("too many noteIndexes");
  });

  it("rejects fractional note indexes instead of truncating them", async () => {
    const clip = await midiFixture();
    const result = await exec("transform_notes", {
      clipId: clip.id,
      mode: "invert",
      noteIndexes: [0.5],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("bad noteIndex");
  });

  it("rejects an integer index outside the clip note range", async () => {
    const clip = await midiFixture();
    const result = await exec("transform_notes", {
      clipId: clip.id,
      mode: "invert",
      noteIndexes: [clip.notes?.length ?? 0],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("bad noteIndex");
  });

  it("deduplicates explicit indexes before transforming and counting changes", async () => {
    const clip = await midiFixture();
    const result = await exec<{ changed: number }>("transform_notes", {
      clipId: clip.id,
      mode: "humanize",
      amount: 100,
      noteIndexes: [0, 0],
    });

    expect(result.ok).toBe(true);
    expect(result.data?.changed).toBe(1);
  });
});
