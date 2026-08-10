import { beforeEach, describe, expect, it } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

describe("bridge.mock Pro Tools Track Groups", () => {
  beforeEach(() => __resetMockForTests());

  it("persists lifecycle commands and links Mix controls in one command", async () => {
    const before = await mockSnapshot<Snapshot>();
    const [drums, bass] = before.tracks;
    if (!drums || !bass) throw new Error("track-group fixtures are missing");
    const initialDelta = (bass.volumeDb ?? 0) - (drums.volumeDb ?? 0);

    const created = await mockExecute<CommandResult<{ groupId: string }>>({
      command: "create_track_group",
      args: { trackIds: [drums.id, bass.id], name: "Rhythm", kind: "edit_mix" },
    });
    expect(created).toMatchObject({ ok: true, data: { groupId: expect.any(String) } });

    expect((await mockExecute<CommandResult>({
      command: "set_track_volume",
      args: { trackId: drums.id, db: -6 },
    })).ok).toBe(true);
    expect((await mockExecute<CommandResult>({
      command: "set_track_mute",
      args: { trackId: drums.id, mute: true },
    })).ok).toBe(true);

    let project = await mockSnapshot<Snapshot>();
    const movedDrums = project.tracks.find((track) => track.id === drums.id);
    const movedBass = project.tracks.find((track) => track.id === bass.id);
    expect(project.trackGroups?.[0]).toMatchObject({ name: "Rhythm", kind: "edit_mix", enabled: true });
    expect((movedBass?.volumeDb ?? 0) - (movedDrums?.volumeDb ?? 0)).toBeCloseTo(initialDelta, 5);
    expect(movedDrums?.mute).toBe(true);
    expect(movedBass?.mute).toBe(true);

    const groupId = project.trackGroups?.[0]?.id;
    expect(groupId).toBeDefined();
    expect((await mockExecute<CommandResult>({
      command: "set_track_groups_suspended",
      args: { suspended: true },
    })).ok).toBe(true);
    expect((await mockExecute<CommandResult>({
      command: "set_track_pan",
      args: { trackId: drums.id, pan: -0.5 },
    })).ok).toBe(true);
    project = await mockSnapshot<Snapshot>();
    expect(project.trackGroupsSuspended).toBe(true);
    expect(project.tracks.find((track) => track.id === drums.id)?.pan).toBe(-0.5);
    expect(project.tracks.find((track) => track.id === bass.id)?.pan).toBe(0);

    expect((await mockExecute<CommandResult>({
      command: "remove_track_group",
      args: { groupId },
    })).ok).toBe(true);
    expect((await mockSnapshot<Snapshot>()).trackGroups).toEqual([]);
  });

  it("replaces membership atomically, rejects an empty group, and restores it with Undo", async () => {
    const before = await mockSnapshot<Snapshot>();
    const [drums, bass] = before.tracks;
    if (!drums || !bass) throw new Error("track-group fixtures are missing");
    const created = await mockExecute<CommandResult<{ groupId: string }>>({
      command: "create_track_group",
      args: { trackIds: [drums.id, bass.id], name: "Rhythm", kind: "edit_mix" },
    });
    const groupId = created.data?.groupId;
    if (!groupId) throw new Error("Track Group id was not returned");

    expect((await mockExecute<CommandResult>({
      command: "set_track_group_members",
      args: { groupId, trackIds: [drums.id] },
    })).ok).toBe(true);
    expect((await mockSnapshot<Snapshot>()).trackGroups?.[0]?.trackIds).toEqual([drums.id]);

    const rejected = await mockExecute<CommandResult>({
      command: "set_track_group_members",
      args: { groupId, trackIds: [] },
    });
    expect(rejected).toMatchObject({ ok: false, error: expect.stringMatching(/at least one track/i) });
    expect((await mockSnapshot<Snapshot>()).trackGroups?.[0]?.trackIds).toEqual([drums.id]);

    expect((await mockExecute<CommandResult>({ command: "undo", args: {} })).ok).toBe(true);
    expect((await mockSnapshot<Snapshot>()).trackGroups?.[0]?.trackIds).toEqual([drums.id, bass.id]);
  });

  it("configures every supported group field atomically and restores the prior definition with Undo", async () => {
    const before = await mockSnapshot<Snapshot>();
    const [drums, bass] = before.tracks;
    if (!drums || !bass) throw new Error("track-group fixtures are missing");
    const created = await mockExecute<CommandResult<{ groupId: string }>>({
      command: "create_track_group",
      args: { trackIds: [drums.id, bass.id], name: "Rhythm", kind: "edit_mix" },
    });
    const groupId = created.data?.groupId;
    if (!groupId) throw new Error("Track Group id was not returned");

    const configured = await mockExecute<CommandResult>({
      command: "configure_track_group",
      args: {
        groupId,
        name: "Band",
        kind: "mix",
        trackIds: [bass.id],
        mixAttributes: ["main_mute", "record_enable"],
      },
    });

    expect(configured.ok).toBe(true);
    expect((await mockSnapshot<Snapshot>()).trackGroups?.[0]).toMatchObject({
      id: groupId,
      name: "Band",
      kind: "mix",
      trackIds: [bass.id],
      mixAttributes: ["main_mute", "record_enable"],
    });
    expect((await mockExecute<CommandResult>({ command: "undo", args: {} })).ok).toBe(true);
    expect((await mockSnapshot<Snapshot>()).trackGroups?.[0]).toMatchObject({
      id: groupId,
      name: "Rhythm",
      kind: "edit_mix",
      trackIds: [drums.id, bass.id],
      mixAttributes: ["main_volume", "main_mute", "main_pan", "solo"],
    });
  });

  it("does not add an Undo step when Track Group configuration is unchanged", async () => {
    const before = await mockSnapshot<Snapshot>();
    const [drums, bass] = before.tracks;
    if (!drums || !bass) throw new Error("track-group fixtures are missing");
    const created = await mockExecute<CommandResult<{ groupId: string }>>({
      command: "create_track_group",
      args: { trackIds: [drums.id, bass.id], name: "Rhythm", kind: "edit_mix" },
    });
    const groupId = created.data?.groupId;
    if (!groupId) throw new Error("Track Group id was not returned");

    const unchanged = await mockExecute<CommandResult>({
      command: "configure_track_group",
      args: {
        groupId,
        name: "Rhythm",
        kind: "edit_mix",
        trackIds: [drums.id, bass.id],
        mixAttributes: ["main_volume", "main_mute", "main_pan", "solo"],
      },
    });
    expect(unchanged.ok).toBe(true);

    expect((await mockExecute<CommandResult>({ command: "undo", args: {} })).ok).toBe(true);
    expect((await mockSnapshot<Snapshot>()).trackGroups ?? []).toEqual([]);
  });

  it("duplicates a separate configured definition and removes only the copy with Undo", async () => {
    const before = await mockSnapshot<Snapshot>();
    const [drums, bass] = before.tracks;
    if (!drums || !bass) throw new Error("track-group fixtures are missing");
    const created = await mockExecute<CommandResult<{ groupId: string }>>({
      command: "create_track_group",
      args: { trackIds: [drums.id, bass.id], name: "Rhythm", kind: "edit_mix" },
    });
    const sourceGroupId = created.data?.groupId;
    if (!sourceGroupId) throw new Error("Track Group id was not returned");

    const duplicated = await mockExecute<CommandResult<{ groupId: string }>>({
      command: "duplicate_track_group",
      args: {
        groupId: sourceGroupId,
        name: "Rhythm Copy",
        kind: "edit",
        trackIds: [drums.id],
        mixAttributes: ["input_monitoring"],
      },
    });
    const duplicateGroupId = duplicated.data?.groupId;

    expect(duplicateGroupId).toEqual(expect.any(String));
    expect(duplicateGroupId).not.toBe(sourceGroupId);
    expect((await mockSnapshot<Snapshot>()).trackGroups).toEqual([
      expect.objectContaining({ id: sourceGroupId, name: "Rhythm" }),
      expect.objectContaining({
        id: duplicateGroupId,
        name: "Rhythm Copy",
        kind: "edit",
        trackIds: [drums.id],
        mixAttributes: ["input_monitoring"],
      }),
    ]);
    expect((await mockExecute<CommandResult>({ command: "undo", args: {} })).ok).toBe(true);
    expect((await mockSnapshot<Snapshot>()).trackGroups).toEqual([
      expect.objectContaining({ id: sourceGroupId, name: "Rhythm" }),
    ]);
  });

  it("links only the Mix controls selected by the group definition", async () => {
    const before = await mockSnapshot<Snapshot>();
    const [drums, bass] = before.tracks;
    if (!drums || !bass) throw new Error("track-group fixtures are missing");
    const initialBassVolume = bass.volumeDb;
    await mockExecute<CommandResult>({
      command: "create_track_group",
      args: {
        trackIds: [drums.id, bass.id],
        name: "Mute Link",
        kind: "mix",
        mixAttributes: ["main_mute"],
      },
    });

    await mockExecute<CommandResult>({
      command: "set_track_volume",
      args: { trackId: drums.id, db: -8 },
    });
    await mockExecute<CommandResult>({
      command: "set_track_mute",
      args: { trackId: drums.id, mute: true },
    });

    const after = await mockSnapshot<Snapshot>();
    expect(after.tracks.find((track) => track.id === bass.id)?.volumeDb).toBe(initialBassVolume);
    expect(after.tracks.find((track) => track.id === bass.id)?.mute).toBe(true);
  });
});
