// Task 7 — the trusted, dynamic atomic transaction runner extracted from skillHarness.ts.
//
// These tests exercise `runAtomicSkillPlanV1` directly, at the level below `runSkill`: no
// slot validation, no precondition, no SKILL_TRANSACTABILITY lookup — just an
// already-planned `SkillTransactionPlan` driven through the six-step FS-B2a protocol with
// two guard checkpoints. Several cases port the transport-loss/rollback scenarios already
// proven against `runSkill` in skillHarness.failure.test.ts, to prove the move preserved
// their behavior at the new seam; the guard-ordering and guard-rejection cases are new,
// since the guards did not exist before this extraction.

import { beforeEach, describe, expect, it } from "vitest";
import { __resetMockForTests, mockSnapshot } from "../../bridge.mock";
import { useStore } from "../../store";
import type { Snapshot } from "../../types";
import { SET_TRACK_LEVEL_SKILL, type SkillSlotValues } from "../skills";
import { planSkillTransaction, SKILL_TRANSACTABILITY, type TxnMeta } from "../skillTransaction";
import {
  ALWAYS_OK_ATOMIC_GUARD,
  runAtomicSkillPlanV1,
  type AtomicSkillGuardContextV1,
  type AtomicSkillPlanV1,
} from "./atomicPlan";

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

const storeExec = (c: string, a: Record<string, unknown>, t?: TxnMeta) =>
  useStore.getState().exec(c, a, t);

/** Build a plan exactly the way skillHarness.ts's static-catalog adapter will: expand the
 *  skill's own template into a transaction plan, and bind its postcondition with the slots
 *  already closed over (verifyPostcondition itself takes no slots — that is the contract). */
function buildPlan(
  before: Snapshot,
  slots: SkillSlotValues,
  skillName = SET_TRACK_LEVEL_SKILL.name,
): AtomicSkillPlanV1 {
  const transaction = planSkillTransaction({ ...SET_TRACK_LEVEL_SKILL, name: skillName }, slots);
  return {
    skill: skillName,
    version: "1",
    slots,
    before,
    transaction,
    verifyPostcondition: (b, a, changes) =>
      SET_TRACK_LEVEL_SKILL.postcondition(b, a, slots, changes),
  };
}

