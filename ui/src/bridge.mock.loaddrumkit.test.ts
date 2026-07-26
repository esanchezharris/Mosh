import { describe, it, expect } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

// UI-REACH — mock-drift guard for load_drum_kit. Before this fix the mock dropped
// `index` (the sampler's position in the track's plugin rack) from its result, unlike
// native's {trackId, index, pads} (MoshOps.cpp cmdLoadDrumKit) — a mock that is merely
// "plausible" makes every test written against it vacuous.

const snap = () => mockSnapshot<Snapshot>();

describe("bridge.mock load_drum_kit — result shape matches native (MoshOps.cpp cmdLoadDrumKit)", () => {
  it("returns {trackId, index, pads}, with index now present (was dropped before)", async () => {
    __resetMockForTests();
    const created = await mockExecute<CommandResult<{ trackId: string }>>({
      command: "create_track",
      args: { name: "Kit" },
    });
    const trackId = created.data!.trackId;

    const res = await mockExecute<CommandResult<{ trackId: string; index: number; pads: number }>>({
      command: "load_drum_kit",
      args: { trackId },
    });
    expect(res.ok).toBe(true);
    expect(res.data?.trackId).toBe(trackId);
    expect(res.data?.pads).toBe(8);
    expect(typeof res.data?.index).toBe("number");
    expect(res.data?.index).toBeGreaterThanOrEqual(0); // the sampler is genuinely in the rack
  });

  it("is undoable — undo removes the sampler load_drum_kit added", async () => {
    __resetMockForTests();
    const created = await mockExecute<CommandResult<{ trackId: string }>>({
      command: "create_track",
      args: { name: "Kit2" },
    });
    const trackId = created.data!.trackId;
    const before = (await snap()).tracks.find((t) => t.id === trackId)!;
    expect(before.plugins?.some((p) => p.type === "sampler")).toBeFalsy();

    await mockExecute({ command: "load_drum_kit", args: { trackId } });
    const after = (await snap()).tracks.find((t) => t.id === trackId)!;
    expect(after.plugins?.some((p) => p.type === "sampler")).toBe(true);

    await mockExecute({ command: "undo", args: {} });
    const restored = (await snap()).tracks.find((t) => t.id === trackId)!;
    expect(restored.plugins?.some((p) => p.type === "sampler")).toBeFalsy();
  });
});
