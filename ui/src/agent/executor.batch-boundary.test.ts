import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMockForTests, mockSnapshot } from "../bridge.mock";
import { useStore } from "../store";
import type { Snapshot } from "../types";
import { runAgentBatch, undoAgentBatch } from "./executor";
import { runSkill } from "./skillHarness";
import { SET_TRACK_LEVEL_SKILL } from "./skills";

describe("agent batch boundary failures", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not dispatch commands after batch_begin returns a failure envelope", async () => {
    const seen: string[] = [];
    const state = useStore.getState();
    const original = state.exec;
    vi.spyOn(state, "exec").mockImplementation(async (command, args) => {
      seen.push(command);
      if (command === "batch_begin")
        return { ok: false, command, error: "begin refused" };
      return original(command, args);
    });

    await expect(runAgentBatch("refused", [{ command: "set_transport", args: { action: "toggle" } }]))
      .rejects.toThrow("batch_begin failed: begin refused");
    expect(seen).toEqual(["batch_begin"]);
  });

  it("rolls back applied commands when batch_end returns a resolved failure envelope", async () => {
    const before = await mockSnapshot<Snapshot>();
    const track = before.tracks[0];
    if (!track) throw new Error("fixture has no track");
    const seen: string[] = [];
    const state = useStore.getState();
    const original = state.exec;
    vi.spyOn(state, "exec").mockImplementation(async (command, args) => {
      seen.push(command);
      if (command === "batch_end") {
        await original(command, args);
        return { ok: false, command, error: "end refused" };
      }
      return original(command, args);
    });

    const result = await runSkill(
      SET_TRACK_LEVEL_SKILL,
      { trackId: track.id, db: -3 },
      {
        snapshot: () => mockSnapshot<Snapshot>(),
        runBatch: runAgentBatch,
        rollbackBatch: undoAgentBatch,
      },
    );

    expect(result).toMatchObject({ ok: false, stage: "execution", rolledBack: true });
    expect(seen).toEqual(["batch_begin", "set_track_volume", "batch_end", "undo"]);
    expect(await mockSnapshot<Snapshot>()).toEqual(before);
  });
});
