import { describe, it, expect, beforeEach } from "vitest";
import { mockExecute, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { Snapshot, CommandResult, AvailableLora, RenderLora } from "./types";

// The LoRA rack — stacked taste adapters on the SA3 render layer. Mock parity with
// the native surface: list_loras (read-only library), set_render_param {loras}
// (ordered, UNBOUNDED — no count cap, no strength clamp), snapshot round-trip.

const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });
const snap = () => mockSnapshot<Snapshot>();
const clipById = async (id: string) =>
  (await snap()).tracks.flatMap((t) => t.clips).find((c) => c.id === id);

describe("mock LoRA rack", () => {
  beforeEach(() => __resetMockForTests());

  it("list_loras returns the library with triggers + sha identity", async () => {
    const r = await exec("list_loras");
    expect(r.ok).toBe(true);
    const d = r.data as { loras: AvailableLora[]; dir: string };
    expect(d.loras.length).toBeGreaterThan(0);
    const kxc = d.loras.find((l) => l.name === "kxc");
    expect(kxc?.trigger).toBe("kxc");
    expect(kxc?.sha12?.length).toBe(12);
    expect(kxc?.valid).toBe(true);
    expect(d.dir).toContain("loras");
  });

  it("list_loras is read-only (no undo pollution)", async () => {
    await exec("create_track", { name: "T" });
    await exec("list_loras");
    const r = await exec("undo");
    expect(r.ok).toBe(true);
    // the undo undid create_track, not list_loras — track gone
    const s = await snap();
    expect(s.tracks.some((t) => t.name === "T")).toBe(false);
  });

  it("set_render_param {loras} stores an ORDERED, UNBOUNDED rack + marks dirty", async () => {
    const s = await snap();
    const wave = s.tracks.flatMap((t) => t.clips).find((c) => c.type === "wave")!;
    await exec("create_render_layer", { clipId: wave.id, adapter: "stable_audio3", mode: "reimagine" });

    // 5 rows incl. an overdrive strength >100 — nothing clamps, order preserved.
    const rack: RenderLora[] = [
      { name: "kxc", value: 80 }, { name: "micz", value: 60 },
      { name: "emzr", value: 40 }, { name: "extra1", value: 20 },
      { name: "extra2", value: 125 },
    ];
    const r = await exec("set_render_param", { clipId: wave.id, loras: rack });
    expect(r.ok).toBe(true);

    const rl = (await clipById(wave.id))?.renderLayer;
    expect(rl?.status).toBe("dirty");
    expect(rl?.loras?.length).toBe(5);
    expect(rl?.loras?.map((l) => l.name)).toEqual(["kxc", "micz", "emzr", "extra1", "extra2"]);
    expect(rl?.loras?.[4].value).toBe(125);
  });

  it("rack survives render; emptying the rack round-trips", async () => {
    const s = await snap();
    const wave = s.tracks.flatMap((t) => t.clips).find((c) => c.type === "wave")!;
    await exec("create_render_layer", { clipId: wave.id, adapter: "stable_audio3", mode: "reimagine" });
    await exec("set_render_param", { clipId: wave.id, loras: [{ name: "kxc", value: 100 }] });
    await exec("render_layer", { clipId: wave.id, wait: true });
    let rl = (await clipById(wave.id))?.renderLayer;
    expect(rl?.loras?.[0]?.name).toBe("kxc");

    await exec("set_render_param", { clipId: wave.id, loras: [] });
    rl = (await clipById(wave.id))?.renderLayer;
    expect(rl?.loras?.length ?? 0).toBe(0);
    expect(rl?.status).toBe("dirty");
  });
});
