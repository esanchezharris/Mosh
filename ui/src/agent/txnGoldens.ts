// FS-B2a — the bridge between the TypeScript planner and the REAL engine.
//
// fs-b2.md's last acceptance bullet asks for "one B2 reference skill [that] passes the same
// harness against both the mock and a real engine". The mock side is vitest. The real side is
// `Mosh --run-script`, which replays a JSONL of command envelopes through MoshOps::execute.
//
// These functions render a planSkillTransaction() plan into that JSONL, so the SAME expansion
// drives both. The rendered scripts are committed under tests/golden/txn/ and pinned by
// txnGoldens.test.ts, and verify.py replays them against a freshly-built binary — which is
// what makes the real-engine leg a gate rather than a manual demo.

import type { SkillTransactionPlan } from "./skillTransaction";

/** One line of a run-script: a command envelope, optionally with capture/transaction. */
export type RunScriptLine = {
  readonly command: string;
  readonly args?: Record<string, unknown>;
  readonly capture?: Record<string, string>;
  readonly transaction?: { transactionId: string; requestId: string; index: number };
};

/** How the scripted transaction should end. */
export type GoldenShape =
  | "commit"     // every step applies, then batch_end
  | "rollback"   // a step is made to fail, then batch_rollback restores the pre-state
  | "replay";    // a step is sent TWICE with the same requestId, then batch_end

/**
 * Render a plan as run-script lines.
 *
 * `${T1}` is run-script's capture syntax: the fixture's `create_track` captures its
 * engine-assigned trackId, and later args substitute it. That is why the plan is built with
 * "${T1}" as the trackId slot — the ids are the ENGINE's, not the script's.
 */
export function renderTxnGolden(plan: SkillTransactionPlan, shape: GoldenShape): RunScriptLine[] {
  const lines: RunScriptLine[] = [
    // A dedicated fixture track, outside the transaction.
    { command: "create_track", args: { name: "Golden Fixture" }, capture: { T1: "trackId" } },
    // Step 2 of the harness protocol.
    { command: "batch_begin", args: { transactionId: plan.transactionId, name: plan.name, commands: plan.manifest } },
    // A status read BEFORE any step: proves the fingerprint starts equal to preFingerprint.
    { command: "batch_status", args: { transactionId: plan.transactionId } },
  ];

  plan.steps.forEach((step, i) => {
    const isLast = i === plan.steps.length - 1;
    const args = shape === "rollback" && isLast
      // Force the LAST step to fail for a real engine reason (an unknown track), so the
      // rollback has one applied step to revert and one failure to report.
      ? { ...step.call.args, trackId: "no-such-track-id" }
      : step.call.args;
    lines.push({ command: step.call.command, args, transaction: step.meta });
    // The replay shape re-sends the FIRST step verbatim: same requestId, same envelope.
    if (shape === "replay" && i === 0)
      lines.push({ command: step.call.command, args, transaction: step.meta });
  });

  // A status read while the transaction is still OPEN (step 5) — its fingerprint must differ
  // from preFingerprint, which is the anti-vacuity leg of the rollback assertion.
  lines.push({ command: "batch_status", args: { transactionId: plan.transactionId } });
  lines.push({
    command: shape === "rollback" ? "batch_rollback" : "batch_end",
    args: { transactionId: plan.transactionId },
  });
  // And the authoritative final read.
  lines.push({ command: "batch_status", args: { transactionId: plan.transactionId } });
  return lines;
}

/** Serialize to the JSONL run-script format (one compact JSON object per line). */
export function renderTxnGoldenText(plan: SkillTransactionPlan, shape: GoldenShape): string {
  return renderTxnGolden(plan, shape).map((line) => JSON.stringify(line)).join("\n") + "\n";
}
