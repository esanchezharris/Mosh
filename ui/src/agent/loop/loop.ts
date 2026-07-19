// The agentic loop FSM — PLANNING → STEPPING → OBSERVING → REPAIRING →
// FINALIZING — as a PURE, deps-injected async function (the skillHarness
// idiom): chat in, env batches out, honest outcome back. No store, no bridge,
// no UI — B3 wraps it as an AgentRunner for the bench, B4 drives it from the
// composer with a progress callback.
//
// Execution semantics live in the ENV (validation, destructive screen, batch
// bracketing — see loopSeam.ts); the FSM owns budgets, plan-following, the
// observe/repair ladder and stop conditions:
//   done      — model status "done", or a fully-inline plan completed all-ok
//   need_user — the model parked (HUH semantics), or unparseable output
//   budget    — steps / model calls / wall-clock exhausted
//   error     — chat transport failure, or repairs exhausted the planner budget
//   aborted   — the user's Stop, checked before every step

import { validateCommand } from "../commands";
import type { AgentCommandCall } from "../destructiveScreen";
import type { AgentEnv, AgentTaskRun, StepRecord } from "../loopSeam";
import { buildLoopSystemPrompt, renderTaskContext, type TaskContextMode } from "./loopPrompt";
import { parseLoopReply, type LoopReply, type PlanStep } from "./parse";
import type { Snapshot } from "../../types";

export type LoopBudgets = {
  /** Executed batches per task. */
  maxSteps: number;
  /** Plan call + repair calls (the "cloud" budget). */
  maxPlannerCalls: number;
  /** Compile/continue calls (the "local" budget once routing splits seats). */
  maxStepCalls: number;
  softWallMs: number;
};

export const DEFAULT_LOOP_BUDGETS: LoopBudgets = {
  maxSteps: 8,
  maxPlannerCalls: 3,
  maxStepCalls: 8,
  softWallMs: 180_000,
};

export type LoopOutcome = "done" | "need_user" | "budget" | "error" | "aborted";

export type LoopProgressEvent =
  | { kind: "phase"; phase: "planning" | "stepping" | "repairing" | "finalizing" }
  | { kind: "plan"; plan: readonly PlanStep[]; say?: string }
  | { kind: "step-start"; index: number; goal?: string; commands: readonly AgentCommandCall[] }
  | { kind: "step-result"; index: number; results: StepRecord["results"] };

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type LoopDeps = {
  chat: (messages: ChatMessage[]) => Promise<{ content: string; ms?: number }>;
  env: AgentEnv;
  budgets?: Partial<LoopBudgets>;
  /** Structural AbortSignal — only `.aborted` is read, checked at every juncture. */
  signal?: { aborted: boolean };
  onProgress?: (e: LoopProgressEvent) => void;
  now?: () => number;
  /** M2 — an optional pre-rendered memory block (retrieveContext() in
   *  agent/memory/retrieveContext.ts), computed ONCE by the caller (runTask.ts)
   *  before the loop starts and passed through unchanged to every step's
   *  buildLoopSystemPrompt call — hydration/ranking is not a per-step cost, and this
   *  FSM stays pure/deps-injected (no bridge call inside the loop itself). Omitted ⇒
   *  every step's prompt is byte-identical to the pre-M2 shape. */
  memory?: string;
};

export type LoopRun = AgentTaskRun & { outcome: LoopOutcome; say?: string };

const countInvalid = (calls: readonly AgentCommandCall[]): number =>
  calls.filter((c) => validateCommand(c.command, (c.args ?? {}) as Record<string, unknown>) !== null).length;

