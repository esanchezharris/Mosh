import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMockForTests, mockSnapshot } from "../bridge.mock";
import { useStore } from "../store";
import type { Snapshot } from "../types";
import { runAgentBatch, undoAgentBatch } from "./executor";
import { runSkill, type SkillHarnessDeps } from "./skillHarness";
import {
  SET_TRACK_LEVEL_SKILL,
  type SkillDefinition,
  type SkillSlotValues,
} from "./skills";

const mockDeps: SkillHarnessDeps = {
  snapshot: () => mockSnapshot<Snapshot>(),
  runBatch: runAgentBatch,
  rollbackBatch: undoAgentBatch,
};

async function snapshot(): Promise<Snapshot> {
  return mockSnapshot<Snapshot>();
}

function firstTrack(value: Snapshot) {
  const track = value.tracks[0];
  if (!track) throw new Error("fixture has no track");
  return track;
}

function trackById(value: Snapshot, trackId: string) {
  const track = value.tracks.find((candidate) => candidate.id === trackId);
  if (!track) throw new Error(`fixture is missing track ${trackId}`);
  return track;
}

describe("skill harness", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("runs set_track_level end-to-end through the mock-backed MoshOps batch", async () => {
    const before = await snapshot();
    const track = firstTrack(before);
    const seen: string[] = [];
    const deps: SkillHarnessDeps = {
      ...mockDeps,
      runBatch: async (label, calls) => {
        seen.push(...calls.map((call) => call.command));
        return runAgentBatch(label, calls);
      },
    };

    const result = await runSkill(
      SET_TRACK_LEVEL_SKILL,
      { trackId: track.id, db: -6, mute: true },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(seen).toEqual(["set_track_volume", "set_track_mute"]);
    const afterTrack = trackById(await snapshot(), track.id);
    expect(afterTrack.volumeDb).toBe(-6);
    expect(afterTrack.mute).toBe(true);
  });

  it("treats mute:false as present and executes the conditional command", async () => {
    const track = firstTrack(await snapshot());
    await useStore.getState().exec("set_track_mute", { trackId: track.id, mute: true });
    await useStore.getState().refresh();

    const result = await runSkill(
      SET_TRACK_LEVEL_SKILL,
      { trackId: track.id, db: -4.5, mute: false },
      mockDeps,
    );

    expect(result.ok).toBe(true);
    const afterTrack = trackById(await snapshot(), track.id);
    expect(afterTrack.volumeDb).toBe(-4.5);
    expect(afterTrack.mute).toBe(false);
  });

  it("skips the conditional command when mute is omitted and preserves prior mute state", async () => {
    const track = firstTrack(await snapshot());
    await useStore.getState().exec("set_track_mute", { trackId: track.id, mute: true });
    await useStore.getState().refresh();

    const seen: string[] = [];
    const deps: SkillHarnessDeps = {
      ...mockDeps,
      runBatch: async (label, calls) => {
        seen.push(...calls.map((call) => call.command));
        return runAgentBatch(label, calls);
      },
    };
    const result = await runSkill(
      SET_TRACK_LEVEL_SKILL,
      { trackId: track.id, db: -9 },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(seen).toEqual(["set_track_volume"]);
    const afterTrack = trackById(await snapshot(), track.id);
    expect(afterTrack.volumeDb).toBe(-9);
    expect(afterTrack.mute).toBe(true);
  });

  it.each([
    ["missing required slot", { trackId: "11" }],
    ["unknown slot", { trackId: "11", db: -6, surprise: true }],
    ["wrong primitive type", { trackId: "11", db: "-6" }],
    ["non-finite number", { trackId: "11", db: Number.NaN }],
    ["number below range", { trackId: "11", db: -61 }],
    ["number above range", { trackId: "11", db: 6.5 }],
  ])("rejects %s before execution", async (_label, rawSlots) => {
    const before = await snapshot();
    const runBatch = vi.fn();
    const rollbackBatch = vi.fn();

    const result = await runSkill(SET_TRACK_LEVEL_SKILL, rawSlots, {
      snapshot,
      runBatch,
      rollbackBatch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("validation");
    expect(runBatch).not.toHaveBeenCalled();
    expect(rollbackBatch).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it("rejects a failed precondition before execution", async () => {
    const before = await snapshot();
    const runBatch = vi.fn();
    const rollbackBatch = vi.fn();

    const result = await runSkill(
      SET_TRACK_LEVEL_SKILL,
      { trackId: "missing-track", db: -6 },
      { snapshot, runBatch, rollbackBatch },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("precondition");
      expect(result.reason).toContain("missing-track");
    }
    expect(runBatch).not.toHaveBeenCalled();
    expect(rollbackBatch).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it("preflights expanded MoshOps calls before execution", async () => {
    const before = await snapshot();
    const track = firstTrack(before);
    const runBatch = vi.fn();
    const invalidTemplate: SkillDefinition = {
      ...SET_TRACK_LEVEL_SKILL,
      name: "invalid_template",
      template: [{ kind: "command", command: "not_a_moshops_command", args: {} }],
    };

    const result = await runSkill(
      invalidTemplate,
      { trackId: track.id, db: -6 },
      { snapshot, runBatch, rollbackBatch: vi.fn() },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("template");
      expect(result.reason).toContain("not an allowed command");
    }
    expect(runBatch).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it("rejects group tracks before execution", async () => {
    const member = firstTrack(await snapshot());
    await useStore.getState().exec("create_group_track", { trackIds: [member.id] });
    await useStore.getState().refresh();
    const group = (await snapshot()).tracks.find((track) => track.isGroup);
    if (!group) throw new Error("fixture did not create a group track");
    const runBatch = vi.fn();

    const result = await runSkill(
      SET_TRACK_LEVEL_SKILL,
      { trackId: group.id, db: -6, mute: true },
      { snapshot, runBatch, rollbackBatch: async () => false },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("precondition");
      expect(result.reason).toContain("group");
    }
    expect(runBatch).not.toHaveBeenCalled();
  });

  it("accepts a typed slot record without mutating the caller's values", async () => {
    const track = firstTrack(await snapshot());
    const slots: SkillSlotValues = { trackId: track.id, db: -3, mute: false };
    const copy = { ...slots };

    expect((await runSkill(SET_TRACK_LEVEL_SKILL, slots, mockDeps)).ok).toBe(true);
    expect(slots).toEqual(copy);
  });
});
