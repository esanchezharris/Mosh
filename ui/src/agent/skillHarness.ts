// FS-B2a — the skill harness, on the engine's batch-TRANSACTION contract.
//
// Spec: docs/first-stranger-program/lanes/fs-b2.md "Harness protocol". The six steps below
// are that list, in that order, and the ordering is load-bearing: the transaction stays
// OPEN through postcondition evaluation, which removes the race FS-B1 had to live with
// (attempting a generic undo AFTER batch_end, when the batch it wanted no longer existed).
//
// What changed from FS-B1, and why. FS-B1 returned `rolledBack: false` with "mutation state
// is unknown" after an ambiguous transport loss. That was the honest answer available to it
// — a rejected promise cannot distinguish "not executed" from "executed, response lost", and
// a blind undo could have reverted unrelated work. It is no longer the only answer: every
// ambiguous outcome now resolves through `batch_status`, which is authoritative and names
// the exact transaction. `rolledBack: true` is still only ever returned on proof.

import type { Snapshot } from "../types";
import { validateCommand } from "./commands";
import type { AgentCommandCall, ChangeSet } from "./executor";
import { ALWAYS_OK_ATOMIC_GUARD, runAtomicSkillPlanV1, type AtomicSkillPlanV1 } from "./skillFoundry/atomicPlan";
import { checkSkillChangeSet } from "./skillHarnessResult";
import {
  expandSkillTemplate,
  planSkillTransaction,
  untransactableReason,
  type IdFactory,
  type SkillTransactionPlan,
  type TxnMeta,
} from "./skillTransaction";
import {
  validateSkillSlots,
  type SkillCheck,
  type SkillDefinition,
  type SkillExecutionSummary,
  type SkillSlotValues,
} from "./skills";

// Re-exported so existing importers of the harness keep one import surface.
export { expandSkillTemplate };

/** One command result off the bridge. */
export type BridgeResult = {
  readonly ok: boolean;
  readonly error?: string;
  readonly data?: unknown;
  readonly replayed?: boolean;
};

/** The authoritative transaction status (batch_status's `data`). */
export type TxnStatus = {
  readonly found: boolean;
  readonly transactionId?: string;
  readonly status?: "open" | "failed" | "committed" | "rolled_back" | "needs_recovery";
  readonly failureCode?: string;
  readonly preFingerprint?: string;
  readonly fingerprint?: string;
  readonly manifestCount?: number;
  readonly applied?: number;
  readonly canCommit?: boolean;
  readonly canRollback?: boolean;
  readonly entries?: readonly {
    readonly index: number;
    readonly requestId: string;
    readonly command: string;
    readonly state: "pending" | "applied" | "failed";
    readonly result?: BridgeResult;
  }[];
};

export type SkillHarnessDeps = {
  readonly snapshot: () => Promise<Snapshot>;
  /** The single command seam. `transaction` rides beside args, never inside them. */
  readonly exec: (
    command: string,
    args: Record<string, unknown>,
    transaction?: TxnMeta,
  ) => Promise<BridgeResult>;
  readonly newId?: IdFactory;
  // ── the BEST-EFFORT path (see runSkill) ──
  // Used only for a skill the engine's transactionSafe registry cannot admit — one
  // containing an async render, a non-undoable preference, or a pure analysis read. These
  // two are FS-B1's seams and FS-B1's semantics, unchanged.
  readonly runBatch?: (label: string, calls: readonly AgentCommandCall[]) => Promise<ChangeSet>;
  readonly rollbackBatch?: () => Promise<boolean>;
};

/** Which guarantee actually held for a run.
 *  `atomic`      — the engine transaction: exact commit, exact rollback, no partial state.
 *  `best_effort` — the skill contains a command the engine cannot put in a transaction, so
 *                  it ran on the legacy batch with FS-B1's confirmed-undo rollback. A
 *                  failure here may leave partial mutations, and the refusal says so. */
export type SkillGuarantee = "atomic" | "best_effort";

export type SkillFailureStage =
  | "validation"
  | "precondition"
  | "template"
  | "begin"
  | "execution"
  | "postcondition"
  | "commit";

