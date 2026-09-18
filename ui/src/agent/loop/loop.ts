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
//   need_user — the model parked (HUH semantics), unparseable output, or the
//               session's revision moved between steps (someone else edited it)
//   budget    — steps / model calls / wall-clock exhausted
//   error     — chat transport failure, or repairs exhausted the planner budget
//   aborted   — the user's Stop, checked before every step

import { validateCommand } from "../commands";
import type { AgentCommandCall } from "../destructiveScreen";
import type { AgentEnv, AgentTaskRun, StepRecord } from "../loopSeam";
import { buildLoopSystemPrompt, renderTaskContext, type TaskContextMode } from "./loopPrompt";
import { parseLoopReply, type LoopReply, type PlanStep } from "./parse";
import type { Snapshot } from "../../types";
import type { AgentExecution } from "../loopSeam";
import { runBoundedProposal } from "./boundedProposal";

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
  | { kind: "step-result"; index: number; results: StepRecord["results"] }
  /** Commands the loop did NOT submit — the planner's top-level copy of commands the
   *  plan already carries, or a repair's re-send of commands that already succeeded
   *  in the step it repairs. `index` is the step slot the skip belongs to (the same
   *  numbering as step-start); `note` is the wording that also lands on a transcript
   *  record's `say` — that step's, or the repaired step's when the skip leaves
   *  nothing to run. Never emitted for steps the model authored as repeats. */
  | { kind: "skip"; index: number; commands: readonly AgentCommandCall[]; note: string };

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type LoopDeps = {
  bounded?: { validate: (calls: readonly AgentCommandCall[]) => string | null };
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
  /** P1 produce lane — an optional system-prompt builder replacing
   *  buildLoopSystemPrompt (same signature). Omitted ⇒ every step's prompt is
   *  byte-identical to the default lane; the produce lane passes
   *  buildProduceSystemPrompt (producePrompt.ts), which wraps the default rather
   *  than forking it. */
  systemPrompt?: (snap: Snapshot | null, query?: string, memory?: string) => string;
};

export type LoopRun = AgentTaskRun & { outcome: LoopOutcome; say?: string; execution?: AgentExecution };

const countInvalid = (calls: readonly AgentCommandCall[]): number =>
  calls.filter((c) => validateCommand(c.command, (c.args ?? {}) as Record<string, unknown>) !== null).length;

/** What the loop says when it parks because the session moved under it (step-1
 *  slice 3, F5 in the brief): the plan was made against a session that no longer
 *  exists, so acting on it would edit the wrong values. */
export const SESSION_CHANGED_SAY = "the session changed while I was working — ask again";

/** Key-order-independent JSON identity for ONE command — the "exactly once"
 *  comparisons below must not be fooled by `{a,b}` vs `{b,a}` from the same model.
 *  `args` defaults to `{}` so a hand-built `{command}` equals the parser's shape. */
const canonCommand = (c: AgentCommandCall): string =>
  JSON.stringify({ command: c.command, args: c.args ?? {} }, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((k) => [k, (value as Record<string, unknown>)[k]]))
      : value);

/** Splits `calls` into [not in `known`, in `known`] by canonical identity, order kept. */
const partitionByIdentity = (
  calls: readonly AgentCommandCall[], known: ReadonlySet<string>,
): [AgentCommandCall[], AgentCommandCall[]] => {
  const kept: AgentCommandCall[] = [], matched: AgentCommandCall[] = [];
  for (const c of calls) (known.has(canonCommand(c)) ? matched : kept).push(c);
  return [kept, matched];
};

const commandNames = (calls: readonly AgentCommandCall[]): string => calls.map((c) => c.command).join(", ");

/** `session.revision` — the engine's per-process mutation counter (MoshOps
 *  editRevision_: bumped by every mutating command and by undo/redo), exposed by
 *  the step-1 engine slice. Read defensively: an engine or mock that does not
 *  report one yields undefined, which keeps the revision guard inert. */
const revisionOf = (s: Snapshot | null | undefined): number | undefined => {
  const r = (s?.session as { revision?: unknown } | undefined)?.revision;
  return typeof r === "number" && Number.isFinite(r) ? r : undefined;
};

