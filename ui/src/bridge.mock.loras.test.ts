import { describe, it, expect, beforeEach } from "vitest";
import { mockExecute, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { Snapshot, CommandResult, RenderLora } from "./types";

// LoRA rack — trained style adapters ride the re-imagine layer as a params modifier
// (like colours): list_loras discovery + a ≤2 ordered selection on set_render_param.
// This exercises the dev mock the WebView/e2e run against.

const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });
const snap = () => mockSnapshot<Snapshot>();
const clipById = async (id: string) =>
  (await snap()).tracks.flatMap((t) => t.clips).find((c) => c.id === id);

describe("mock LoRA rack", () => {
  beforeEach(() => __resetMockForTests());

  it("list_loras returns the library with cards", async () => {
    const r = await exec("list_loras");
    expect(r.ok).toBe(true);
    const d = r.data as { loras: { name: string; trigger: string }[]; maxActive: number };
    expect(d.loras.map((l) => l.name)).toEqual(["ken-sa3", "bro-sa3"]);
    expect(d.loras[0].trigger).toBe("kxc");
    expect(d.maxActive).toBe(2);
  });

  it("selection round-trips, dirties the layer, and clamps to two", async () => {
    const s = await snap();
    const wave = s.tracks.flatMap((t) => t.clips).find((c) => c.type === "wave");
    expect(wave).toBeTruthy();
    const clipId = wave!.id;

    expect((await exec("create_render_layer", { clipId, adapter: "fake", mode: "reimagine" })).ok).toBe(true);
    expect((await clipById(clipId))?.renderLayer?.loras).toEqual([]);

    await exec("set_render_param", { clipId, loras: [{ name: "ken-sa3", value: 70 }] });
    let rl = (await clipById(clipId))?.renderLayer;
    expect(rl?.loras).toEqual([{ name: "ken-sa3", value: 70 }]);
    expect(rl?.status).toBe("dirty");

    await exec("render_layer", { clipId });
    expect((await clipById(clipId))?.renderLayer?.status).toBe("ready");

    // Strength change re-dirties (fingerprint change on the native side).
    await exec("set_render_param", { clipId, loras: [{ name: "ken-sa3", value: 30 }] });
    rl = (await clipById(clipId))?.renderLayer;
    expect(rl?.status).toBe("dirty");
    expect((rl?.loras as RenderLora[])[0].value).toBe(30);

    // The mock mirrors the native ≤2 clamp.
    await exec("set_render_param", { clipId, loras: [
      { name: "a", value: 10 }, { name: "b", value: 20 }, { name: "c", value: 30 },
    ] });
    expect(((await clipById(clipId))?.renderLayer?.loras as RenderLora[]).length).toBe(2);

    // Clearing the rack empties the selection.
    await exec("set_render_param", { clipId, loras: [] });
    expect((await clipById(clipId))?.renderLayer?.loras).toEqual([]);
  });
});
