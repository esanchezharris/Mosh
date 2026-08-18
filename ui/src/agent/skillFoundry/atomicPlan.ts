// Task 7 — the trusted, dynamic atomic transaction runner, extracted from skillHarness.ts.
//
// This module owns nothing about WHICH skills are transactable or how their slots,
// preconditions, and templates are validated — that stays in skillHarness.ts's `runSkill`,
// the static-catalog adapter. `runAtomicSkillPlanV1` only knows how to drive one
// already-planned, already-preconditioned engine transaction through the six-step FS-B2a
// protocol (docs/first-stranger-program/lanes/fs-b2.md), with two guard checkpoints a caller
// can use to re-validate context: `before_begin`, immediately before the transaction opens,
// and `before_commit`, immediately after the postcondition passes and before `batch_end`.
//
// `readStatus`, `unprovable`, `rollbackExactly`, and steps 2–6 of the old `runSkill` moved
// here VERBATIM — same ordering, same status-driven reconciliation, same "never claim
// rolled_back without a matching pre-state fingerprint" discipline. The guard calls are the
// only new behavior; the static-catalog adapter in skillHarness.ts supplies
// `ALWAYS_OK_ATOMIC_GUARD`, so its observable behavior is unchanged by this extraction.

import type { Snapshot } from "../../types";
import type { SkillCheck, SkillExecutionSummary, SkillSlotValues } from "../skills";
import type {
  BridgeResult,
  SkillFailureStage,
  SkillGuarantee,
  SkillHarnessDeps,
  SkillRunResult,
  TxnStatus,
} from "../skillHarness";
import type { SkillTransactionPlan } from "../skillTransaction";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const detail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const GUARANTEE: SkillGuarantee = "atomic";

/** The two points in the protocol a caller may re-validate context: before the transaction
 *  opens, and after the postcondition passes but before it commits. */
export type AtomicSkillGuardPhaseV1 = "before_begin" | "before_commit";

/** One already-planned, already-preconditioned atomic skill run. `slots` and `before` are
 *  carried through only for the guard context and the final result envelope — this runner
 *  performs no slot validation and no precondition check itself. `verifyPostcondition` takes
 *  no slots because the caller closes over them; that keeps this module's only dependency on
 *  "what a skill is" at the shape of `SkillCheck`/`SkillExecutionSummary`. */
export type AtomicSkillPlanV1 = {
  readonly skill: string;
  readonly version: string;
  readonly slots: SkillSlotValues;
  readonly before: Snapshot;
  readonly transaction: SkillTransactionPlan;
  readonly verifyPostcondition: (
    before: Snapshot,
    after: Snapshot,
    changes: SkillExecutionSummary,
  ) => SkillCheck | Promise<SkillCheck>;
};

export type AtomicSkillGuardContextV1 = {
  readonly skill: string;
  readonly version: string;
  readonly transactionId: string;
  readonly before: Snapshot;
  readonly after?: Snapshot;
};

export type AtomicSkillPlanDepsV1 = {
  readonly snapshot: () => Promise<Snapshot>;
  readonly exec: SkillHarnessDeps["exec"];
  readonly guard: (
    phase: AtomicSkillGuardPhaseV1,
    context: AtomicSkillGuardContextV1,
  ) => Promise<SkillCheck>;
};

/** Always passes. The static-catalog adapter in skillHarness.ts uses this so its observable
 *  behavior is byte-for-byte unchanged by this extraction — the guard checkpoints are new
 *  seams for a dynamic (owner-authored) plan, not a behavior change for the fixed catalog. */
export const ALWAYS_OK_ATOMIC_GUARD: AtomicSkillPlanDepsV1["guard"] = async () => ({ ok: true });

/** Read authoritative status. A malformed or unreadable answer is NEVER read as
 *  "nothing happened" — it returns null, which every caller treats as unprovable. */
async function readStatus(
  exec: AtomicSkillPlanDepsV1["exec"],
  transactionId: string,
): Promise<TxnStatus | null> {
  let result: BridgeResult;
  try {
    result = await exec("batch_status", { transactionId });
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
    guarantee: GUARANTEE,
  };
}

/**
 * EXACT rollback of the identified, still-open transaction.
 *
 * `rolledBack: true` is returned only when authoritative status says `rolled_back` AND the
 * reported fingerprint equals the captured pre-state. A transport success or a merely
 * requested undo is never enough.
 */
