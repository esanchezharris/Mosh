import { beforeEach, describe, expect, it } from "vitest";
import { __resetMockForTests, mockExecute, mockOnEvent, mockSnapshot } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });

describe("bridge mock recording finalization parity", () => {
  beforeEach(() => __resetMockForTests());

  it("lands an armed take when generic stop ends recording", async () => {
    const before = await mockSnapshot<Snapshot>();
    const trackId = before.tracks[0]!.id;
    const clipCount = before.tracks[0]!.clips.length;
    expect((await exec("arm_track", { trackId, armed: true })).ok).toBe(true);
    expect((await exec("set_transport", { action: "record" })).ok).toBe(true);

    const stopped = await exec("set_transport", { action: "stop" });
    const after = await mockSnapshot<Snapshot>();

    expect(stopped.ok).toBe(true);
    expect(after.transport.recording).toBe(false);
    expect(after.tracks[0]!.clips.length).toBe(clipCount + 1);
  });

  it("fails generic finalization without an armed capture target", async () => {
    const before = await mockSnapshot<Snapshot>();
    const clipCount = before.tracks[0]!.clips.length;
    const events: string[] = [];
    const stopListening = mockOnEvent("mosh_event", (raw) => {
      events.push((raw as { type?: string }).type ?? "");
    });
    expect((await exec("set_transport", { action: "record" })).ok).toBe(true);

    const stopped = await exec("set_transport", { action: "stop" });
    const after = await mockSnapshot<Snapshot>();
    stopListening();

    expect(stopped.ok).toBe(false);
    expect(after.transport.recording).toBe(false);
    expect(after.tracks[0]!.clips.length).toBe(clipCount);
    expect(events).toContain("snapshot_invalidated");
  });

  it("does not fabricate an explicit take on the first unarmed track", async () => {
    const before = await mockSnapshot<Snapshot>();
    const clipCount = before.tracks[0]!.clips.length;
    expect((await exec("set_transport", { action: "record" })).ok).toBe(true);

    const stopped = await exec("stop_recording");
    const data = stopped.data as { applied?: boolean; clips?: unknown[] } | undefined;
    const after = await mockSnapshot<Snapshot>();

    expect(data?.applied).toBe(false);
    expect(data?.clips).toEqual([]);
    expect(after.tracks[0]!.clips.length).toBe(clipCount);
  });

  it.each([false, true])("does not land or discard while idle (discard=%s)", async (discardRecordings) => {
    const before = await mockSnapshot<Snapshot>();
    const trackId = before.tracks[0]!.id;
    const clipCount = before.tracks[0]!.clips.length;
    const events: string[] = [];
    const stopListening = mockOnEvent("mosh_event", (raw) => {
      events.push((raw as { type?: string }).type ?? "");
    });
    await exec("arm_track", { trackId, armed: true });

    const stopped = await exec("stop_recording", { discardRecordings });
    const data = stopped.data as { applied?: boolean; clips?: unknown[]; reason?: string } | undefined;
    const after = await mockSnapshot<Snapshot>();
    stopListening();

    expect(data).toMatchObject({ applied: false, clips: [], reason: "not recording" });
    expect(after.tracks[0]!.clips.length).toBe(clipCount);
    expect(events).toContain("snapshot_invalidated");
  });

  it.each(["stop_recording", "set_transport"])("does not put a landed recording take on the undo stack via %s", async (command) => {
    const before = await mockSnapshot<Snapshot>();
    const trackId = before.tracks[0]!.id;
    const clipCount = before.tracks[0]!.clips.length;
    await exec("arm_track", { trackId, armed: true });
    await exec("set_transport", { action: "record" });
    await exec(command, command === "set_transport" ? { action: "stop" } : {});

    const undone = await exec("undo");
    const after = await mockSnapshot<Snapshot>();

    expect(undone.data).toEqual({ undone: false });
    expect(after.tracks[0]!.clips.length).toBe(clipCount + 1);
  });

  it("logs stop_recording as non-undoable", async () => {
    await exec("stop_recording");
    const log = await exec("get_command_log", { limit: 20 });
    const entries = (log.data as { entries?: { command: string; undoable: boolean }[] } | undefined)?.entries ?? [];

    expect(entries.find((entry) => entry.command === "stop_recording")?.undoable).toBe(false);
  });

  it("generic record while active lands the take and stays stopped", async () => {
    const trackId = (await mockSnapshot<Snapshot>()).tracks[0]!.id;
    await exec("arm_track", { trackId, armed: true });
    await exec("set_transport", { action: "record" });

    const stopped = await exec("set_transport", { action: "record" });
    const after = await mockSnapshot<Snapshot>();

    expect(stopped.ok).toBe(true);
    expect(after.transport.recording).toBe(false);
    expect(after.transport.playing).toBe(false);
  });

  it("promotes one playlist region into three undoable comp segments", async () => {
    const created = await exec("create_track", { name: "Comp Vocal" });
    const trackId = typeof created.data === "object" && created.data !== null
      ? Reflect.get(created.data, "trackId")
      : undefined;
    if (typeof trackId !== "string") throw new Error("create_track did not return a trackId");
    await exec("arm_track", { trackId, armed: true });
    for (let take = 0; take < 2; take += 1) {
      await exec("set_transport", { action: "record" });
      await exec("set_transport", { action: "stop" });
    }
    let track = (await mockSnapshot<Snapshot>()).tracks.find((candidate) => candidate.id === trackId)!;
    const clipId = track.clips[0]!.id;
    await exec("set_current_take", { clipId, takeIndex: 0 });

    const promoted = await exec("promote_take_region", {
      clipId,
      takeIndex: 1,
      start: 0.5,
      end: 1.5,
    });
    expect(promoted).toMatchObject({
      ok: true,
      data: { takeIndex: 1, start: 0.5, end: 1.5, applied: true },
    });
    track = (await mockSnapshot<Snapshot>()).tracks.find((candidate) => candidate.id === trackId)!;
    const segments = [...track.clips].sort((a, b) => a.start - b.start);
    expect(segments.map((clip) => [clip.start, clip.length, clip.offset, clip.currentTakeIndex])).toEqual([
      [0, 0.5, 0, 0],
      [0.5, 1, 0.5, 1],
      [1.5, 0.5, 1.5, 0],
    ]);
    expect(segments.every((clip) => clip.numTakes === 2 && clip.takes?.length === 2)).toBe(true);
    const promotedClipId = typeof promoted.data === "object" && promoted.data !== null
      ? Reflect.get(promoted.data, "clipId")
      : undefined;
    const tailClipId = typeof promoted.data === "object" && promoted.data !== null
      ? Reflect.get(promoted.data, "newClipId")
      : undefined;
    expect(promotedClipId).toBe(segments[1]!.id);
    expect(tailClipId).toBe(segments[2]!.id);

    expect((await exec("undo")).data).toEqual({ undone: true });
    track = (await mockSnapshot<Snapshot>()).tracks.find((candidate) => candidate.id === trackId)!;
    expect(track.clips).toHaveLength(1);
    expect(track.clips[0]!.currentTakeIndex).toBe(0);
    expect((await exec("redo")).data).toEqual({ redone: true });
    track = (await mockSnapshot<Snapshot>()).tracks.find((candidate) => candidate.id === trackId)!;
    expect(track.clips).toHaveLength(3);

    const log = await exec("get_command_log", { limit: 20 });
    const entries = typeof log.data === "object" && log.data !== null
      ? Reflect.get(log.data, "entries")
      : undefined;
    expect(Array.isArray(entries) && entries.some((entry) =>
      typeof entry === "object" && entry !== null
      && Reflect.get(entry, "command") === "promote_take_region"
      && Reflect.get(entry, "undoable") === true)).toBe(true);
  });
});
