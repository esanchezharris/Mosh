import { beforeEach, describe, expect, it } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot } from "./bridge.mock";
import type { CommandResult, Plugin, Snapshot } from "./types";

const run = (command: string, args: Record<string, unknown> = {}) => mockExecute<CommandResult>({ command, args });
const snapshot = () => mockSnapshot<Snapshot>();
const synthOn = async (trackIndex: number): Promise<Plugin> => (await snapshot()).tracks[trackIndex].plugins!.find((p) => p.type === "4osc")!;

describe("bridge.mock — presets mirror the engine", () => {
  beforeEach(() => __resetMockForTests());

  it("a built-in 4OSC carries the engine's 68 parameters; a preset applies them by name; one undo restores it", async () => {
    const trackId = (await snapshot()).tracks[1].id;     // Bass: MIDI clips, no wave audio
    expect((await run("load_builtin", { trackId, type: "4osc" })).ok).toBe(true);
    const before = await synthOn(1);
    expect(before.params.length).toBe(68);
    const baseline = before.params.map((p) => [p.value, p.display]);

    const loaded = await run("load_preset", { trackId, index: before.index, file: "/presets/4osc/mosh-bass.json" });
    expect(loaded.ok).toBe(true);
    // mosh-bass.json names 17 parameters, every one a real 4OSC name
    expect(loaded.data).toEqual({ plugin: "4osc", preset: "mosh-bass", paramsApplied: 17 });
    const after = await synthOn(1);
    const byId = (id: string) => after.params.find((p) => p.id === id)!;
    expect(byId("level1")).toMatchObject({ value: expect.closeTo(0.85, 6), display: "-3.98dB" });    // -100 + 100·0.85^(1/4)
    expect(byId("ampRelease")).toMatchObject({ value: expect.closeTo(0.18, 6), display: "12ms" });   // 0.001 + 59.999·0.18^5 s
    expect(byId("filterFreq").display).toBe("159Hz");                                                // note 0.38·135.08 = 51.33 → 440·2^(-17.67/12)
    expect(byId("tune1")).toMatchObject({ value: 0.5, display: "0st" });                              // not in the file: untouched
    expect(after.params.filter((p, i) => p.value !== baseline[i]![0]).length).toBeGreaterThan(10);   // anti-vacuity
    expect(after.state?.waveShape1?.value).toBe("sine");    // the file's waveShapes do not land (engine bug, owner-gated)
    expect(after.state?.waveShape2?.value).toBe("off");

    const again = await run("load_preset", { trackId, index: before.index, file: "/presets/4osc/mosh-bass.json" });
    expect(again.ok).toBe(true);
    expect((await synthOn(1)).params).toEqual(after.params); // deterministic

    expect((await run("undo")).ok).toBe(true);
    expect((await run("undo")).ok).toBe(true);
    expect((await synthOn(1)).params.map((p) => [p.value, p.display])).toEqual(baseline);
  });

  it("reports the names a preset matched nothing for, as the engine does (mosh-pad's bare \"Spread\")", async () => {
    const trackId = (await snapshot()).tracks[1].id;
    await run("load_builtin", { trackId, type: "4osc" });
    const r = await run("load_preset", { trackId, file: "/presets/4osc/mosh-pad.json" });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ plugin: "4osc", preset: "mosh-pad", paramsApplied: 11, unknownParams: "Spread" });
    expect((await synthOn(1)).params.find((p) => p.id === "spread1")!.value).toBe(0.5);   // nothing bound to it
  });

  it("refuses a 4OSC preset on a track without a 4OSC, an index that is not one, and an unknown file", async () => {
    const keys = (await snapshot()).tracks[2].id;
    const r = await run("load_preset", { trackId: keys, index: 0, file: "/presets/4osc/mosh-bass.json" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no 4OSC instrument/);

    const bass = (await snapshot()).tracks[1].id;
    await run("load_builtin", { trackId: bass, type: "reverb" });
    await run("load_builtin", { trackId: bass, type: "4osc" });
    const wrong = await run("load_preset", { trackId: bass, index: 0, file: "/presets/4osc/mosh-bass.json" });
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toMatch(/no 4OSC instrument/);
    const missing = await run("load_preset", { trackId: bass, file: "/presets/4osc/nope.json" });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/preset file not found/);
  });
});
