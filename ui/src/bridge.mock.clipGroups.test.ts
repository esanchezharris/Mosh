import { beforeEach, describe, expect, it } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

async function snapshot(): Promise<Snapshot> {
  return mockSnapshot<Snapshot>();
}

function clipStart(project: Snapshot, clipId: string): number | undefined {
  return project.tracks.flatMap((track) => track.clips)
    .find((clip) => clip.id === clipId)?.start;
}

describe("bridge.mock Pro Tools clip groups", () => {
  beforeEach(() => __resetMockForTests());

  it("groups clips as one arrangement object, ungroups, and regroups the last group", async () => {
    const project = await snapshot();
    const first = project.tracks[0]?.clips[0];
    const second = project.tracks[1]?.clips[0];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    const grouped = await mockExecute<CommandResult<{ groupId: string }>>({
      command: "create_clip_group",
      args: { clipIds: [first.id, second.id], name: "Rhythm Group" },
    });
    expect(grouped).toMatchObject({ ok: true, data: { groupId: expect.any(String) } });

    expect((await mockExecute<CommandResult>({
      command: "move_clip",
      args: { clipId: first.id, start: 2 },
    })).ok).toBe(true);
    let moved = await snapshot();
    expect(clipStart(moved, first.id)).toBe(2);
    expect(clipStart(moved, second.id)).toBe(2);

    expect((await mockExecute<CommandResult>({
      command: "ungroup_clip_group",
      args: { clipId: first.id },
    })).ok).toBe(true);
    expect((await mockExecute<CommandResult>({
      command: "move_clip",
      args: { clipId: first.id, start: 4 },
    })).ok).toBe(true);
    moved = await snapshot();
    expect(clipStart(moved, first.id)).toBe(4);
    expect(clipStart(moved, second.id)).toBe(2);

    expect((await mockExecute<CommandResult>({
      command: "regroup_clip_group",
      args: {},
    })).ok).toBe(true);
    expect((await mockExecute<CommandResult>({
      command: "move_clip",
      args: { clipId: first.id, start: 5 },
    })).ok).toBe(true);
    moved = await snapshot();
    expect(clipStart(moved, first.id)).toBe(5);
    expect(clipStart(moved, second.id)).toBe(3);
  });

  it("undoes each group lifecycle mutation as one transaction", async () => {
    const project = await snapshot();
    const first = project.tracks[0]?.clips[0];
    const second = project.tracks[1]?.clips[0];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    expect((await mockExecute<CommandResult>({
      command: "create_clip_group",
      args: { clipIds: [first.id, second.id] },
    })).ok).toBe(true);
    expect((await mockExecute<CommandResult>({
      command: "move_clip",
      args: { clipId: first.id, start: 2 },
    })).ok).toBe(true);
    expect((await mockExecute<CommandResult>({ command: "undo", args: {} })).ok).toBe(true);

    const restored = await snapshot();
    expect(clipStart(restored, first.id)).toBe(0);
    expect(clipStart(restored, second.id)).toBe(0);
  });
});
