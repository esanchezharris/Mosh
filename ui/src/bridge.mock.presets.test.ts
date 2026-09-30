import { beforeEach, describe, expect, it } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

const run = (command: string, args: Record<string, unknown> = {}) => mockExecute<CommandResult>({ command, args });
const snapshot = () => mockSnapshot<Snapshot>();

describe("bridge.mock — presets mirror the engine", () => {
  beforeEach(() => __resetMockForTests());

  it("a built-in 4OSC carries a patch surface, a preset rewrites it, one undo restores it", async () => {
    const trackId = (await snapshot()).tracks[1].id;     // Bass: MIDI clips, no wave audio
    expect((await run("load_builtin", { trackId, type: "4osc" })).ok).toBe(true);
    const before = (await snapshot()).tracks[1].plugins!.find((p) => p.type === "4osc")!;
    expect(before.params.length).toBe(8);
    const baseline = before.params.map((p) => p.value);

    const loaded = await run("load_preset", { trackId, index: before.index, file: "/presets/4osc/Bass.json" });
    expect(loaded.ok).toBe(true);
    expect((loaded.data as { paramsApplied: number }).paramsApplied).toBe(8);
    const after = (await snapshot()).tracks[1].plugins!.find((p) => p.type === "4osc")!.params.map((p) => p.value);
    expect(after).not.toEqual(baseline);                 // anti-vacuity: the preset moved something
    expect(after.every((v) => v >= 0 && v <= 1)).toBe(true);

    const again = await run("load_preset", { trackId, index: before.index, file: "/presets/4osc/Bass.json" });
    expect(again.ok).toBe(true);
    expect((await snapshot()).tracks[1].plugins!.find((p) => p.type === "4osc")!.params.map((p) => p.value)).toEqual(after); // deterministic

    expect((await run("undo")).ok).toBe(true);
    expect((await run("undo")).ok).toBe(true);
    expect((await snapshot()).tracks[1].plugins!.find((p) => p.type === "4osc")!.params.map((p) => p.value)).toEqual(baseline);
  });

  it("refuses a 4OSC preset on a track without a 4OSC", async () => {
    const trackId = (await snapshot()).tracks[2].id;
    const r = await run("load_preset", { trackId, index: 0, file: "/presets/4osc/Bass.json" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no 4OSC instrument/);
  });
});