/** How the edit was left. This is the vocabulary the refusal copy must use: fs-b2.md
 *  requires the user to be told whether no edit was made, the identified edit was
 *  restored, or the state could not be proven. */
export type SkillEditOutcome = "no_edit" | "restored" | "committed" | "needs_recovery";

export type SkillRunResult =
  | {
      readonly ok: true;
      readonly skill: string;
      readonly slots: SkillSlotValues;
      readonly calls: readonly AgentCommandCall[];
      readonly transactionId?: string;
      readonly changes: SkillExecutionSummary;
      readonly outcome: "committed";
      readonly guarantee: SkillGuarantee;
    }
  | {
      readonly ok: false;
      readonly skill: string;
      readonly stage: SkillFailureStage;
      readonly reason: string;
      readonly rolledBack: boolean;
      readonly outcome: SkillEditOutcome;
      readonly transactionId?: string;
      readonly failureCode?: string;
      readonly guarantee: SkillGuarantee;
    };

const detail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The BEST-EFFORT path, for a skill the engine's transactionSafe registry cannot admit.
 *
 * This is FS-B1's behaviour, deliberately preserved rather than improved: the legacy id-less
 * batch, then a postcondition check, then `undo` — and `rolledBack: true` only when undo
 * explicitly confirms it. It CANNOT offer exact rollback, because the commands involved are
 * the ones that make exact rollback impossible in the first place. The refusal copy says so.
 */
async function runBestEffort(
  skill: SkillDefinition,
  slots: SkillSlotValues,
  calls: readonly AgentCommandCall[],
  before: Snapshot,
  why: string,
  deps: SkillHarnessDeps,
): Promise<SkillRunResult> {
  const bestEffort = (
    stage: SkillFailureStage,
    reason: string,
    rolledBack: boolean,
    outcome: SkillEditOutcome,
  ): SkillRunResult => ({
    ok: false, skill: skill.name, stage, reason, rolledBack, outcome, guarantee: "best_effort",
  });

  if (!deps.runBatch)
    return bestEffort(
      "template",
      `${skill.name} cannot run as an atomic transaction (${why}) and no non-atomic batch seam was provided.`,
      false,
      "no_edit",
    );

  /** FS-B1 semantics exactly: attempt undo, and claim rollback only on confirmation. */
  const attemptUndo = async (
    stage: "execution" | "postcondition",
    reason: string,
    applied: number,
  ): Promise<SkillRunResult> => {
    if (applied <= 0) return bestEffort(stage, reason, false, "no_edit");
    if (!deps.rollbackBatch)
      return bestEffort(stage, `${reason} No rollback seam was provided.`, false, "needs_recovery");
    try {
      const rolledBack = await deps.rollbackBatch();
      return bestEffort(
        stage,
        rolledBack
          ? `${reason} The edit was restored to its previous state.`
          : `${reason} Rollback was not confirmed, so part of the change may remain.`,
        rolledBack,
        rolledBack ? "restored" : "needs_recovery",
      );
    } catch (error) {
      return bestEffort(stage, `${reason} Rollback failed: ${detail(error)}`, false, "needs_recovery");
    }
  };

  let changes: ChangeSet;
  try {
    changes = await deps.runBatch(skill.name, calls);
  } catch (error) {
    // An ambiguous transport loss with no transaction to ask about. This is precisely the
    // gap the atomic path closes and this path cannot: report it, never guess.
    return bestEffort(
      "execution",
      `Execution transport failed: ${detail(error)}. Mutation state is unknown; automatic rollback was not attempted.`,
      false,
      "needs_recovery",
    );
  }

  const checked = checkSkillChangeSet(skill.name, calls, changes);
  if (!checked.ok) return attemptUndo("execution", checked.reason, checked.reportedApplied);

  let after: Snapshot;
  try {
    after = await deps.snapshot();
  } catch (error) {
    return attemptUndo("postcondition", `Could not read the resulting session state: ${detail(error)}`, changes.applied);
  }

  let postcondition: SkillCheck;
  try {
    postcondition = skill.postcondition(before, after, slots, changes);
  } catch (error) {
    return attemptUndo("postcondition", `Postcondition failed: ${detail(error)}`, changes.applied);
  }
  if (!postcondition.ok)
    return attemptUndo("postcondition", postcondition.reason, changes.applied);

  return {
    ok: true,
    skill: skill.name,
    slots,
    calls,
    changes,
    outcome: "committed",
    guarantee: "best_effort",
  };
}