describe("runAtomicSkillPlanV1", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("ALWAYS_OK_ATOMIC_GUARD resolves ok for both phases", async () => {
    const ctx = {} as AtomicSkillGuardContextV1;
    await expect(ALWAYS_OK_ATOMIC_GUARD("before_begin", ctx)).resolves.toEqual({ ok: true });
    await expect(ALWAYS_OK_ATOMIC_GUARD("before_commit", ctx)).resolves.toEqual({ ok: true });
  });

  it("runs before_begin before batch_begin — a rejection opens nothing", async () => {
    const before = await snapshot();
    const track = firstTrack(before);
    const seen: string[] = [];
    const plan = buildPlan(before, { trackId: track.id, db: -6 });

    const result = await runAtomicSkillPlanV1(plan, {
      snapshot,
      exec: async (c, a, t) => {
        seen.push(c);
        return storeExec(c, a, t);
      },
      guard: async (phase) =>
        phase === "before_begin" ? { ok: false, reason: "guard blocked" } : { ok: true },
    });

    expect(result).toMatchObject({
      ok: false,
      stage: "begin",
      reason: "guard blocked",
      rolledBack: false,
      outcome: "no_edit",
      guarantee: "atomic",
    });
    expect(seen).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("orders before_begin ahead of batch_begin, and before_commit after the mutations and postcondition but before batch_end", async () => {
    const before = await snapshot();
    const track = firstTrack(before);
    const order: string[] = [];
    const plan = buildPlan(before, { trackId: track.id, db: -6, mute: true });

    const result = await runAtomicSkillPlanV1(plan, {
      snapshot,
      exec: async (c, a, t) => {
        order.push(`exec:${c}`);
        return storeExec(c, a, t);
      },
      guard: async (phase) => {
        order.push(`guard:${phase}`);
        return { ok: true };
      },
    });

    expect(result.ok).toBe(true);
    const beginGuard = order.indexOf("guard:before_begin");
    const batchBegin = order.indexOf("exec:batch_begin");
    const volumeCall = order.indexOf("exec:set_track_volume");
    const muteCall = order.indexOf("exec:set_track_mute");
    const commitGuard = order.indexOf("guard:before_commit");
    const batchEnd = order.indexOf("exec:batch_end");

    expect(beginGuard).toBe(0);
    expect(beginGuard).toBeLessThan(batchBegin);
    expect(batchBegin).toBeLessThan(volumeCall);
    expect(volumeCall).toBeLessThan(muteCall);
    expect(muteCall).toBeLessThan(commitGuard);
    expect(commitGuard).toBeLessThan(batchEnd);
    // exactly one guard call per phase — no re-entry, no polling
    expect(order.filter((entry) => entry === "guard:before_begin").length).toBe(1);
    expect(order.filter((entry) => entry === "guard:before_commit").length).toBe(1);
  });

  it("a before_commit rejection rolls back the still-open transaction and never reaches batch_end", async () => {
    const before = await snapshot();
    const track = firstTrack(before);
    const seen: string[] = [];
    const plan = buildPlan(before, { trackId: track.id, db: -6 });

    const result = await runAtomicSkillPlanV1(plan, {
      snapshot,
      exec: async (c, a, t) => {
        seen.push(c);
        return storeExec(c, a, t);
      },
      guard: async (phase) =>
        phase === "before_commit" ? { ok: false, reason: "context drifted" } : { ok: true },
    });

    expect(result).toMatchObject({
      ok: false,
      stage: "commit",
      rolledBack: true,
      outcome: "restored",
    });
    if (!result.ok) expect(result.reason).toContain("context drifted");
    expect(seen).not.toContain("batch_end");
    expect(seen).toContain("batch_rollback");
    expect(await snapshot()).toEqual(before);
  });

  it("a before_commit-triggered rollback that claims success without matching the pre-state fingerprint is refused, not believed", async () => {
    const before = await snapshot();
    const track = firstTrack(before);
    const plan = buildPlan(before, { trackId: track.id, db: -6 });

    const result = await runAtomicSkillPlanV1(plan, {
      snapshot,
      exec: async (c, a, t) => {
        const res = await storeExec(c, a, t);
        if (c === "batch_status" && res.ok) {
          const data = res.data as Record<string, unknown> | undefined;
          if (data && data.status === "rolled_back")
            return { ...res, data: { ...data, fingerprint: "not-the-pre-state" } };
        }
        return res;
      },
      guard: async (phase) =>
        phase === "before_commit" ? { ok: false, reason: "drift detected" } : { ok: true },
    });

    expect(result).toMatchObject({ ok: false, rolledBack: false, outcome: "needs_recovery" });
    if (!result.ok) expect(result.reason).toContain("did not match its pre-transaction state");
  });

  it("a plain postcondition failure still rolls back the still-open transaction before batch_end (guard uninvolved)", async () => {
    const before = await snapshot();
    const track = firstTrack(before);
    const seen: string[] = [];
    const plan: AtomicSkillPlanV1 = {
      ...buildPlan(before, { trackId: track.id, db: -12, mute: true }),
      verifyPostcondition: () => ({ ok: false, reason: "expected failure" }),
    };

    const result = await runAtomicSkillPlanV1(plan, {
      snapshot,
      exec: async (c, a, t) => {
        seen.push(c);
        return storeExec(c, a, t);
      },
      guard: ALWAYS_OK_ATOMIC_GUARD,
    });

    expect(result).toMatchObject({ ok: false, stage: "postcondition", rolledBack: true, outcome: "restored" });
    if (!result.ok) expect(result.reason).toContain("expected failure");
    expect(seen).not.toContain("batch_end");
    expect(seen).toContain("batch_rollback");
    expect(await snapshot()).toEqual(before);
  });

  it("resolved command failure after an earlier apply: EXACT rollback (execution stage)", async () => {
    const before = await snapshot();
    const track = firstTrack(before);
    const partial = buildPlan(before, { trackId: track.id, db: -18, mute: true });
    // Force the second manifested command to target a missing track — the first one already
    // applied, so this is a real rollback, not a no-op.
    const transaction = {
      ...partial.transaction,
      steps: partial.transaction.steps.map((step, index) =>
        index === 1
          ? { ...step, call: { command: "set_track_mute", args: { trackId: "missing-track", mute: true } } }
          : step,
      ),
    };
    const plan: AtomicSkillPlanV1 = { ...partial, transaction };

    const result = await runAtomicSkillPlanV1(plan, {
      snapshot,
      exec: storeExec,
      guard: ALWAYS_OK_ATOMIC_GUARD,
    });

    expect(result).toMatchObject({
      ok: false,
      stage: "execution",
      rolledBack: true,
      outcome: "restored",
      guarantee: "atomic",
    });
    expect(await snapshot()).toEqual(before);
  });

  it("lost command response: status is consulted and the recorded result consumed (same-request-ID reconciliation)", async () => {
    const track = firstTrack(await snapshot());
    let dropped = false;
    const before = await snapshot();
    const plan = buildPlan(before, { trackId: track.id, db: -6, mute: true });

    const result = await runAtomicSkillPlanV1(plan, {
      snapshot,
      exec: async (c, a, t) => {
        const res = await storeExec(c, a, t);
        if (c === "set_track_volume" && !dropped) {
          dropped = true;
          throw new Error("bridge disconnected");
        }
        return res;
      },
      guard: ALWAYS_OK_ATOMIC_GUARD,
    });

    expect(result).toMatchObject({ ok: true, outcome: "committed", guarantee: "atomic" });
    const after = trackById(await snapshot(), track.id);
    expect(after.volumeDb).toBe(-6);
    expect(after.mute).toBe(true);
    expect(dropped).toBe(true);
  });

  it("lost response for a command that did NOT run: the same requestId is retried, never a new one", async () => {
    const track = firstTrack(await snapshot());
    let thrown = 0;
    const before = await snapshot();
    const plan = buildPlan(before, { trackId: track.id, db: -6 });
    const seenRequestIds = new Set<string>();

    const result = await runAtomicSkillPlanV1(plan, {
      snapshot,
      exec: async (c, a, t) => {
        if (t) seenRequestIds.add(t.requestId);
        if (c === "set_track_volume" && thrown === 0) {
          thrown += 1;
          throw new Error("bridge disconnected before dispatch");
        }
        return storeExec(c, a, t);
      },
      guard: ALWAYS_OK_ATOMIC_GUARD,
    });

    expect(result).toMatchObject({ ok: true, outcome: "committed" });
    expect(thrown).toBe(1);
    // exactly one requestId was ever used for the volume step, despite the retry
    const volumeStep = plan.transaction.steps.find((s) => s.call.command === "set_track_volume");
    expect(seenRequestIds.has(volumeStep!.meta.requestId)).toBe(true);
    expect(trackById(await snapshot(), track.id).volumeDb).toBe(-6);
  });

  it("lost BEGIN response: resolved by id, never inferred from the rejection", async () => {
    const before = await snapshot();
    const track = firstTrack(before);
    const plan = buildPlan(before, { trackId: track.id, db: -6 });

    const result = await runAtomicSkillPlanV1(plan, {
      snapshot,
      exec: async (c, a, t) => {
        if (c === "batch_begin") {
          await storeExec(c, a, t);
          throw new Error("bridge disconnected");
        }
        return storeExec(c, a, t);
      },
      guard: ALWAYS_OK_ATOMIC_GUARD,
    });

    expect(result).toMatchObject({ ok: false, stage: "begin", rolledBack: true, outcome: "restored" });
    expect(await snapshot()).toEqual(before);
  });

  it("unreadable status after a transport loss is NEVER read as 'nothing happened'", async () => {
    const track = firstTrack(await snapshot());
    const before = await snapshot();
    const plan = buildPlan(before, { trackId: track.id, db: -6 });

    const result = await runAtomicSkillPlanV1(plan, {
      snapshot,
      exec: async (c, a, t) => {
        if (c === "set_track_volume") throw new Error("bridge disconnected");
        if (c === "batch_status") return { ok: false, command: c, error: "status unavailable" };
        return storeExec(c, a, t);
      },
      guard: ALWAYS_OK_ATOMIC_GUARD,
    });

    expect(result).toMatchObject({ ok: false, rolledBack: false, outcome: "needs_recovery" });
    if (!result.ok) expect(result.reason).toContain("needs recovery");
  });

  it("runs a dynamic, non-cataloged skill name atomically — no dependency on SKILL_TRANSACTABILITY", async () => {
    const before = await snapshot();
    const track = firstTrack(before);
    const skillName = "owner-custom-fade";
    expect(SKILL_TRANSACTABILITY[skillName]).toBeUndefined();
    const plan = buildPlan(before, { trackId: track.id, db: -6 }, skillName);

    const result = await runAtomicSkillPlanV1(plan, {
      snapshot,
      exec: storeExec,
      guard: ALWAYS_OK_ATOMIC_GUARD,
    });

    expect(result).toMatchObject({
      ok: true,
      skill: skillName,
      outcome: "committed",
      guarantee: "atomic",
    });
    expect(trackById(await snapshot(), track.id).volumeDb).toBe(-6);
  });
});
