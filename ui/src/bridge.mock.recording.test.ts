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

  // Skill Foundry Slice B, Task 1 — stable, persisted take identity (mirrors the native
  // state/TakeIdentity.h RED/GREEN suite in tests/test_take_identity.cpp and the
  // SelfTest.cpp "Stable take identity" section).
  describe("stable take identity", () => {
    async function twoTakeFixture() {
      const created = await exec("create_track", { name: "Take ID Fixture" });
      const trackId = typeof created.data === "object" && created.data !== null
        ? Reflect.get(created.data, "trackId") : undefined;
      if (typeof trackId !== "string") throw new Error("create_track did not return a trackId");
      await exec("arm_track", { trackId, armed: true });
      for (let take = 0; take < 2; take += 1) {
        await exec("set_transport", { action: "record" });
        await exec("set_transport", { action: "stop" });
      }
      const track = (await mockSnapshot<Snapshot>()).tracks.find((candidate) => candidate.id === trackId)!;
      const clipId = track.clips[0]!.id;
      return { trackId, clipId };
    }

    it("list_takes reports two unique, non-empty, uuid-shaped stable ids", async () => {
      const { clipId } = await twoTakeFixture();
      const listed = await exec("list_takes", { clipId });
      const data = listed.data as { takes?: { id?: string }[]; takeIds?: string[]; currentTakeId?: string } | undefined;
      expect(data?.takes).toHaveLength(2);
      const [id0, id1] = data!.takes!.map((tk) => tk.id);
      expect(id0).toBeTruthy();
      expect(id1).toBeTruthy();
      expect(id0).not.toBe(id1);
      const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      expect(id0).toMatch(uuidShape);
      expect(id1).toMatch(uuidShape);
      expect(data?.takeIds).toEqual([id0, id1]);
      expect(data?.currentTakeId).toBe(id1); // the SECOND recording landed last and is current
    });

    it("clip snapshot's takeIds/currentTakeId agree with list_takes", async () => {
      const { clipId } = await twoTakeFixture();
      const listed = await exec("list_takes", { clipId });
      const listedIds = (listed.data as { takeIds?: string[] }).takeIds;
      const snap = await mockSnapshot<Snapshot>();
      const clip = snap.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!;
      expect(clip.takeIds).toEqual(listedIds);
      expect(clip.currentTakeId).toBe(listedIds?.[1]);
    });

    it("keep_take refuses a malformed takeId with zero mutation", async () => {
      const { clipId } = await twoTakeFixture();
      const before = await exec("list_takes", { clipId });
      const result = await exec("keep_take", { clipId, takeId: "not-a-real-id" });
      expect(result.ok).toBe(false);
      const after = await exec("list_takes", { clipId });
      expect(after.data).toEqual(before.data);
    });

    it("keep_take refuses an unknown (but well-shaped) takeId with zero mutation", async () => {
      const { clipId } = await twoTakeFixture();
      const before = await exec("list_takes", { clipId });
      const result = await exec("keep_take", { clipId, takeId: "ffffffff-0000-4000-8000-000000000000" });
      expect(result.ok).toBe(false);
      const after = await exec("list_takes", { clipId });
      expect(after.data).toEqual(before.data);
    });

    it("keep_take with an explicit stable id keeps THAT take (not whichever is current) and collapses the lane set", async () => {
      const { clipId } = await twoTakeFixture();
      const listed = await exec("list_takes", { clipId });
      const data = listed.data as { takeIds?: string[]; currentTakeId?: string };
      const [id0] = data.takeIds!;
      // id0 is the FIRST take ("Take 1"); the SECOND take ("Take 2") is current by
      // default — targeting id0 explicitly must keep take 1's content, not whichever
      // is current, proving the id actually SELECTS rather than being ignored.
      expect(data.currentTakeId).not.toBe(id0);
      const kept = await exec("keep_take", { clipId, takeId: id0 });
      expect(kept.ok).toBe(true);
      const snap = await mockSnapshot<Snapshot>();
      const clip = snap.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!;
      expect(clip.name).toBe("Take 1");
      expect(clip.takes).toBeUndefined();
      expect(clip.numTakes).toBeUndefined();
      expect(clip.takeIds).toBeUndefined();
      expect(clip.currentTakeId).toBeUndefined();
    });

    it("one undo after keep_take-by-id restores the exact prior ordered id set", async () => {
      const { clipId } = await twoTakeFixture();
      const listed = await exec("list_takes", { clipId });
      const priorIds = (listed.data as { takeIds?: string[] }).takeIds!;
      await exec("keep_take", { clipId, takeId: priorIds[0] });
      expect((await exec("undo")).data).toEqual({ undone: true });
      const relisted = await exec("list_takes", { clipId });
      const relistedIds = (relisted.data as { takeIds?: string[] }).takeIds;
      expect(relistedIds).toEqual(priorIds); // the EXACT prior ids, not fresh ones
    });

    it("legacy {clipId}-only keep_take is unchanged: it keeps whichever take is current", async () => {
      const { clipId } = await twoTakeFixture();
      const listed = await exec("list_takes", { clipId });
      const currentTakeId = (listed.data as { currentTakeId?: string }).currentTakeId;
      expect(currentTakeId).toBeTruthy();
      const kept = await exec("keep_take", { clipId });
      expect(kept.ok).toBe(true);
      const snap = await mockSnapshot<Snapshot>();
      const clip = snap.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!;
      expect(clip.takes).toBeUndefined();
    });
  });
});
