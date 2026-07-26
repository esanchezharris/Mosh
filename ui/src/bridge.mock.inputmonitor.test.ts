import { describe, it, expect } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

// UI-REACH — mock-drift guard for set_input_monitor. A mock that is merely "plausible"
// makes every test written against it vacuous (this repo's own recurring failure mode —
// see CLAUDE.md's stem-export note): before this fix, the mock returned {monitor} where
// native returns {trackId, mode, applied, reason?} — a shape drift a UI reading
// `.data.applied` would never have caught in dev/e2e, only in a real build.

const snap = () => mockSnapshot<Snapshot>();

describe("bridge.mock set_input_monitor — result shape matches native (MoshOps.cpp cmdSetInputMonitor)", () => {
  it("returns {trackId, mode, applied: true}, not the old {monitor}", async () => {
    __resetMockForTests();
    const s = await snap();
    const track = s.tracks[0];

    const res = await mockExecute<CommandResult<{ trackId: string; mode: string; applied: boolean; monitor?: unknown }>>({
      command: "set_input_monitor",
      args: { trackId: track.id, mode: "on" },
    });

    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ trackId: track.id, mode: "on", applied: true });
    expect(res.data?.monitor, "the old shape's field must be gone, not just accompanied").toBeUndefined();
  });

  it("is non-undoable — it does not push an undo step", async () => {
    __resetMockForTests();
    const s0 = await snap();
    const track = s0.tracks[0];
    await mockExecute({ command: "set_input_monitor", args: { trackId: track.id, mode: "on" } });

    // A fresh session (post-reset) has an empty undo history; if set_input_monitor had
    // pushed one, this would report undone:true. It must report false — matching the
    // native contract that this is a device/engine preference, not an Edit-tree write.
    const undo = await mockExecute<CommandResult<{ undone: boolean }>>({ command: "undo", args: {} });
    expect(undo.data?.undone).toBe(false);
    const s1 = await snap();
    expect(s1.tracks.find((t) => t.id === track.id)?.monitor).toBe("on");
  });

  it("falls back to automatic for an unrecognized mode, same as the native validator's shape", async () => {
    __resetMockForTests();
    const s = await snap();
    const track = s.tracks[0];
    const res = await mockExecute<CommandResult<{ mode: string }>>({
      command: "set_input_monitor",
      args: { trackId: track.id, mode: "bogus" },
    });
    expect(res.data?.mode).toBe("automatic");
  });
});
