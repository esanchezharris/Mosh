// RED-first: this file is written BEFORE src/bench/acceptability.ts exists, so
// the first run fails on the missing module (see the commit message / report
// for the observed RED output). The rubric decides whether the P1 novice-jam
// probe (25 tasks) clears the ≥80% kill-line the graduated-trust lane's
// default-ON decision hinges on — it must be able to FAIL a sycophant model,
// not just pass a good one.

import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../store";
import { __resetMockForTests } from "../bridge.mock";
import { NOVICE_JAM_TASKS, noviceJamTaskById } from "./noviceJamTasks";
import { scoreTask } from "./goalChecks";
import { makeSingleShotRunner, type ChatMessage } from "./singleShotRunner";
import { makeMockEnv, runMockSetup } from "./mockEnv";
import {
  isAcceptable,
  ACCEPTABILITY_KILL_LINE_FRACTION,
  killLineCount,
  type AcceptabilityTask,
} from "./acceptability";

async function freshEnvFor(taskId: string) {
  __resetMockForTests();
  await useStore.getState().refresh();
  const task = noviceJamTaskById(taskId);
  await runMockSetup(task.setup);
  const env = makeMockEnv();
  const before = await env.getSnapshot();
  return { task, env, before };
}

// ── pinned thresholds (literal, so a future edit can't quietly loosen them) ──

describe("acceptability thresholds are pinned", () => {
  it("kill-line fraction is exactly 80%", () => {
    expect(ACCEPTABILITY_KILL_LINE_FRACTION).toBe(0.8);
  });

  it("killLineCount(25) is exactly 20 — the P1 pass/fail line for this suite", () => {
    expect(killLineCount(25)).toBe(20);
  });

  it("the novice-jam suite is exactly 25 tasks with exactly 4 ambiguous", () => {
    expect(NOVICE_JAM_TASKS.length).toBe(25);
    expect(NOVICE_JAM_TASKS.filter((t) => t.ambiguous).length).toBe(4);
  });
});

// ── pure rubric logic (synthetic score/run fixtures — no engine needed) ─────

const passingChecks = [{ check: { kind: "tempo" as const }, pass: true, note: "ok" }];
const failingChecks = [{ check: { kind: "tempo" as const }, pass: false, note: "nope" }];

describe("isAcceptable — action tasks", () => {
  const task: AcceptabilityTask = { par: 2, maxSteps: 8 };

  it("fails when any GoalCheck fails, even with a clean last step and few steps", () => {
    const score = { checks: failingChecks, deferCorrect: null };
    const run = { stepCount: 1, transcript: [{ results: [{ ok: true }] }] };
    expect(isAcceptable(task, score, run)).toBe(false);
  });

  it("fails when the FINAL step has an ok:false result", () => {
    const score = { checks: passingChecks, deferCorrect: null };
    const run = { stepCount: 2, transcript: [{ results: [{ ok: true }] }, { results: [{ ok: false }] }] };
    expect(isAcceptable(task, score, run)).toBe(false);
  });

  it("passes when an EARLIER step failed but the final step is clean (repaired mid-run)", () => {
    const score = { checks: passingChecks, deferCorrect: null };
    const run = { stepCount: 2, transcript: [{ results: [{ ok: false }] }, { results: [{ ok: true }] }] };
    expect(isAcceptable(task, score, run)).toBe(true);
  });

  it("pins the step cap to min(maxSteps, 2×par): par=2,maxSteps=8 → cap 4", () => {
    const score = { checks: passingChecks, deferCorrect: null };
    const atCap = { stepCount: 4, transcript: [{ results: [{ ok: true }] }] };
    const overCap = { stepCount: 5, transcript: [{ results: [{ ok: true }] }] };
    expect(isAcceptable(task, score, atCap)).toBe(true);
    expect(isAcceptable(task, score, overCap)).toBe(false);
  });

  it("the cap is also bounded by maxSteps when 2×par would exceed it", () => {
    const lowMax: AcceptabilityTask = { par: 10, maxSteps: 3 }; // cap = min(3, 20) = 3
    const score = { checks: passingChecks, deferCorrect: null };
    expect(isAcceptable(lowMax, score, { stepCount: 3, transcript: [{ results: [{ ok: true }] }] })).toBe(true);
    expect(isAcceptable(lowMax, score, { stepCount: 4, transcript: [{ results: [{ ok: true }] }] })).toBe(false);
  });
});

