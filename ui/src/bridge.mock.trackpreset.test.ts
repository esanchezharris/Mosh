import { beforeEach, describe, expect, it } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot } from "./bridge.mock";
import type { CommandResult, Plugin, Snapshot } from "./types";

// The mock's apply_track_preset mirrors native cmdApplyTrackPreset's CONTRACT (the same
// refusals, one undo step, ownership tags, no duplicate on re-apply). The native half —
// that the chain really is those DSP stages with those values — is proven in
// src/app/selftest/VocalPresetSelfTest.cpp, not here.

const run = (command: string, args: Record<string, unknown> = {}) => mockExecute<CommandResult>({ command, args });
const snapshot = () => mockSnapshot<Snapshot>();
const FILE = "/presets/track-chain/mosh-clean-lead-v0.json";

async function newAudioTrack(name = "Vox"): Promise<string> {
  const r = await run("create_track", { name });
  expect(r.ok).toBe(true);
  return (r.data as { trackId: string }).trackId;
}
async function rack(trackId: string): Promise<Plugin[]> {
  return (await snapshot()).tracks.find((t) => t.id === trackId)!.plugins ?? [];
}
const owned = (plugins: Plugin[]) => plugins.filter((p) => p.preset?.id === "mosh.clean-lead");

describe("bridge.mock — apply_track_preset mirrors the engine", () => {
  beforeEach(() => __resetMockForTests());

  it("the library lists the bundled track-chain preset under its own key", async () => {
    const listed = await run("list_presets", { plugin: "track-chain" });
    expect(listed.ok).toBe(true);
    const presets = (listed.data as { presets: { plugin: string; name: string; file: string }[] }).presets;
    expect(presets).toEqual([{ plugin: "track-chain", name: "mosh-clean-lead-v0", file: FILE, source: "bundled" }]);
    // …and the instrument pickers, which filter by their own key, never see it
    const fosc = (await run("list_presets", { plugin: "4osc" })).data as { presets: { plugin: string }[] };
    expect(fosc.presets.every((p) => p.plugin === "4osc")).toBe(true);
  });

  it("applies the whole chain as one undo step: high-pass then compressor, tagged, with every parameter", async () => {
    const trackId = await newAudioTrack();
    expect(await rack(trackId)).toHaveLength(0);                       // anti-vacuity baseline

    const applied = await run("apply_track_preset", { trackId, file: FILE });
    expect(applied.ok).toBe(true);
    expect(applied.data).toMatchObject({ presetId: "mosh.clean-lead", name: "Mosh Clean Lead v0", revision: 0, changed: true, replaced: false });

    const rows = owned(await rack(trackId));
    expect(rows.map((p) => p.type)).toEqual(["highpass", "compressor"]);
    expect(rows.map((p) => p.preset?.stage)).toEqual([0, 1]);
    expect(rows.every((p) => p.enabled && p.builtin && !p.isInstrument)).toBe(true);
    expect(rows[0]!.params.map((p) => p.display)).toEqual(["80 Hz"]);
    expect(rows[1]!.params).toHaveLength(6);                          // native has six; the trim is the fifth
    expect(rows[1]!.params[1]!.display).toBe("2.50 : 1");

    expect((await run("undo")).ok).toBe(true);
    expect(await rack(trackId)).toHaveLength(0);                       // ONE undo removes both stages
  });

  it("re-applying an untouched preset is a no-op that leaves no undo step", async () => {
    const trackId = await newAudioTrack();
    await run("rename_track", { trackId, name: "Lead" });
    await run("apply_track_preset", { trackId, file: FILE });

    const again = await run("apply_track_preset", { trackId, file: FILE });
    expect(again.ok).toBe(true);
    expect((again.data as { changed: boolean }).changed).toBe(false);
    expect(owned(await rack(trackId))).toHaveLength(2);                // not four

    await run("undo");                                                 // undoes the ONE apply…
    expect(await rack(trackId)).toHaveLength(0);
    await run("undo");                                                 // …and this reaches the rename
    expect((await snapshot()).tracks.find((t) => t.id === trackId)!.name).not.toBe("Lead");
  });

  it("re-applying over an edited chain replaces only the preset's own rows and keeps the user's plugin", async () => {
    const trackId = await newAudioTrack();
    expect((await run("load_builtin", { trackId, type: "4bandEq" })).ok).toBe(true);
    await run("apply_track_preset", { trackId, file: FILE });
    const comp = owned(await rack(trackId))[1]!;
    const presetAttack = comp.params[2]!.value;
    await run("set_plugin_param", { trackId, index: comp.index, paramIndex: 2, value: 0.9 });
    expect(owned(await rack(trackId))[1]!.params[2]!.value).toBeCloseTo(0.9);

    const reset = await run("apply_track_preset", { trackId, file: FILE });
    expect(reset.data).toMatchObject({ changed: true, replaced: true });
    const after = await rack(trackId);
    expect(after.map((p) => p.type)).toEqual(["4bandEq", "highpass", "compressor"]);
    expect(after.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(owned(after)[1]!.params[2]!.value).toBeCloseTo(presetAttack);
    expect(after[0]!.preset).toBeUndefined();                          // the user's EQ is never adopted
  });

  it("refuses, without mutating, everything the engine refuses", async () => {
    const audio = await newAudioTrack();
    const synth = await newAudioTrack("Keys");
    await run("load_builtin", { trackId: synth, type: "4osc" });
    const before = JSON.stringify((await snapshot()).tracks);

    const cases: [Record<string, unknown>, RegExp][] = [
      [{ file: FILE }, /trackId is required/],
      [{ trackId: "nope", file: FILE }, /no track/],
      [{ trackId: synth, file: FILE }, /hosts an instrument/],
      [{ trackId: audio, file: "/presets/4osc/mosh-bass.json" }, /preset file not found/],
      [{ trackId: audio, file: "" }, /preset file not found/],
    ];
    for (const [args, why] of cases) {
      const r = await run("apply_track_preset", args);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(why);
    }
    expect(JSON.stringify((await snapshot()).tracks)).toBe(before);
  });

  it("the instrument seam refuses a track-chain file by name", async () => {
    const synth = await newAudioTrack("Keys");
    await run("load_builtin", { trackId: synth, type: "4osc" });
    const r = await run("load_preset", { trackId: synth, file: FILE });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/track preset/);
  });
});
