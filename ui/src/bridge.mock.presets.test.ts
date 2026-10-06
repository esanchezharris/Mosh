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
    // mosh-bass.json names 14 parameters and 5 settings, every one a real 4OSC name
    expect(loaded.data).toMatchObject({ plugin: "4osc", preset: "mosh-bass", paramsApplied: 14, settingsApplied: 5, changed: true });
    expect(loaded.data).not.toHaveProperty("unknownParams");
    const after = await synthOn(1);
    const byId = (id: string) => after.params.find((p) => p.id === id)!;
    expect(byId("level1").display).toBe("-4.00dB");            // -100 + 100·v^(1/4)
    expect(byId("ampRelease").display).toBe("80ms");           // 0.001 + 59.999·v^5 s
    expect(byId("filterFreq").display).toBe("160Hz");
    expect(byId("tune1")).toMatchObject({ value: 0.5, display: "0st" });   // not in the file: its default
    expect(after.params.filter((p, i) => p.value !== baseline[i]![0]).length).toBeGreaterThan(10);   // anti-vacuity
    // the settings land: saw + square, two unison voices, a 24 dB/oct low-pass
    expect(after.state?.waveShape1?.value).toBe("saw");
    expect(after.state?.waveShape2?.value).toBe("square");
    expect(after.state?.voices1?.value).toBe(2);
    expect(after.state?.filterType?.value).toBe("lowpass");
    expect(after.state?.filterSlope?.value).toBe(24);

    // the patch that is already loaded: no change, no undo step
    const again = await run("load_preset", { trackId, index: before.index, file: "/presets/4osc/mosh-bass.json" });
    expect(again.ok).toBe(true);
    expect(again.data).toMatchObject({ changed: false, reset: 0 });
    expect((await synthOn(1)).params).toEqual(after.params);

    expect((await run("undo")).ok).toBe(true);           // ONE undo takes the whole patch back
    const undone = await synthOn(1);
    expect(undone.params.map((p) => [p.value, p.display])).toEqual(baseline);
    expect(undone.state?.waveShape1?.value).toBe("sine");
    expect(undone.state?.filterType?.value).toBe("off");
  });

  it("a patch is whole: what it does not name returns to its default (lead over bass)", async () => {
    const trackId = (await snapshot()).tracks[1].id;
    await run("load_builtin", { trackId, type: "4osc" });
    await run("load_preset", { trackId, file: "/presets/4osc/mosh-bass.json" });
    const r = await run("load_preset", { trackId, file: "/presets/4osc/mosh-lead.json" });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ preset: "mosh-lead", paramsApplied: 10, settingsApplied: 6, changed: true });
    const synth = await synthOn(1);
    expect(synth.params.find((p) => p.id === "filterAmount")!.value).toBe(0.5);   // bass's +0.2 is gone
    expect(synth.state?.filterSlope?.value).toBe(12);
    expect(synth.state?.voices2?.value).toBe(3);
  });

  it("mosh-pad's spread now binds (\"Spread 2\"); nothing in the bank is unknown", async () => {
    const trackId = (await snapshot()).tracks[1].id;
    await run("load_builtin", { trackId, type: "4osc" });
    const r = await run("load_preset", { trackId, file: "/presets/4osc/mosh-pad.json" });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ plugin: "4osc", preset: "mosh-pad", paramsApplied: 10, settingsApplied: 5 });
    expect(r.data).not.toHaveProperty("unknownParams");
    expect((await synthOn(1)).params.find((p) => p.id === "spread2")!.value).toBeCloseTo(0.7, 6);
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
