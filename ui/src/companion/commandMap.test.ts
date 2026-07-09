import { describe, expect, it } from "vitest";
import { planFor, seekPlan, targetTrackId } from "./commandMap";
import type { Snap } from "./types";

const snap = (over: Partial<Snap> = {}): Snap => ({
  session: { tempo: 130, length: 60 },
  tracks: [{ id: "t1", name: "VOX", armed: false, clips: [] }],
  transport: { playing: false, recording: false, position: 0 },
  controller: { mode: "capture", record: "idle", take: { exists: false } },
  ...over,
});

describe("targetTrackId", () => {
  it("prefers the take's track, then an armed track, then the first", () => {
    expect(targetTrackId(snap({ controller: { take: { exists: true, trackId: "tk" } } }))).toBe("tk");
    expect(
      targetTrackId(snap({ tracks: [{ id: "a" }, { id: "b", armed: true }], controller: { take: { exists: false } } })),
    ).toBe("b");
    expect(targetTrackId(snap({ tracks: [{ id: "a" }, { id: "b" }] }))).toBe("a");
    expect(targetTrackId(snap({ tracks: [] }))).toBeUndefined();
  });
});

describe("planFor", () => {
  it("record arms an unarmed target then records", () => {
    const { cmds } = planFor("record", snap());
    expect(cmds.map((c) => c.command)).toEqual(["arm_track", "set_transport"]);
    expect(cmds[0].args).toMatchObject({ trackId: "t1", armed: true });
    expect(cmds[1].args).toMatchObject({ action: "record", source: "phone_controller" });
  });

  it("record skips arming when the target is already armed", () => {
    const { cmds } = planFor("record", snap({ tracks: [{ id: "t1", armed: true }] }));
    expect(cmds.map((c) => c.command)).toEqual(["set_transport"]);
  });

  it("keep commits the current take lane by clipId", () => {
    const s = snap({ controller: { take: { exists: true, clipId: "c9", canKeep: true, trackId: "t1" } } });
    const { cmds, blockedReason } = planFor("keep", s);
    expect(blockedReason).toBeUndefined();
    expect(cmds).toEqual([
      { command: "keep_take", args: { clipId: "c9", source: "phone_controller", controllerLabel: "kept" } },
    ]);
  });

  it("keep is blocked with no active take", () => {
    const { cmds, blockedReason } = planFor("keep", snap());
    expect(cmds).toEqual([]);
    expect(blockedReason).toBeTruthy();
  });

  it("again undoes the last take then re-records", () => {
    const { cmds } = planFor("again", snap({ tracks: [{ id: "t1", armed: true }] }));
    expect(cmds.map((c) => c.command)).toEqual(["undo", "set_transport"]);
    expect(cmds[0].args).toMatchObject({ controllerLabel: "undone" });
    expect(cmds[1].args).toMatchObject({ action: "record" });
  });

  it("hear plays from the take start", () => {
    const s = snap({ controller: { take: { exists: true, start: 4.5 } } });
    const { cmds } = planFor("hear", s);
    expect(cmds).toEqual([
      { command: "set_transport", args: { action: "play", position: 4.5, source: "phone_controller" } },
    ]);
  });

  it("marker flags the current position and active clip", () => {
    const s = snap({
      transport: { playing: false, recording: false, position: 9.25 },
      controller: { take: { exists: true, clipId: "c9" } },
    });
    expect(planFor("marker", s).cmds).toEqual([
      {
        command: "mark_take",
        args: { clipId: "c9", position: 9.25, source: "phone_controller", controllerLabel: "flagged" },
      },
    ]);
  });

  it("stop stops the transport", () => {
    expect(planFor("stop", snap()).cmds).toEqual([
      { command: "set_transport", args: { action: "stop", source: "phone_controller" } },
    ]);
  });
});

describe("seekPlan", () => {
  it("emits a positional set_transport, floored at 0", () => {
    expect(seekPlan(12.5).cmds[0].args).toMatchObject({ position: 12.5, source: "phone_controller" });
    expect(seekPlan(-3).cmds[0].args).toMatchObject({ position: 0 });
  });
});
