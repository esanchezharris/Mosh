// Plumbing proof for the P1 novice-jam suite on the MOCK substrate (no native
// binary in this worktree — see the report on why the real engine run is the
// owner's, not this session's). This does NOT assert a pass rate; it proves
// the harness can load every task, replay every setup against the production
// executor path, and grade every goal kind without throwing — i.e. "tasks
// load, seeds apply, grading runs" per the workstream brief. The real ≥80%
// verdict only means something against the real headless engine + a real
// brain (see the command in the report).

import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../store";
import { __resetMockForTests } from "../bridge.mock";
import { NOVICE_JAM_TASKS, noviceJamTaskById } from "./noviceJamTasks";
import { scoreTask } from "./goalChecks";
import { makeMockEnv, runMockSetup } from "./mockEnv";
import { AGENT_COMMAND_MAP } from "../agent/commands";

describe("novice-jam task suite — static sanity", () => {
  it("has exactly 25 tasks, ids unique", () => {
    expect(NOVICE_JAM_TASKS.length).toBe(25);
    const ids = NOVICE_JAM_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("exactly 4 ambiguous tasks, each carrying only the defer goal and par 0", () => {
    const amb = NOVICE_JAM_TASKS.filter((t) => t.ambiguous);
    expect(amb.length).toBe(4);
    for (const t of amb) {
      expect(t.goals).toEqual([{ kind: "defer" }]);
      expect(t.par).toBe(0);
    }
  });

  it("action tasks have a positive par (an honest minimum step/command count)", () => {
    for (const t of NOVICE_JAM_TASKS.filter((t) => !t.ambiguous))
      expect(t.par, `${t.id} par`).toBeGreaterThan(0);
  });

  it("every setup command is agent-callable (keeps setups replayable on both substrates)", () => {
    for (const t of NOVICE_JAM_TASKS)
      for (const c of t.setup)
        expect(AGENT_COMMAND_MAP.has(c.command), `${t.id} setup uses non-catalog "${c.command}"`).toBe(true);
  });

  it("noviceJamTaskById resolves every id and throws on an unknown one", () => {
    for (const t of NOVICE_JAM_TASKS) expect(noviceJamTaskById(t.id).id).toBe(t.id);
    expect(() => noviceJamTaskById("nope")).toThrow();
  });
});

describe("novice-jam task suite — plumbing smoke on the mock substrate", () => {
  beforeEach(() => __resetMockForTests());

  for (const task of NOVICE_JAM_TASKS) {
    it(`${task.id}: setup replays cleanly and grading runs without throwing`, async () => {
      await useStore.getState().refresh();
      await runMockSetup(task.setup); // throws on any setup command failure
      const env = makeMockEnv();
      const before = await env.getSnapshot();

      // A trivial (deferred) run is enough to prove grade() executes for
      // every GoalCheck kind this task uses — we are not asserting success.
      const run = { finalSnapshot: before, transcript: [], stepCount: 0, deferred: true };
      const score = scoreTask(task, before, run);

      expect(score.checks.length).toBe(task.goals.length);
      for (const c of score.checks) {
        expect(typeof c.pass).toBe("boolean");
        expect(typeof c.note).toBe("string");
      }
    });
  }
});
