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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const detail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Read authoritative status. A malformed or unreadable answer is NEVER read as
 *  "nothing happened" — it returns null, which every caller treats as unprovable. */
async function readStatus(
  deps: SkillHarnessDeps,
  transactionId: string,
): Promise<TxnStatus | null> {
  let result: BridgeResult;
  try {
    result = await deps.exec("batch_status", { transactionId });
  } catch {
    return null;
  }
  if (!result.ok || !isRecord(result.data)) return null;
  const data = result.data as TxnStatus;
  if (typeof data.found !== "boolean") return null;
  return data;
}

function unprovable(
  skill: string,
  stage: SkillFailureStage,
  reason: string,
  transactionId: string,
  failureCode?: string,
): SkillRunResult {
  return {
    ok: false,
    skill,
    stage,
    reason: `${reason} The edit state could not be proven and needs recovery.`,
    rolledBack: false,
    outcome: "needs_recovery",
    transactionId,
    failureCode,
    guarantee: "atomic",
  };
}

/**
 * Step 4 / step 5's failure path: EXACT rollback of the identified, still-open transaction.
 *
 * `rolledBack: true` is returned only when authoritative status says `rolled_back` AND the
 * reported fingerprint equals the captured pre-state. A transport success or a merely
 * requested undo is never enough — fs-b2.md forbids saying "rolled back" on that basis, and
 * the UI must never fall back to undoAgentBatch() for an ambiguous transaction.
 */