async function rollbackExactly(
  skill: string,
  stage: SkillFailureStage,
  reason: string,
  transaction: SkillTransactionPlan,
  preFingerprint: string | undefined,
  deps: AtomicSkillPlanDepsV1,
): Promise<SkillRunResult> {
  const { transactionId } = transaction;
  try {
    await deps.exec("batch_rollback", { transactionId });
  } catch {
    /* A lost rollback response is resolved by status below, never by a second undo. */
  }

  const status = await readStatus(deps.exec, transactionId);
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
    guarantee: GUARANTEE,
  };
}

/**
 * Drive one already-planned, already-preconditioned engine transaction through the six-step
 * FS-B2a protocol, with two guard checkpoints:
 *
 *   `before_begin`  — called immediately before `batch_begin`. A rejection reports
 *                      `outcome: "no_edit"`: nothing has been opened yet.
 *   `before_commit` — called after the postcondition passes, immediately before `batch_end`.
 *                      A rejection triggers the same identified, pre-state-proven rollback
 *                      as a postcondition failure, because the transaction is still open.
 */
export async function runAtomicSkillPlanV1(
  plan: AtomicSkillPlanV1,
  deps: AtomicSkillPlanDepsV1,
): Promise<SkillRunResult> {
  const { skill, version, before, transaction } = plan;

  const noEdit = (stage: SkillFailureStage, reason: string): SkillRunResult => ({
    ok: false,
    skill,
    stage,
    reason,
    rolledBack: false,
    outcome: "no_edit",
    guarantee: GUARANTEE,
  });

  // ── GUARD: before_begin ──
  let beforeBeginGuard: SkillCheck;
  try {
    beforeBeginGuard = await deps.guard("before_begin", {
      skill,
      version,
      transactionId: transaction.transactionId,
      before,
    });
  } catch (error) {
    return noEdit("begin", `before_begin guard failed: ${detail(error)}`);
  }
  if (!beforeBeginGuard.ok) return noEdit("begin", beforeBeginGuard.reason);

  // ── STEP 2: idempotent batch_begin with the full manifest ──
  // The engine validates the whole manifest against its own transactionSafe registry BEFORE
  // opening the Tracktion transaction, so a rejection here has mutated nothing.
  let begin: BridgeResult;
  try {
    begin = await deps.exec("batch_begin", {
      transactionId: transaction.transactionId,
      name: transaction.name,
      commands: transaction.manifest,
    });
  } catch (error) {
    // A rejected begin promise is ambiguous: the transaction may or may not be open.
    // Resolve it by id — never by inferring from the rejection.
    const status = await readStatus(deps.exec, transaction.transactionId);
    if (status === null)
      return unprovable(
        skill,
        "begin",
        `Could not open a transaction: ${detail(error)}.`,
        transaction.transactionId,
      );
    if (!status.found)
      return noEdit("begin", `Could not open a transaction: ${detail(error)}. No edit was made.`);
    // It IS open despite the lost response — roll it back rather than proceeding blind.
    return rollbackExactly(
      skill,
      "begin",
      `The transaction opened but its response was lost.`,
      transaction,
      status.preFingerprint,
      deps,
    );
  }

  if (!begin.ok)
    return noEdit("begin", `${skill} was refused before any change: ${begin.error ?? "unknown error"}`);

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

  for (const step of transaction.steps) {
    let result: BridgeResult | null = null;
    try {
      result = await deps.exec(step.call.command, step.call.args ?? {}, step.meta);
    } catch (error) {
      // TRANSPORT LOSS. Ask the authority what actually happened.
      const status = await readStatus(deps.exec, transaction.transactionId);
      if (status === null || !status.found)
        return unprovable(
          skill,
          "execution",
          `${step.call.command} did not return (${detail(error)}) and its transaction could not be read.`,
          transaction.transactionId,
        );
      if (status.status === "needs_recovery")
        return unprovable(
          skill,
          "execution",
          `${step.call.command} did not return (${detail(error)}).`,
          transaction.transactionId,
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
            skill,
            "execution",
            `${step.call.command} could not be completed (${detail(retryError)}).`,
            transaction,
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
        skill,
        "execution",
        `${step.call.command} failed: ${result.error ?? "unknown error"}.`,
        transaction,
        preFingerprint,
        deps,
      );
  }

  const changes: SkillExecutionSummary = {
    applied: entries.filter((entry) => entry.ok).length,
    entries,
  };

  // Cross-check the engine's own accounting against ours before trusting either.
  const applyStatus = await readStatus(deps.exec, transaction.transactionId);
  if (applyStatus === null || !applyStatus.found)
    return unprovable(
      skill,
      "execution",
      "The transaction's status became unreadable after its commands ran.",
      transaction.transactionId,
    );
  if (applyStatus.status === "needs_recovery")
    return unprovable(
      skill,
      "execution",
      "The engine could not prove the transaction's edit state.",
      transaction.transactionId,
      applyStatus.failureCode,
    );
  if (applyStatus.applied !== transaction.steps.length || applyStatus.canCommit !== true)
    return rollbackExactly(
      skill,
      "execution",
      `The engine recorded ${applyStatus.applied ?? 0} of ${transaction.steps.length} commands as applied.`,
      transaction,
      preFingerprint,
      deps,
    );

  // ── STEP 5: evaluate the postcondition WHILE THE TRANSACTION IS STILL OPEN ──
  let after: Snapshot;
  try {
    after = await deps.snapshot();
  } catch (error) {
    return rollbackExactly(
      skill,
      "postcondition",
      `Could not read the resulting session state: ${detail(error)}.`,
      transaction,
      preFingerprint,
      deps,
    );
  }

  let postcondition: SkillCheck;
  try {
    postcondition = await plan.verifyPostcondition(before, after, changes);
  } catch (error) {
    return rollbackExactly(
      skill,
      "postcondition",
      `Postcondition failed: ${detail(error)}.`,
      transaction,
      preFingerprint,
      deps,
    );
  }
  if (!postcondition.ok)
    return rollbackExactly(skill, "postcondition", postcondition.reason, transaction, preFingerprint, deps);

  // ── GUARD: before_commit ──
  let beforeCommitGuard: SkillCheck;
  try {
    beforeCommitGuard = await deps.guard("before_commit", {
      skill,
      version,
      transactionId: transaction.transactionId,
      before,
      after,
    });
  } catch (error) {
    return rollbackExactly(
      skill,
      "commit",
      `before_commit guard failed: ${detail(error)}.`,
      transaction,
      preFingerprint,
      deps,
    );
  }
  if (!beforeCommitGuard.ok)
    return rollbackExactly(skill, "commit", beforeCommitGuard.reason, transaction, preFingerprint, deps);

  // ── STEP 6: only now, commit. A lost response resolves through status. ──
  const committed = (): SkillRunResult => ({
    ok: true,
    skill,
    slots: plan.slots,
    calls: transaction.steps.map((step) => step.call),
    transactionId: transaction.transactionId,
    changes,
    outcome: "committed",
    guarantee: GUARANTEE,
  });

  let commit: BridgeResult | null = null;
  try {
    commit = await deps.exec("batch_end", { transactionId: transaction.transactionId });
  } catch (error) {
    const status = await readStatus(deps.exec, transaction.transactionId);
    if (status?.status === "committed") return committed();
    return unprovable(
      skill,
      "commit",
      `The commit response was lost (${detail(error)}).`,
      transaction.transactionId,
      status?.failureCode,
    );
  }

  if (!commit.ok) {
    const status = await readStatus(deps.exec, transaction.transactionId);
    if (status?.status === "committed") return committed();
    if (status?.canRollback === true)
      return rollbackExactly(
        skill,
        "commit",
        `The change could not be committed: ${commit.error ?? "unknown error"}.`,
        transaction,
        preFingerprint,
        deps,
      );
    return unprovable(
      skill,
      "commit",
      `The change could not be committed: ${commit.error ?? "unknown error"}.`,
      transaction.transactionId,
      status?.failureCode,
    );
  }

  // Every other unresolved state is a refusal, not a success.
  const finalStatus = isRecord(commit.data) ? (commit.data as TxnStatus) : null;
  if (finalStatus?.status !== "committed") {
    const status = await readStatus(deps.exec, transaction.transactionId);
    if (status?.status !== "committed")
      return unprovable(
        skill,
        "commit",
        "The commit did not report a committed transaction.",
        transaction.transactionId,
        status?.failureCode,
      );
  }

  return committed();
}
