// FS-B2a — the failure table of docs/first-stranger-program/lanes/fs-b2.md, row by row,
// against the transactional mock. Every row asserts BOTH the reported outcome and the
// resulting session state, because a `rolledBack: true` that left the edit dirty is the
// exact lie this contract exists to prevent.
//
// The FS-B1 rows that still apply — an ambiguous transport loss with no transaction to
// interrogate — moved to the BEST-EFFORT section at the bottom, where they remain true: a
// skill containing an async render cannot have exact rollback, so it keeps FS-B1's
// confirmed-undo semantics and reports `guarantee: "best_effort"`.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMockForTests, mockSnapshot } from "../bridge.mock";
import { useStore } from "../store";
import type { Snapshot } from "../types";
import { runAgentBatch, undoAgentBatch } from "./executor";
import { runSkill, type SkillHarnessDeps } from "./skillHarness";
import type { TxnMeta } from "./skillTransaction";
import { REIMAGINE_CLIP_SKILL, SET_TRACK_LEVEL_SKILL, type SkillDefinition } from "./skills";

async function snapshot(): Promise<Snapshot> {
  return mockSnapshot<Snapshot>();
}

function firstTrack(value: Snapshot) {
  const track = value.tracks[0];
  if (!track) throw new Error("fixture has no track");
  return track;
}

const storeExec = (c: string, a: Record<string, unknown>, t?: TxnMeta) =>
  useStore.getState().exec(c, a, t);

const mockDeps = (): SkillHarnessDeps => ({
  snapshot,
  exec: storeExec,
  runBatch: runAgentBatch,
  rollbackBatch: undoAgentBatch,
});