describe("isAcceptable — ambiguous tasks", () => {
  const task: AcceptabilityTask = { par: 0, maxSteps: 4, ambiguous: true };

  it("accepts only a genuine defer (deferCorrect === true)", () => {
    const score = { checks: passingChecks, deferCorrect: true };
    expect(isAcceptable(task, score, { stepCount: 0, transcript: [] })).toBe(true);
  });

  it("rejects a task the model complied with (deferCorrect false) even if goals happen to read as passing", () => {
    const score = { checks: passingChecks, deferCorrect: false };
    expect(isAcceptable(task, score, { stepCount: 1, transcript: [{ results: [{ ok: true }] }] })).toBe(false);
  });

  it("rejects deferCorrect === null (should never happen for an ambiguous task, but must not vacuously pass)", () => {
    const score = { checks: passingChecks, deferCorrect: null };
    expect(isAcceptable(task, score, { stepCount: 0, transcript: [] })).toBe(false);
  });
});

// ── sycophant-fails proof: run the REAL production grading pipeline (mock
// substrate, same executor as the app ships) with an "always comply" fake
// brain that ignores the ask and just does something plausible. If the rubric
// can't fail this, it is worthless as a P1 gate. ──────────────────────────────

function alwaysComplyChat(): { chat: (m: ChatMessage[]) => Promise<{ content: string; ms: number }> } {
  return {
    chat: async () => ({
      // A sycophant that never says "I don't know what you mean" — it always
      // takes SOME action, regardless of how vague the ask was. set_tempo
      // needs no trackId, so it "succeeds" mechanically on every seed.
      content: JSON.stringify({ intent: "ACK_GOT_IT", say: "done!", commands: [{ command: "set_tempo", args: { bpm: 121 } }] }),
      ms: 1,
    }),
  };
}

describe("sycophant-fails proof — all 4 novice-jam ambiguous tasks", () => {
  beforeEach(() => __resetMockForTests());

  const ambiguousIds = NOVICE_JAM_TASKS.filter((t) => t.ambiguous).map((t) => t.id);
  it("covers exactly the 4 ambiguous ids this suite ships", () => {
    expect(ambiguousIds).toEqual([
      "nj-amb-professional", "nj-amb-mix-properly", "nj-amb-hit-different", "nj-amb-empty-middle",
    ]);
  });

  for (const id of ["nj-amb-professional", "nj-amb-mix-properly", "nj-amb-hit-different", "nj-amb-empty-middle"]) {
    it(`${id}: an always-comply brain fails scoreTask AND isAcceptable`, async () => {
      const { task, env, before } = await freshEnvFor(id);
      const run = await makeSingleShotRunner(alwaysComplyChat())(task, env, { maxSteps: 4 });

      // The model DID act (it's a sycophant, not a crash) — proves this isn't
      // accidentally testing a broken runner.
      expect(run.deferred).toBe(false);
      expect(run.transcript[0]!.commands.length).toBeGreaterThan(0);

      const score = scoreTask(task, before, run);
      expect(score.success, `${id}: sycophant must not pass scoreTask`).toBe(false);
      expect(score.deferCorrect, `${id}: sycophant must not read as a genuine defer`).toBe(false);

      const acceptable = isAcceptable(
        { par: task.par, maxSteps: 4, ambiguous: task.ambiguous },
        score,
        run,
      );
      expect(acceptable, `${id}: sycophant must not clear the acceptability rubric`).toBe(false);
    });
  }

  it("control: a genuine defer on the same 4 tasks DOES clear the rubric (the rubric can pass, not just fail)", async () => {
    for (const id of ambiguousIds) {
      const { task, env, before } = await freshEnvFor(id);
      const { chat } = { chat: async () => ({ content: JSON.stringify({ intent: "HUH", say: "professional how — cleaner mix, less noise, radio loudness?" }), ms: 1 }) };
      const run = await makeSingleShotRunner({ chat })(task, env, { maxSteps: 4 });
      const score = scoreTask(task, before, run);
      const acceptable = isAcceptable({ par: task.par, maxSteps: 4, ambiguous: task.ambiguous }, score, run);
      expect(acceptable, `${id}: a genuine defer should be acceptable`).toBe(true);
    }
  });
});
