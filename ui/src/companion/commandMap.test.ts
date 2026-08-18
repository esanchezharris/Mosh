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

  // DAWN's KeepTake.lua commits the take, scoots the record cursor forward, and
  // punches straight back in. All three matter: the seek + record ARE the loop's
  // forward momentum, and sending keep_take alone (as this used to) moved nothing.
  it("keep commits the lane, advances past the take, and rolls again", () => {
    const s = snap({
      tracks: [{ id: "t1", armed: true }],
      controller: { take: { exists: true, clipId: "c9", canKeep: true, trackId: "t1", start: 8, length: 4 } },
    });
    const { cmds, blockedReason } = planFor("keep", s);
    expect(blockedReason).toBeUndefined();
    expect(cmds.map((c) => c.command)).toEqual(["keep_take", "set_transport", "set_transport"]);
    expect(cmds[0].args).toMatchObject({ clipId: "c9", controllerLabel: "kept" });
    expect(cmds[1].args).toMatchObject({ position: 12 }); // 8 + 4 — flush against the kept take
    expect(cmds[2].args).toMatchObject({ action: "record" });
  });

  // canKeep is `hasAnyTakes()`. A single pass has no stacked lanes, so keep_take
  // would error "no takes to keep" — but the take is still committed and the loop
  // must still move on, which the old `canKeep === false` guard blocked outright.
  it("keep still advances and rolls when no lanes were stacked", () => {
    const s = snap({
      tracks: [{ id: "t1", armed: true }],
      controller: { take: { exists: true, clipId: "c9", canKeep: false, trackId: "t1", start: 2, length: 3 } },
    });
    const { cmds, blockedReason } = planFor("keep", s);
    expect(blockedReason).toBeUndefined();
    expect(cmds.map((c) => c.command)).toEqual(["set_transport", "set_transport"]);
    expect(cmds[0].args).toMatchObject({ position: 5 });
    expect(cmds[1].args).toMatchObject({ action: "record" });
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

  // The bug this guards, measured live: undo removes the take but leaves the
  // playhead at the take END, so re-recording lands a full take-length late and
  // leaves a silent hole. REAPER keeps the cursor at the take start, which is why
  // DAWN's RedoTake.lua can say "do NOT change time selection"; Mosh must seek.
  it("again rewinds to the take start before re-recording", () => {
    const s = snap({
      tracks: [{ id: "t1", armed: true }],
      controller: { take: { exists: true, clipId: "c9", trackId: "t1", start: 11.04, length: 2.94 } },
    });
    const { cmds } = planFor("again", s);
    expect(cmds.map((c) => c.command)).toEqual(["undo", "set_transport", "set_transport"]);
    expect(cmds[1].args).toMatchObject({ position: 11.04 });
    expect(cmds[2].args).toMatchObject({ action: "record" });
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