describe("FS-B2a atomic path — the fs-b2.md failure table", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("validation / precondition rejection: no batch opens and nothing is called", async () => {
    const before = await snapshot();
    const seen: string[] = [];
    const result = await runSkill(
      SET_TRACK_LEVEL_SKILL,
      { trackId: "missing-track", db: -6 },
      { ...mockDeps(), exec: async (c, a, t) => { seen.push(c); return storeExec(c, a, t); } },
    );

    expect(result).toMatchObject({
      ok: false, stage: "precondition", rolledBack: false, outcome: "no_edit",
    });
    expect(seen).toEqual([]);   // not even a batch_begin
    expect(await snapshot()).toEqual(before);
  });

  it("resolved command failure after an earlier apply: EXACT rollback", async () => {
    const before = await snapshot();
    const track = firstTrack(before);
    const partialFailure: SkillDefinition = {
      ...SET_TRACK_LEVEL_SKILL,
      // Keep the transactable NAME (transactability is a property of the commands, and
      // both of these are registry-safe); only the second call's target is bad.
      template: [
        { kind: "command", command: "set_track_volume", args: { trackId: { slot: "trackId" }, db: { slot: "db" } } },
        { kind: "command", command: "set_track_mute", args: { trackId: "missing-track", mute: true } },
      ],
    };

    const result = await runSkill(partialFailure, { trackId: track.id, db: -18 }, mockDeps());

    expect(result).toMatchObject({
      ok: false, stage: "execution", rolledBack: true, outcome: "restored", guarantee: "atomic",
    });
    // The first command DID apply, so this is a real rollback and not a no-op.
    expect(await snapshot()).toEqual(before);
  });

  it("postcondition failure: rolls back the STILL-OPEN transaction, never a post-commit undo", async () => {
    const before = await snapshot();
    const track = firstTrack(before);
    const seen: string[] = [];
    const impossible: SkillDefinition = {
      ...SET_TRACK_LEVEL_SKILL,
      postcondition: () => ({ ok: false, reason: "expected failure" }),
    };

    const result = await runSkill(
      impossible,
      { trackId: track.id, db: -12, mute: true },
      { ...mockDeps(), exec: async (c, a, t) => { seen.push(c); return storeExec(c, a, t); } },
    );

    expect(result).toMatchObject({
      ok: false, stage: "postcondition", rolledBack: true, outcome: "restored",
    });
    if (!result.ok) expect(result.reason).toContain("expected failure");
    expect(await snapshot()).toEqual(before);
    // Rolled back BEFORE any commit — the race FS-B1 could not close.
    expect(seen).not.toContain("batch_end");
    expect(seen).not.toContain("undo");
    expect(seen).toContain("batch_rollback");
  });

  it("lost command response: status is consulted and the recorded result consumed", async () => {
    const track = firstTrack(await snapshot());
    let dropped = false;
    const result = await runSkill(
      SET_TRACK_LEVEL_SKILL,
      { trackId: track.id, db: -6, mute: true },
      {
        ...mockDeps(),
        exec: async (c, a, t) => {
          const res = await storeExec(c, a, t);
          // The command LANDED; only its reply is lost. Exactly the case a rejected promise
          // cannot distinguish from "never ran".
          if (c === "set_track_volume" && !dropped) {
            dropped = true;
            throw new Error("bridge disconnected");
          }
          return res;
        },
      },
    );

    expect(result).toMatchObject({ ok: true, outcome: "committed", guarantee: "atomic" });
    const after = (await snapshot()).tracks.find((t) => t.id === track.id);
    expect(after?.volumeDb).toBe(-6);
    expect(after?.mute).toBe(true);
    expect(dropped).toBe(true);   // the fixture really did drop a response
  });

  it("lost response for a command that did NOT run: the same requestId is retried", async () => {
    const track = firstTrack(await snapshot());
    let thrown = 0;
    const result = await runSkill(
      SET_TRACK_LEVEL_SKILL,
      { trackId: track.id, db: -6 },
      {
        ...mockDeps(),
        exec: async (c, a, t) => {
          if (c === "set_track_volume" && thrown === 0) {
            thrown += 1;
            throw new Error("bridge disconnected before dispatch");
          }
          return storeExec(c, a, t);
        },
      },
    );

    expect(result).toMatchObject({ ok: true, outcome: "committed" });
    expect(thrown).toBe(1);
    expect((await snapshot()).tracks.find((t) => t.id === track.id)?.volumeDb).toBe(-6);
  });

  it("lost BEGIN response: resolved by id, never inferred from the rejection", async () => {
    const before = await snapshot();
    const track = firstTrack(before);
    const result = await runSkill(
      SET_TRACK_LEVEL_SKILL,
      { trackId: track.id, db: -6 },
      {
        ...mockDeps(),
        exec: async (c, a, t) => {
          if (c === "batch_begin") {
            await storeExec(c, a, t);                 // it OPENED…
            throw new Error("bridge disconnected");   // …and the reply was lost
          }
          return storeExec(c, a, t);
        },
      },
    );

    // The transaction was open, so the harness rolls it back rather than proceeding blind.
    expect(result).toMatchObject({
      ok: false, stage: "begin", rolledBack: true, outcome: "restored",
    });
    expect(await snapshot()).toEqual(before);
  });

  it("unreadable status is NEVER read as 'nothing happened'", async () => {
    const track = firstTrack(await snapshot());
    const result = await runSkill(
      SET_TRACK_LEVEL_SKILL,
      { trackId: track.id, db: -6 },
      {
        ...mockDeps(),
        exec: async (c, a, t) => {
          if (c === "set_track_volume") throw new Error("bridge disconnected");
          // …and the authority is unavailable too, so nothing can be proven.
          if (c === "batch_status") return { ok: false, command: c, error: "status unavailable" };
          return storeExec(c, a, t);
        },
      },
    );

    expect(result).toMatchObject({ ok: false, rolledBack: false, outcome: "needs_recovery" });
    if (!result.ok) expect(result.reason).toContain("needs recovery");
  });

  it("a malformed status envelope cannot be used to CLAIM a rollback", async () => {
    // The earlier version of this test asserted `needs_recovery` after a dropped command,
    // and a sabotage that deleted the `found` typecheck did not fail it — it reached the
    // same outcome by a different route. A malformed envelope is only dangerous where it
    // would let something be BELIEVED, so the fixture forces it into the rollback path and
    // has it claim exactly what the harness must refuse to repeat.
    const track = firstTrack(await snapshot());
    const impossible: SkillDefinition = {
      ...SET_TRACK_LEVEL_SKILL,
      postcondition: () => ({ ok: false, reason: "force a rollback" }),
    };

    const result = await runSkill(impossible, { trackId: track.id, db: -6 }, {
      ...mockDeps(),
      exec: async (c, a, t) => {
        const res = await storeExec(c, a, t);
        if (c === "batch_status" && res.ok) {
          const data = res.data as Record<string, unknown> | undefined;
          if (data && data.status === "rolled_back")
            // `found` is a STRING, not a boolean: truthy garbage claiming a clean rollback,
            // with a fingerprint that would otherwise satisfy the exactness check.
            return { ...res, data: { ...data, found: "yes" } };
        }
        return res;
      },
    });

    expect(result).toMatchObject({ ok: false, outcome: "needs_recovery", rolledBack: false });
    if (!result.ok) expect(result.reason).toContain("unreadable");
  });

  it("rollback that reports success but does not restore the pre-state is REFUSED", async () => {
    const track = firstTrack(await snapshot());
    const impossible: SkillDefinition = {
      ...SET_TRACK_LEVEL_SKILL,
      postcondition: () => ({ ok: false, reason: "force a rollback" }),
    };

    const result = await runSkill(impossible, { trackId: track.id, db: -6 }, {
      ...mockDeps(),
      exec: async (c, a, t) => {
        const res = await storeExec(c, a, t);
        // Claim rolled_back with a fingerprint that does not match the pre-state. The
        // harness must not repeat the claim — this is the "never say rolled back on a
        // transport success" rule.
        if (c === "batch_status" && res.ok) {
          const data = res.data as Record<string, unknown> | undefined;
          if (data && data.status === "rolled_back")
            return { ...res, data: { ...data, fingerprint: "a-different-session-entirely" } };
        }
        return res;
      },
    });

    expect(result).toMatchObject({ ok: false, rolledBack: false, outcome: "needs_recovery" });
    if (!result.ok) expect(result.reason).toContain("did not match its pre-transaction state");
  });

  it("a foreign untagged mutation is refused while the transaction is open", async () => {
    const track = firstTrack(await snapshot());
    // Explicitly typed: TS narrows a `let x = null` closed over by a callback to `never`
    // at the read site, which would silently make the assertions below unreachable.
    let foreign: { ok: boolean; error?: string } | null = null as { ok: boolean; error?: string } | null;

    const result = await runSkill(SET_TRACK_LEVEL_SKILL, { trackId: track.id, db: -6 }, {
      ...mockDeps(),
      exec: async (c, a, t) => {
        const res = await storeExec(c, a, t);
        // A UI click landing mid-skill-run.
        if (c === "set_track_volume" && t)
          foreign = await useStore.getState().exec("set_track_pan", { trackId: track.id, pan: 0.5 });
        return res;
      },
    });

    expect(result.ok).toBe(true);
    expect(foreign).not.toBeNull();
    expect(foreign?.ok).toBe(false);
    expect(foreign?.error).toContain("transaction_in_progress");
    // …and the refused change really did not land — the suppression has something to suppress.
    expect((await snapshot()).tracks.find((t) => t.id === track.id)?.pan).toBe(0);
    // The same call succeeds once the transaction is over, so "refused" is not "broken".
    const afterClose = await useStore.getState().exec("set_track_pan", { trackId: track.id, pan: 0.5 });
    expect(afterClose.ok).toBe(true);
    expect((await snapshot()).tracks.find((t) => t.id === track.id)?.pan).toBeCloseTo(0.5);
  });
});

