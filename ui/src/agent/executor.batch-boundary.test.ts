import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMockForTests, mockSnapshot } from "../bridge.mock";
import { useStore } from "../store";
import type { Snapshot } from "../types";
import { runAgentBatch, undoAgentBatch } from "./executor";
import { runSkill, type SkillHarnessDeps } from "./skillHarness";
import type { TxnMeta } from "./skillTransaction";
import { SET_TRACK_LEVEL_SKILL } from "./skills";

const deps = (): SkillHarnessDeps => ({
  snapshot: () => mockSnapshot<Snapshot>(),
  exec: (c: string, a: Record<string, unknown>, t?: TxnMeta) => useStore.getState().exec(c, a, t),
  runBatch: runAgentBatch,
  rollbackBatch: undoAgentBatch,
});

describe("agent batch boundary failures", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The LEGACY id-less batch (runAgentBatch, still the brain-chat path) is unchanged by
  // FS-B2a, and this pins that: a failed begin dispatches nothing after it.
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

  // FS-B2a — the commit boundary, both ways round. These two cases are the whole reason
  // batch_status has to be authoritative: the transport result and the truth disagree.
  it("treats a FAILED batch_end envelope as SUCCESS when the transaction did commit", async () => {
    const track = (await mockSnapshot<Snapshot>()).tracks[0];
    if (!track) throw new Error("fixture has no track");
    const state = useStore.getState();
    const original = state.exec;
    // The commit lands, then its response is corrupted into a failure — the shape of a
    // reply lost on the way back. FS-B1 could only report this as a failure (and would
    // then have tried to undo a change the user asked for).
    vi.spyOn(state, "exec").mockImplementation(async (command, args, transaction) => {
      if (command === "batch_end") {
        await original(command, args, transaction);
        return { ok: false, command, error: "end response corrupted" };
      }
      return original(command, args, transaction);
    });

    const result = await runSkill(SET_TRACK_LEVEL_SKILL, { trackId: track.id, db: -3 }, deps());

    expect(result).toMatchObject({ ok: true, outcome: "committed", guarantee: "atomic" });
    // …and the edit really is applied, not merely reported.
    const after = (await mockSnapshot<Snapshot>()).tracks.find((t) => t.id === track.id);
    expect(after?.volumeDb).toBe(-3);
  });

  it("rolls back EXACTLY when batch_end fails and the transaction did NOT commit", async () => {
    const before = await mockSnapshot<Snapshot>();
    const track = before.tracks[0];
    if (!track) throw new Error("fixture has no track");
    const seen: string[] = [];
    const state = useStore.getState();
    const original = state.exec;
    vi.spyOn(state, "exec").mockImplementation(async (command, args, transaction) => {
      seen.push(command);
      // Refuse the commit WITHOUT letting it land: the transaction stays open and
      // rollback-able, which is what the harness must then do.
      if (command === "batch_end") return { ok: false, command, error: "end refused" };
      return original(command, args, transaction);
    });

    const result = await runSkill(SET_TRACK_LEVEL_SKILL, { trackId: track.id, db: -3 }, deps());

    expect(result).toMatchObject({
      ok: false,
      stage: "commit",
      rolledBack: true,
      outcome: "restored",
      guarantee: "atomic",
    });
    // Exactness: the whole session is back where it started.
    expect(await mockSnapshot<Snapshot>()).toEqual(before);
    // The protocol's shape, in order: begin → the manifested command → a status read →
    // the refused commit → status → exact rollback (never a bare `undo`).
    expect(seen).toContain("batch_rollback");
    expect(seen).not.toContain("undo");
    expect(seen.indexOf("batch_begin")).toBeLessThan(seen.indexOf("set_track_volume"));
    expect(seen.indexOf("set_track_volume")).toBeLessThan(seen.indexOf("batch_end"));
    expect(seen.indexOf("batch_end")).toBeLessThan(seen.indexOf("batch_rollback"));
  });
});