/** Validate, run through the engine transaction, and assert the skill contract. */
export async function runSkill(
  skill: SkillDefinition,
  rawSlots: unknown,
  deps: SkillHarnessDeps,
): Promise<SkillRunResult> {
  const noEdit = (
    stage: SkillFailureStage,
    reason: string,
    guarantee: SkillGuarantee = "atomic",
  ): SkillRunResult => ({
    ok: false,
    skill: skill.name,
    stage,
    reason,
    rolledBack: false,
    outcome: "no_edit",
    guarantee,
  });

  // ── STEP 1: validate slots, preconditions, expanded calls — no mutation ──
  const validated = validateSkillSlots(skill, rawSlots);
  if (!validated.ok) return noEdit("validation", validated.reason);

  let before: Snapshot;
  try {
    before = await deps.snapshot();
  } catch (error) {
    return noEdit("precondition", `Could not read session state: ${detail(error)}`);
  }

  let precondition: SkillCheck;
  try {
    precondition = skill.precondition(before, validated.slots);
  } catch (error) {
    return noEdit("precondition", `Precondition failed: ${detail(error)}`);
  }
  if (!precondition.ok) return noEdit("precondition", precondition.reason);

  let plan: SkillTransactionPlan;
  try {
    plan = planSkillTransaction(skill, validated.slots, deps.newId);
  } catch (error) {
    return noEdit("template", detail(error));
  }
  if (plan.steps.length === 0)
    return noEdit("template", `${skill.name}: template produced no commands`);

  for (const step of plan.steps) {
    const error = validateCommand(step.call.command, step.call.args ?? {});
    if (error) return noEdit("template", error);
  }

  // ── FORK: can the engine put this whole skill in one transaction? ──
  // 4 of the 8 catalogued skills cannot (see SKILL_TRANSACTABILITY): arrange_beat carries
  // set_metronome (a non-undoable device preference), warp_loop_to_grid carries
  // detect_clip_bpm (a service read with no transaction), reimagine_clip carries
  // render_layer (asynchronous). Those are exactly the classes fs-b2.md requires the
  // registry to reject.
  //
  // They still RUN — refusing them outright would delete working behaviour to satisfy a
  // contract that was never able to cover them. They run on the legacy batch with FS-B1's
  // confirmed-undo rollback, and the result says `guarantee: "best_effort"` so no caller
  // can mistake it for the atomic one. Choosing which of the two a B2 skill may use is
  // B2's decision; this harness only refuses to LIE about which one it got.
  const untransactable = untransactableReason(skill.name);
  if (untransactable !== null)
    return runBestEffort(skill, validated.slots, plan.steps.map((step) => step.call), before, untransactable, deps);

  // ── STEPS 2–6: the trusted, dynamic atomic runner (skillFoundry/atomicPlan.ts) ──
  // The static catalog's own slot/precondition validation and template expansion happened
  // above (STEP 1); everything from here — batch_begin, per-command execution with
  // status-driven transport-loss reconciliation, the postcondition check, and commit — is
  // the extracted trusted runner. This adapter supplies an always-green guard at both
  // checkpoints, so the observable behavior of a static catalog skill is unchanged by the
  // extraction: the guard seams exist for a dynamic (owner-authored) plan, not for this path.
  const atomicPlan: AtomicSkillPlanV1 = {
    skill: skill.name,
    version: "1",
    slots: validated.slots,
    before,
    transaction: plan,
    verifyPostcondition: (b, a, changes) => skill.postcondition(b, a, validated.slots, changes),
  };

  return runAtomicSkillPlanV1(atomicPlan, {
    snapshot: deps.snapshot,
    exec: deps.exec,
    guard: ALWAYS_OK_ATOMIC_GUARD,
  });
}
