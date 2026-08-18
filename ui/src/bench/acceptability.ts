// The mechanical acceptability rubric for MoshAgentBench probe suites —
// stricter than TaskScore.success (goalChecks.ts). success is "did the task's
// own GoalChecks pass"; acceptable additionally rejects a run that limped to
// a passing state through mid-run flailing on its LAST attempt, or that
// burned far more steps than a competent producer would need. Built for the
// P1 novice-jam probe (25 tasks, ./noviceJamTasks.ts) but generic over any
// AgentTask-shaped suite.
//
// A task is acceptable iff:
//   (a) every GoalCheck passed (score.checks.every(c => c.pass));
//   (b) an ambiguous task produced a GENUINE zero-command defer
//       (score.deferCorrect === true — not just goalsPass, which for a defer
//       task is the SAME check but without the invalid/error rigor
//       scoreTask's deferCorrect already adds; see goalChecks.ts scoreTask);
//   (c) the FINAL step's command results contain no ok:false — a run that
//       failed mid-way and then self-repaired is fine (that's the whole point
//       of the repair ladder / loop), but a run that's still failing when it
//       stops is not "acceptable" even if the goal state happens to read as
//       passing (e.g. a partially-applied batch that satisfied a loose
//       tolerance band by accident);
//   (d) executed steps (run.stepCount) <= min(maxSteps, 2×par) — a task that
//       technically got there in 6 steps when 1 would do is not what
//       "novice-jam works" should mean for a graduated-trust default.
//
// (d) does not apply to ambiguous tasks: par is 0 for all of them by
// definition (see agentTasks.ts AgentTask.par doc), so 2×par collapses the
// cap to 0 regardless of runner — but the single-shot runner legitimately
// takes ONE step (a HUH reply) to defer, while the loop runner takes zero.
// Gating on step count here would fail a correct single-shot defer for a
// reason that has nothing to do with quality. (b) already fully governs
// ambiguous acceptability — a genuine defer in any number of steps IS the
// success condition, so there is nothing left for (d) to add.

export type AcceptabilityCheck = { readonly pass: boolean };
export type AcceptabilityScore = {
  readonly checks: readonly AcceptabilityCheck[];
  /** From TaskScore.deferCorrect: true/false on ambiguous tasks, null on action tasks. */
  readonly deferCorrect: boolean | null;
};
export type AcceptabilityStep = { readonly results: readonly { readonly ok: boolean }[] };
export type AcceptabilityRun = {
  readonly stepCount: number;
  readonly transcript: readonly AcceptabilityStep[];
};
export type AcceptabilityTask = {
  /** Reference step count (0 for ambiguous tasks — see agentTasks.ts). */
  readonly par: number;
  readonly maxSteps: number;
  readonly ambiguous?: boolean;
};

export function isAcceptable(task: AcceptabilityTask, score: AcceptabilityScore, run: AcceptabilityRun): boolean {
  const checksPass = score.checks.every((c) => c.pass);
  if (!checksPass) return false;

  if (task.ambiguous) return score.deferCorrect === true;

  const lastStep = run.transcript[run.transcript.length - 1];
  if (lastStep && lastStep.results.some((r) => !r.ok)) return false;

  const cap = Math.min(task.maxSteps, 2 * task.par);
  return run.stepCount <= cap;
}

/** P1's pass/fail line for a suite: acceptable/total must clear this fraction. */
export const ACCEPTABILITY_KILL_LINE_FRACTION = 0.8;

/** Minimum acceptable count out of `total` to clear the kill-line (ceil, so
 *  e.g. 20/25 = exactly 80% passes, 19/25 = 76% does not). */
export function killLineCount(total: number): number {
  return Math.ceil(total * ACCEPTABILITY_KILL_LINE_FRACTION);
}