async function rollbackExactly(
  skill: string,
  stage: SkillFailureStage,
  reason: string,
  plan: SkillTransactionPlan,
  preFingerprint: string | undefined,
  deps: SkillHarnessDeps,
): Promise<SkillRunResult> {
  const { transactionId } = plan;
  try {
    await deps.exec("batch_rollback", { transactionId });
  } catch {
    /* A lost rollback response is resolved by status below, never by a second undo. */
  }

  const status = await readStatus(deps, transactionId);
  if (status === null || !status.found)
    return unprovable(skill, stage, `${reason} Rollback status was unreadable.`, transactionId);

  if (status.status !== "rolled_back")
    return unprovable(
      skill,
      stage,
      `${reason} Rollback did not complete (status: ${status.status ?? "unknown"}).`,
      transactionId,
      status.failureCode,
    );

  if (preFingerprint !== undefined && status.fingerprint !== preFingerprint)
    return unprovable(
      skill,
      stage,
      `${reason} Rollback reported success but the session did not match its pre-transaction state.`,
      transactionId,
      status.failureCode,
    );

  return {
    ok: false,
    skill,
    stage,
    reason: `${reason} The edit was restored to its previous state.`,
    rolledBack: true,
    outcome: "restored",
    transactionId,
    guarantee: "atomic",
  };
}

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

  // ── STEP 2: idempotent batch_begin with the full manifest ──
  // The engine validates the whole manifest against its own transactionSafe registry
  // BEFORE opening the Tracktion transaction, so a rejection here has mutated nothing.
  let begin: BridgeResult;
  try {
    begin = await deps.exec("batch_begin", {
      transactionId: plan.transactionId,
      name: plan.name,
      commands: plan.manifest,
    });
  } catch (error) {
    // A rejected begin promise is ambiguous: the transaction may or may not be open.
    // Resolve it by id — never by inferring from the rejection.
    const status = await readStatus(deps, plan.transactionId);
    if (status === null)
      return unprovable(
        skill.name,
        "begin",
        `Could not open a transaction: ${detail(error)}.`,
        plan.transactionId,
      );
    if (!status.found)
      return noEdit("begin", `Could not open a transaction: ${detail(error)}. No edit was made.`);
    // It IS open despite the lost response — roll it back rather than proceeding blind.
    return rollbackExactly(
      skill.name,
      "begin",
      `The transaction opened but its response was lost.`,
      plan,
      status.preFingerprint,
      deps,
    );
  }

  if (!begin.ok)
    return noEdit("begin", `${skill.name} was refused before any change: ${begin.error ?? "unknown error"}`);

  const beginStatus = isRecord(begin.data) ? (begin.data as TxnStatus) : null;
  const preFingerprint = beginStatus?.preFingerprint;

  // ── STEP 3: execute each manifested command; resolve every ambiguity by status ──
  const entries: {
    index: number;
    command: string;
    summary: string;
    ok: boolean;
    error?: string;
  }[] = [];

  for (const step of plan.steps) {
    let result: BridgeResult | null = null;
    try {
      result = await deps.exec(step.call.command, step.call.args ?? {}, step.meta);
    } catch (error) {
      // TRANSPORT LOSS. This is the case FS-B1 could only report as unknown. Ask the
      // authority what actually happened.
      const status = await readStatus(deps, plan.transactionId);
      if (status === null || !status.found)
        return unprovable(
          skill.name,
          "execution",
          `${step.call.command} did not return (${detail(error)}) and its transaction could not be read.`,
          plan.transactionId,
        );
      if (status.status === "needs_recovery")
        return unprovable(
          skill.name,
          "execution",
          `${step.call.command} did not return (${detail(error)}).`,
          plan.transactionId,
          status.failureCode,
        );

      const recorded = status.entries?.find((e) => e.requestId === step.meta.requestId);
      if (recorded && recorded.state !== "pending") {
        // It DID execute; only the response was lost. Consume the recorded result.
        result = recorded.result ?? { ok: recorded.state === "applied" };
      } else {
        // It did not execute. Retry the SAME requestId — the engine replays rather than
        // double-applying if it turns out to have run after all.
        try {
          result = await deps.exec(step.call.command, step.call.args ?? {}, step.meta);
        } catch (retryError) {
          return rollbackExactly(
            skill.name,
            "execution",
            `${step.call.command} could not be completed (${detail(retryError)}).`,
            plan,
            preFingerprint,
            deps,
          );
        }
      }
    }

    entries.push({
      index: step.meta.index,
      command: step.call.command,
      summary: step.call.command.replace(/_/g, " "),
      ok: result.ok,
      error: result.ok ? undefined : result.error,
    });

    // ── STEP 4: a resolved failure → exact rollback ──
    if (!result.ok)
      return rollbackExactly(
        skill.name,
        "execution",
        `${step.call.command} failed: ${result.error ?? "unknown error"}.`,
        plan,
        preFingerprint,
        deps,
      );
  }

  const changes: SkillExecutionSummary = {
    applied: entries.filter((entry) => entry.ok).length,
    entries,
  };

  // Cross-check the engine's own accounting against ours before trusting either.
  const applyStatus = await readStatus(deps, plan.transactionId);
  if (applyStatus === null || !applyStatus.found)
    return unprovable(
      skill.name,
      "execution",
      "The transaction's status became unreadable after its commands ran.",
      plan.transactionId,
    );
  if (applyStatus.status === "needs_recovery")
    return unprovable(
      skill.name,
      "execution",
      "The engine could not prove the transaction's edit state.",
      plan.transactionId,
      applyStatus.failureCode,
    );
  if (applyStatus.applied !== plan.steps.length || applyStatus.canCommit !== true)
    return rollbackExactly(
      skill.name,
      "execution",
      `The engine recorded ${applyStatus.applied ?? 0} of ${plan.steps.length} commands as applied.`,
      plan,
      preFingerprint,
      deps,
    );

  // ── STEP 5: evaluate the postcondition WHILE THE TRANSACTION IS STILL OPEN ──
  let after: Snapshot;
  try {
    after = await deps.snapshot();
  } catch (error) {
    return rollbackExactly(
      skill.name,
      "postcondition",
      `Could not read the resulting session state: ${detail(error)}.`,
      plan,
      preFingerprint,
      deps,
    );
  }

  let postcondition: SkillCheck;
  try {
    postcondition = skill.postcondition(before, after, validated.slots, changes);
  } catch (error) {
    return rollbackExactly(
      skill.name,
      "postcondition",
      `Postcondition failed: ${detail(error)}.`,
      plan,
      preFingerprint,
      deps,
    );
  }
  if (!postcondition.ok)
    return rollbackExactly(
      skill.name,
      "postcondition",
      postcondition.reason,
      plan,
      preFingerprint,
      deps,
    );

  // ── STEP 6: only now, commit. A lost response resolves through status. ──
  let commit: BridgeResult | null = null;
  try {
    commit = await deps.exec("batch_end", { transactionId: plan.transactionId });
  } catch (error) {
    const status = await readStatus(deps, plan.transactionId);
    if (status?.status === "committed")
      return {
        ok: true,
        skill: skill.name,
        slots: validated.slots,
        calls: plan.steps.map((step) => step.call),
        transactionId: plan.transactionId,
        changes,
        outcome: "committed",
        guarantee: "atomic",
      };
    return unprovable(
      skill.name,
      "commit",
      `The commit response was lost (${detail(error)}).`,
      plan.transactionId,
      status?.failureCode,
    );
  }

  if (!commit.ok) {
    const status = await readStatus(deps, plan.transactionId);
    if (status?.status === "committed")
      return {
        ok: true,
        skill: skill.name,
        slots: validated.slots,
        calls: plan.steps.map((step) => step.call),
        transactionId: plan.transactionId,
        changes,
        outcome: "committed",
        guarantee: "atomic",
      };
    if (status?.canRollback === true)
      return rollbackExactly(
        skill.name,
        "commit",
        `The change could not be committed: ${commit.error ?? "unknown error"}.`,
        plan,
        preFingerprint,
        deps,
      );
    return unprovable(
      skill.name,
      "commit",
      `The change could not be committed: ${commit.error ?? "unknown error"}.`,
      plan.transactionId,
      status?.failureCode,
    );
  }

  // Every other unresolved state is a refusal, not a success.
  const finalStatus = isRecord(commit.data) ? (commit.data as TxnStatus) : null;
  if (finalStatus?.status !== "committed") {
    const status = await readStatus(deps, plan.transactionId);
    if (status?.status !== "committed")
      return unprovable(
        skill.name,
        "commit",
        "The commit did not report a committed transaction.",
        plan.transactionId,
        status?.failureCode,
      );
  }

  return {
    ok: true,
    skill: skill.name,
    slots: validated.slots,
    calls: plan.steps.map((step) => step.call),
    transactionId: plan.transactionId,
    changes,
    outcome: "committed",
    guarantee: "atomic",
  };
}
