import { describe, it, expect, beforeEach } from "vitest";
import { mockExecute, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { Snapshot, CommandResult, RenderLora } from "./types";

// LoRA rack — trained style adapters ride the re-imagine layer as a params modifier
// (like colours): list_loras discovery + an UNBOUNDED ordered selection on
// set_render_param (no count cap, no strength clamp — owner call; >100 = overdrive).
// This exercises the dev mock the WebView/e2e run against.

const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });
const snap = () => mockSnapshot<Snapshot>();
const clipById = async (id: string) =>
  (await snap()).tracks.flatMap((t) => t.clips).find((c) => c.id === id);

describe("mock LoRA rack", () => {
  beforeEach(() => __resetMockForTests());

  it("list_loras returns the library with cards (invalid files listed, never hidden)", async () => {
    const r = await exec("list_loras");
    expect(r.ok).toBe(true);
    const d = r.data as { loras: { name: string; trigger: string; valid?: boolean }[] };
    expect(d.loras.map((l) => l.name)).toEqual(["ken-sa3", "bro-sa3", "mic-sa3", "broken"]);
    expect(d.loras[0].trigger).toBe("kxc");
    expect(d.loras[3].valid).toBe(false);
  });

  it("selection round-trips, dirties the layer, and is unbounded", async () => {
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

    // No count cap and no strength clamp: three adapters stick, order preserved,
    // value > 100 (deliberate overdrive) survives verbatim.
    await exec("set_render_param", { clipId, loras: [
      { name: "ken-sa3", value: 10 }, { name: "bro-sa3", value: 125 }, { name: "mic-sa3", value: 30 },
    ] });
    const racked = (await clipById(clipId))?.renderLayer?.loras as RenderLora[];
    expect(racked.map((l) => l.name)).toEqual(["ken-sa3", "bro-sa3", "mic-sa3"]);
    expect(racked[1].value).toBe(125);

    // Clearing the rack empties the selection.
    await exec("set_render_param", { clipId, loras: [] });
    expect((await clipById(clipId))?.renderLayer?.loras).toEqual([]);
  });
});