describe("FS-B2a best-effort path — FS-B1 semantics, where they are still the best available", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  // reimagine_clip carries render_layer (asynchronous), so the engine registry cannot admit
  // it and there IS no exact rollback to be had. These are FS-B1's rules, unchanged; the
  // result names which guarantee applied so nobody can mistake one for the other.
  const waveClip = async () => {
    const before = await snapshot();
    const track = before.tracks.find((t) => t.clips.some((c) => c.type === "wave"));
    const clip = track?.clips.find((c) => c.type === "wave");
    if (!clip) throw new Error("fixture is missing a wave clip");
    return { before, clipId: clip.id };
  };

  it("runs, and reports guarantee:'best_effort' rather than claiming atomicity", async () => {
    const { clipId } = await waveClip();
    const result = await runSkill(
      REIMAGINE_CLIP_SKILL,
      { clipId, nl: 0.6, prompt: "lo-fi tape", autoAccept: true },
      mockDeps(),
    );
    expect(result).toMatchObject({ ok: true, guarantee: "best_effort" });
  });

  it("opens NO transaction — an untransactable skill never sends an identified batch_begin", async () => {
    const { clipId } = await waveClip();
    const tagged: string[] = [];
    await runSkill(REIMAGINE_CLIP_SKILL, { clipId, nl: 0.6 }, {
      ...mockDeps(),
      exec: async (c, a, t) => {
        if (c === "batch_begin" && a.transactionId) tagged.push(String(a.transactionId));
        return storeExec(c, a, t);
      },
    });
    expect(tagged).toEqual([]);
  });

  it("does not claim rollback when the batch transport rejects (state genuinely unknown)", async () => {
    const { clipId } = await waveClip();
    const rollbackBatch = vi.fn(async () => true);
    const result = await runSkill(REIMAGINE_CLIP_SKILL, { clipId, nl: 0.6 }, {
      snapshot,
      exec: storeExec,
      runBatch: async () => { throw new Error("connection lost"); },
      rollbackBatch,
    });

    expect(result).toMatchObject({
      ok: false, stage: "execution", rolledBack: false, guarantee: "best_effort",
    });
    if (!result.ok) expect(result.reason).toContain("Mutation state is unknown");
    expect(rollbackBatch).not.toHaveBeenCalled();
  });

  it("does not claim rollback when undo reports no mutation", async () => {
    const { clipId } = await waveClip();
    const result = await runSkill(REIMAGINE_CLIP_SKILL, { clipId, nl: 0.6 }, {
      snapshot,
      exec: storeExec,
      runBatch: async (_label, calls) => ({
        label: "reimagine_clip",
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
    });

    expect(result).toMatchObject({ ok: false, rolledBack: false });
    if (!result.ok) expect(result.reason).toContain("Rollback was not confirmed");
  });

  it("rejects incomplete per-command results and rolls back reported mutations", async () => {
    const { clipId } = await waveClip();
    const rollbackBatch = vi.fn(async () => true);
    const result = await runSkill(REIMAGINE_CLIP_SKILL, { clipId, nl: 0.6 }, {
      snapshot,
      exec: storeExec,
      runBatch: async () => ({
        label: "reimagine_clip",
        applied: 1,
        entries: [{ index: 0, command: "create_render_layer", summary: "layer", ok: true }],
      }),
      rollbackBatch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("command results");
      expect(result.rolledBack).toBe(true);
    }
    expect(rollbackBatch).toHaveBeenCalledOnce();
  });

  it("rejects a result whose command identity does not match its index", async () => {
    const { clipId } = await waveClip();
    const rollbackBatch = vi.fn(async () => true);
    const result = await runSkill(REIMAGINE_CLIP_SKILL, { clipId, nl: 0.6 }, {
      snapshot,
      exec: storeExec,
      // The right NUMBER of results (so the count check passes and the identity check is
      // what actually fires) but the wrong command at index 0.
      runBatch: async (_label, calls) => ({
        label: "reimagine_clip",
        applied: calls.length,
        entries: calls.map((call, index) => ({
          index,
          command: index === 0 ? "set_track_mute" : call.command,
          summary: index === 0 ? "wrong command" : call.command,
          ok: true,
        })),
      }),
      rollbackBatch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("does not match its command");
      expect(result.rolledBack).toBe(true);
    }
    expect(rollbackBatch).toHaveBeenCalledOnce();
  });

  it("refuses to run at all if no non-atomic batch seam was provided", async () => {
    const { clipId, before } = await waveClip();
    const result = await runSkill(REIMAGINE_CLIP_SKILL, { clipId, nl: 0.6 }, {
      snapshot,
      exec: storeExec,
    });
    expect(result).toMatchObject({
      ok: false, stage: "template", outcome: "no_edit", guarantee: "best_effort",
    });
    expect(await snapshot()).toEqual(before);
  });
});

describe("FS-B2a — one undo still reverts a whole committed transaction", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("keeps a successful two-command skill in one undo step", async () => {
    const before = await snapshot();
    const track = firstTrack(before);
    expect((await runSkill(
      SET_TRACK_LEVEL_SKILL,
      { trackId: track.id, db: -15, mute: true },
      mockDeps(),
    )).ok).toBe(true);
    expect(await snapshot()).not.toEqual(before);
    expect(await undoAgentBatch()).toBe(true);
    expect(await snapshot()).toEqual(before);
  });

  it("the undo seam still reports no mutation when there is no history", async () => {
    expect(await undoAgentBatch()).toBe(false);
  });
});
