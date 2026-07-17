import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMockForTests, mockSnapshot } from "../bridge.mock";
import { useStore } from "../store";
import type { Snapshot } from "../types";
import { runAgentBatch, undoAgentBatch } from "./executor";
import { runSkill, type SkillHarnessDeps } from "./skillHarness";
import { SET_TRACK_LEVEL_SKILL, type SkillDefinition } from "./skills";

async function snapshot(): Promise<Snapshot> {
  return mockSnapshot<Snapshot>();
}

function firstTrack(value: Snapshot) {
  const track = value.tracks[0];
  if (!track) throw new Error("fixture has no track");
  return track;
}

const mockDeps: SkillHarnessDeps = {
  snapshot,
  runBatch: runAgentBatch,
  rollbackBatch: undoAgentBatch,
};

describe("skill harness failure accounting", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("reports an unconfirmed rollback when the undo seam has no history", async () => {
    expect(await undoAgentBatch()).toBe(false);
  });

  it("confirms rollback after a failed postcondition", async () => {
    const before = await snapshot();
    const track = firstTrack(before);
    const impossible: SkillDefinition = {
      ...SET_TRACK_LEVEL_SKILL,
      name: "impossible_postcondition",
      postcondition: () => ({ ok: false, reason: "expected failure" }),
    };

    const result = await runSkill(
      impossible,
      { trackId: track.id, db: -12, mute: true },
      mockDeps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("postcondition");
      expect(result.reason).toContain("expected failure");
      expect(result.rolledBack).toBe(true);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("confirms rollback after a reported partial command failure", async () => {
    const before = await snapshot();
    const track = firstTrack(before);
    const partialFailure: SkillDefinition = {
      ...SET_TRACK_LEVEL_SKILL,
      name: "partial_failure",
      template: [
        {
          kind: "command",
          command: "set_track_volume",
          args: { trackId: { slot: "trackId" }, db: { slot: "db" } },
        },
        {
          kind: "command",
          command: "set_track_mute",
          args: { trackId: "missing-track", mute: true },
        },
      ],
    };

    const result = await runSkill(
      partialFailure,
      { trackId: track.id, db: -18 },
      mockDeps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("execution");
      expect(result.rolledBack).toBe(true);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("does not claim rollback when batch transport rejects", async () => {
    const track = firstTrack(await snapshot());
    const rollbackBatch = vi.fn(async () => true);
    const result = await runSkill(
      SET_TRACK_LEVEL_SKILL,
      { trackId: track.id, db: -6 },
      {
        snapshot,
        runBatch: async () => { throw new Error("connection lost"); },
        rollbackBatch,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("execution");
      expect(result.rolledBack).toBe(false);
      expect(result.reason).toContain("Mutation state is unknown");
    }
    expect(rollbackBatch).not.toHaveBeenCalled();
  });

  it("does not claim rollback when undo reports no mutation", async () => {
    const track = firstTrack(await snapshot());
    const result = await runSkill(
      SET_TRACK_LEVEL_SKILL,
      { trackId: track.id, db: -6 },
      {
        snapshot,
        runBatch: async (_label, calls) => ({
          label: "set_track_level",
          applied: 1,
          entries: calls.map((call, index) => ({
            index,
            command: call.command,
            summary: call.command,
            ok: index !== 0,
            error: index === 0 ? "reported failure" : undefined,
          })),
        }),
        rollbackBatch: async () => false,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rolledBack).toBe(false);
      expect(result.reason).toContain("Rollback was not confirmed");
    }
  });

  it("rejects incomplete per-command results and rolls back reported mutations", async () => {
    const track = firstTrack(await snapshot());
    const rollbackBatch = vi.fn(async () => true);
    const result = await runSkill(
      SET_TRACK_LEVEL_SKILL,
      { trackId: track.id, db: -6, mute: true },
      {
        snapshot,
        runBatch: async () => ({
          label: "set_track_level",
          applied: 1,
          entries: [{ index: 0, command: "set_track_volume", summary: "volume", ok: true }],
        }),
        rollbackBatch,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("1/2 command results");
      expect(result.rolledBack).toBe(true);
    }
    expect(rollbackBatch).toHaveBeenCalledOnce();
  });

  it("rejects a result whose command identity does not match its index", async () => {
    const track = firstTrack(await snapshot());
    const rollbackBatch = vi.fn(async () => true);
    const result = await runSkill(
      SET_TRACK_LEVEL_SKILL,
      { trackId: track.id, db: -6 },
      {
        snapshot,
        runBatch: async () => ({
          label: "set_track_level",
          applied: 1,
          entries: [{ index: 0, command: "set_track_mute", summary: "wrong command", ok: true }],
        }),
        rollbackBatch,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("does not match its command");
      expect(result.rolledBack).toBe(true);
    }
    expect(rollbackBatch).toHaveBeenCalledOnce();
  });

  it("keeps a successful two-command skill in one undo step", async () => {
    const before = await snapshot();
    const track = firstTrack(before);
    expect((await runSkill(
      SET_TRACK_LEVEL_SKILL,
      { trackId: track.id, db: -15, mute: true },
      mockDeps,
    )).ok).toBe(true);
    expect(await snapshot()).not.toEqual(before);
    expect(await undoAgentBatch()).toBe(true);
    expect(await snapshot()).toEqual(before);
  });
});