export async function runAgentLoop(task: { ask: string }, deps: LoopDeps): Promise<LoopRun> {
  if (deps.bounded) return runBoundedProposal(task, deps);
  const b: LoopBudgets = { ...DEFAULT_LOOP_BUDGETS, ...deps.budgets };
  const now = deps.now ?? (() => Date.now());
  const t0 = now();
  const progress = (e: LoopProgressEvent) => deps.onProgress?.(e);
  const aborted = () => deps.signal?.aborted === true;

  // A dropped/skipped command is never silent: a `skip` progress event fires at the
  // decision, and the wording rides on the `say` of the transcript record it belongs
  // to (the next executed step — or, when nothing is left to run, the step being
  // repaired). No zero-command records: those would shift step indices/budgets and
  // hide a failed last step from acceptability's last-step check.
  const pendingNotes: string[] = [];
  const skip = (index: number, commands: readonly AgentCommandCall[], note: string) => {
    progress({ kind: "skip", index, commands, note });
    pendingNotes.push(note);
  };
  const takeNotes = (): string | undefined => (pendingNotes.length ? pendingNotes.splice(0).join("; ") : undefined);

  const transcript: StepRecord[] = [];
  let snap: Snapshot = await deps.env.getSnapshot();
  let lastRevision = revisionOf(snap);   // the observation the plan is made against
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
      { role: "system", content: (deps.systemPrompt ?? buildLoopSystemPrompt) (snap, task.ask, deps.memory) },
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
      if (first.commands?.length) {
        // Exactly once (step-1 slice 3, R3): a reply that carries its commands BOTH
        // at the top level and on the plan used to run them twice — as this "start"
        // step and again as the plan step that already carried them (live log:
        // A,B,A,B in one transaction, two batches ~20 ms apart, one model reply).
        // Only the planner's copy is deduped, and only here at plan build: every
        // top-level command JSON-equal (key-order independent) to a command in ANY
        // plan step is dropped; whatever remains is still the "start" step. Steps
        // the model AUTHORED are never touched — "duplicate it twice" is two steps,
        // undo/undo is two undos.
        const planned = new Set(plan.flatMap((p) => p.commands ?? []).map(canonCommand));
        const [start, dropped] = partitionByIdentity(first.commands, planned);
        if (dropped.length) skip(0, dropped, `skipped ${dropped.length} top-level command(s) the plan already carries: ${commandNames(dropped)}`);
        if (start.length) plan.unshift({ goal: "start", commands: start });
      }
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
  // Index of the step that opened the current repair chain (the first step with a failed
  // command), or -1 outside a chain. A repair twin may skip any command that already
  // succeeded ANYWHERE in the chain — not just in the immediately preceding record — so a
  // second repair round cannot land an additive command a second time.
  let repairChainStart = -1;
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
      // A repair twin of a PARTIALLY failed step re-sends the commands that already
      // landed alongside the fix. Skip only those — commands that succeeded in the
      // step being repaired (the immediately preceding record: repair mode is armed
      // right after it is pushed) — and say so. Anything that failed there, or is
      // new, runs.
      const repaired = transcript[transcript.length - 1]!;
      const chainStart = repairChainStart >= 0 ? repairChainStart : transcript.length - 1;
      const applied = new Set<string>();
      for (const rec of transcript.slice(chainStart))
        rec.commands.forEach((c, i) => { if (rec.results[i]?.ok === true) applied.add(canonCommand(c)); });
      const [remaining, alreadyApplied] = partitionByIdentity(r.commands, applied);
      if (alreadyApplied.length) {
        const from = chainStart + 1 === transcript.length ? `step ${transcript.length}` : `steps ${chainStart + 1}–${transcript.length}`;
        skip(transcript.length, alreadyApplied,
          `skipped ${alreadyApplied.length} already-applied command(s) from ${from}: ${commandNames(alreadyApplied)}`);
        if (!remaining.length) {
          // Nothing left to run: the note attaches to the step it repairs, and the
          // reply counts as an empty repair — its status decides, as above.
          transcript[transcript.length - 1] = { ...repaired, say: [repaired.say, takeNotes()].filter(Boolean).join("; ") };
          outcome = r.status === "done" ? "done" : "error";
          break;
        }
      }
      commands = remaining;
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
        // Models sometimes answer a compile request with the plan shape again,
        // carrying this step's commands inside plan[i].commands (Sonnet did it
        // on 2 of 4 compile replies in the first live produce run). Accept it
        // when exactly one plan entry carries commands; anything else is still
        // "no commands".
        let compiled = r.commands;
        if (!compiled?.length && r.plan?.length) {
          const carrying = r.plan.filter((p) => p.commands?.length);
          if (carrying.length === 1) compiled = carrying[0]!.commands;
        }
        if (!compiled?.length) { outcome = r.status === "done" ? "done" : "error"; break; }
        commands = compiled;
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

    // ── revision binding: the session this step was planned against must still be
    // the one we would edit. A GUI edit (or anything outside this task) between the
    // last observation and now moves `session.revision`; park rather than act on
    // stale values. Inert when the engine reports no revision (undefined).
    if (lastRevision !== undefined) {
      const fresh = revisionOf(await deps.env.getSnapshot());
      if (fresh !== undefined && fresh !== lastRevision) { say = SESSION_CHANGED_SAY; outcome = "need_user"; break; }
    }

    // ── STEPPING / OBSERVING ─────────────────────────────────────────────────
    progress({ kind: "phase", phase: "stepping" });
    const index = transcript.length;
    progress({ kind: "step-start", index, goal, commands });
    const { results, snapshot } = await deps.env.runBatch(`moshi task: ${task.ask.slice(0, 48)}`, commands);
    snap = snapshot;
    lastRevision = revisionOf(snapshot);   // our own batch bumped it — that is the new baseline, not drift
    // `say` on a loop record is the loop's own note (skips), never the model's — the
    // model's say is surfaced through the run, not per step.
    transcript.push({ say: takeNotes(), intent: undefined, commands, results, invalidCount: countInvalid(commands), ms: lastMs });
    progress({ kind: "step-result", index, results });

    if (results.some((r) => !r.ok)) {
      repairMode = true;      // the next model call sees the verbatim envelopes
      if (repairChainStart < 0) repairChainStart = index;   // the chain opens at the first failed step
      doneAfterStep = false;
      continue;
    }
    repairChainStart = -1;    // a clean step closes the chain
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