export async function runAgentLoop(task: { ask: string }, deps: LoopDeps): Promise<LoopRun> {
  const b: LoopBudgets = { ...DEFAULT_LOOP_BUDGETS, ...deps.budgets };
  const now = deps.now ?? (() => Date.now());
  const t0 = now();
  const progress = (e: LoopProgressEvent) => deps.onProgress?.(e);
  const aborted = () => deps.signal?.aborted === true;

  const transcript: StepRecord[] = [];
  let snap: Snapshot = await deps.env.getSnapshot();
  let plan: PlanStep[] = [];
  let planIdx = 0;
  let plannerCalls = 0;
  let stepCalls = 0;
  let say: string | undefined;
  let error: string | undefined;
  let outcome: LoopOutcome | undefined;
  let lastMs = 0;

  const repliesLeft = () => Math.max(0, b.maxPlannerCalls - plannerCalls) + Math.max(0, b.maxStepCalls - stepCalls);
  const callModel = async (mode: TaskContextMode, goal?: string): Promise<LoopReply | null> => {
    const messages: ChatMessage[] = [
      { role: "system", content: buildLoopSystemPrompt(snap, task.ask, deps.memory) },
      { role: "user", content: renderTaskContext({
          ask: task.ask, plan, planIdx, history: transcript,
          stepsLeft: Math.max(0, b.maxSteps - transcript.length), repliesLeft: repliesLeft(),
          mode, goal,
        }) },
    ];
    try {
      const r = await deps.chat(messages);
      lastMs = r.ms ?? 0;
      return parseLoopReply(r.content);
    } catch (e) {
      error = String(e).slice(0, 200);
      return null;
    }
  };

  // ── PLANNING ────────────────────────────────────────────────────────────────
  progress({ kind: "phase", phase: "planning" });
  plannerCalls++;
  const first = await callModel("plan");
  // `lastStatus` drives the bare-commands incremental mode; a plan supersedes it.
  let lastStatus: LoopReply["status"] | "plan" = "done";
  let doneAfterStep = false;
  if (!first) outcome = "error";
  else {
    say = first.say ?? say;
    if (first.status === "need_user" || first.parseFailed) outcome = "need_user";
    else {
      plan = [...(first.plan ?? [])];
      const hadPlanArray = plan.length > 0;
      if (first.commands?.length) plan.unshift({ goal: "start", commands: first.commands });
      if (plan.length) {
        // A real plan array = plan mode (exhaustion ⇒ done). BARE commands keep
        // their own status: "continue" arms the incremental mode, "done" closes
        // after the step executes.
        lastStatus = hadPlanArray ? "plan" : first.status;
        if (hadPlanArray) progress({ kind: "plan", plan, say: first.say });
      } else {
        outcome = first.status === "done" ? "done" : "need_user"; // continue-with-nothing = park
      }
    }
  }

  // ── STEP LOOP ───────────────────────────────────────────────────────────────
  let repairMode = false;
  while (!outcome) {
    if (aborted()) { outcome = "aborted"; break; }
    if (now() - t0 > b.softWallMs) { outcome = "budget"; break; }
    if (transcript.length >= b.maxSteps) { outcome = "budget"; break; }

    let commands: AgentCommandCall[] | undefined;
    let goal: string | undefined;

    if (repairMode) {
      // ── REPAIRING — spends the planner budget (plan + repairs) ─────────────
      if (plannerCalls >= b.maxPlannerCalls) { outcome = "error"; break; }
      progress({ kind: "phase", phase: "repairing" });
      plannerCalls++;
      const r = await callModel("repair");
      if (!r) { outcome = "error"; break; }
      say = r.say ?? say;
      if (r.status === "need_user") { outcome = "need_user"; break; }
      if (!r.commands?.length) { outcome = r.status === "done" ? "done" : "error"; break; }
      commands = r.commands;
      goal = "repair";
      doneAfterStep = r.status === "done";
      repairMode = false;
    } else if (planIdx < plan.length) {
      const step = plan[planIdx]!;
      if (step.commands?.length) {
        commands = step.commands;
        goal = step.goal;
        planIdx++;
      } else {
        // ── compile a goal-only step ───────────────────────────────────────
        if (stepCalls >= b.maxStepCalls) { outcome = "budget"; break; }
        stepCalls++;
        const r = await callModel("compile", step.goal);
        if (!r) { outcome = "error"; break; }
        say = r.say ?? say;
        if (r.status === "need_user") { outcome = "need_user"; break; }
        if (!r.commands?.length) { outcome = r.status === "done" ? "done" : "error"; break; }
        commands = r.commands;
        goal = step.goal;
        doneAfterStep = r.status === "done";
        planIdx++;
      }
    } else if (lastStatus === "continue") {
      // ── bare-commands incremental mode (no plan was given) ────────────────
      if (stepCalls >= b.maxStepCalls) { outcome = "budget"; break; }
      stepCalls++;
      const r = await callModel("continue");
      if (!r) { outcome = "error"; break; }
      say = r.say ?? say;
      if (r.status === "need_user") { outcome = "need_user"; break; }
      if (!r.commands?.length) { outcome = "done"; break; } // "done" or nothing more to do
      commands = r.commands;
      lastStatus = r.status;
    } else {
      // plan exhausted with every step executed clean — the plan IS the task.
      outcome = "done";
      break;
    }

    // ── STEPPING / OBSERVING ─────────────────────────────────────────────────
    progress({ kind: "phase", phase: "stepping" });
    const index = transcript.length;
    progress({ kind: "step-start", index, goal, commands });
    const { results, snapshot } = await deps.env.runBatch(`moshi task: ${task.ask.slice(0, 48)}`, commands);
    snap = snapshot;
    transcript.push({ say: undefined, intent: undefined, commands, results, invalidCount: countInvalid(commands), ms: lastMs });
    progress({ kind: "step-result", index, results });

    if (results.some((r) => !r.ok)) {
      repairMode = true;      // the next model call sees the verbatim envelopes
      doneAfterStep = false;
      continue;
    }
    if (doneAfterStep) { outcome = "done"; break; }
    if (planIdx >= plan.length && lastStatus === "plan") { outcome = "done"; break; }
  }

  progress({ kind: "phase", phase: "finalizing" });
  return {
    finalSnapshot: snap,
    transcript,
    stepCount: transcript.length,
    deferred: transcript.length === 0,
    outcome: outcome ?? "error",
    say,
    error,
  };
}
