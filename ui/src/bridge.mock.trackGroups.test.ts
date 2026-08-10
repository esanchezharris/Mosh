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
});
