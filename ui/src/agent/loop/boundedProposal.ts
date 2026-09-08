import { z } from "zod";
import { validateCommand } from "../commands";
import type { AgentCommandCall } from "../destructiveScreen";
import type { AgentExecution } from "../loopSeam";
import type { LoopDeps, LoopOutcome, LoopRun } from "./loop";
import { buildLoopSystemPrompt } from "./loopPrompt";

const commandSchema = z.strictObject({
  command: z.string().trim().min(1),
  args: z.record(z.string(), z.json()).default({}),
});
const commandsSchema = z.array(commandSchema).min(1).max(6);
const replySchema = z.strictObject({
  intent: z.string().optional(), say: z.string().optional(),
  status: z.enum(["continue", "done", "need_user"]),
  commands: commandsSchema.optional(),
  plan: z.array(z.strictObject({
    goal: z.string().trim().min(1), commands: commandsSchema.optional(),
  })).min(1).max(6).optional(),
});
type Reply = z.infer<typeof replySchema>;
type ReplyResult = { readonly ok: true; readonly reply: Reply }
  | { readonly ok: false; readonly outcome: LoopOutcome; readonly say: string };

export function executionPresentation(execution: AgentExecution, aborted: boolean): { outcome: LoopOutcome; say: string } {
  switch (execution.status) {
    case "committed": return {
      outcome: aborted ? "aborted" : "done",
      say: aborted ? "Changes committed; observation was cancelled. Nothing was rolled back."
        : execution.error ? `Changes committed; observation is unavailable: ${execution.error}`
        : execution.replayed ? "This request was already committed; no additional changes were applied."
          : `Committed ${execution.appliedCount} change(s).`,
    };
    case "cancelled": return execution.error
      ? { outcome: "need_user", say: `No changes were applied: ${execution.error}.` }
      : { outcome: "aborted", say: "Stopped before application; no changes were applied." };
    case "rolled_back": return { outcome: "error", say: "The patch failed and its applied changes were rolled back." };
    case "unresolved": return { outcome: "error", say: `Execution is unresolved (${execution.appliedCount} recorded applied command(s)); recover the session before retrying. ${execution.error ?? ""}`.trim() };
    case "undone": return { outcome: "need_user", say: "This request was already undone; no additional changes were applied." };
    case "rejected": return { outcome: "need_user", say: `No changes were applied: ${execution.error ?? "the proposal was rejected"}.` };
    case "prepared": return { outcome: "need_user", say: "The request is still prepared or in progress; completion has not been confirmed." };
  }
}

export async function runBoundedProposal(task: { ask: string }, deps: LoopDeps): Promise<LoopRun> {
  const snapshot = await deps.env.getSnapshot();
  const now = deps.now ?? Date.now;
  const started = now();
  const limitMs = deps.budgets?.softWallMs ?? 180_000;
  const maxCalls = 1 + (deps.budgets?.maxStepCalls ?? 8);
  const pending: AgentCommandCall[] = [];
  let callCount = 0;
  let modelMs = 0;
  const aborted = () => deps.signal?.aborted === true;
  const stop = (outcome: LoopOutcome, say: string): LoopRun => {
    deps.onProgress?.({ kind: "phase", phase: "finalizing" });
    return { finalSnapshot: snapshot, transcript: [], stepCount: 0, deferred: true, outcome, say };
  };
  const cancelled = (): LoopRun => stop("aborted", "Stopped before application; no changes were applied.");
  const ask = async (goal?: string): Promise<ReplyResult> => {
    if (aborted()) return { ok: false, outcome: "aborted", say: "Stopped before application; no changes were applied." };
    if (callCount >= maxCalls || now() - started > limitMs)
      return { ok: false, outcome: "budget", say: "Preparation budget exhausted; no changes were applied." };
    callCount++;
    const system = (deps.systemPrompt ?? buildLoopSystemPrompt)(snapshot, task.ask, deps.memory);
    try {
      const response = await deps.chat([
        { role: "system", content: `${system}\nPrepare one complete proposal of at most six allowed commands. Nothing is applied until preparation finishes. Use only the original session and existing target IDs. Reply as strict JSON with status, optional say/intent, commands, or plan entries {goal,commands?}. Command objects contain only command and args. Do not require observations of proposed changes.` },
        { role: "user", content: JSON.stringify({ ask: task.ask, mode: goal ? "compile" : callCount === 1 ? "plan" : "continue", goal, pendingCommandsNotApplied: pending }) },
      ]);
      if (aborted()) return { ok: false, outcome: "aborted", say: "Stopped before application; no changes were applied." };
      modelMs += response.ms ?? 0;
      const parsed = replySchema.safeParse(JSON.parse(response.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")));
      if (!parsed.success) return { ok: false, outcome: "need_user", say: "The complete proposal was malformed; no changes were applied." };
      return { ok: true, reply: parsed.data };
    } catch (error) {
      if (aborted()) return { ok: false, outcome: "aborted", say: "Stopped before application; no changes were applied." };
      if (error instanceof SyntaxError) return { ok: false, outcome: "need_user", say: "The complete proposal was not valid JSON; no changes were applied." };
      if (error instanceof Error) return { ok: false, outcome: "error", say: "Provider preparation failed; no changes were applied." };
      throw error;
    }
  };

  deps.onProgress?.({ kind: "phase", phase: "planning" });
  if (aborted()) return cancelled();
  let next = await ask();
  while (next.ok) {
    const reply = next.reply;
    if (reply.status === "need_user") return stop("need_user", "The proposal needs clarification; no changes were applied.");
    if (reply.commands && reply.plan)
      return stop("need_user", "The proposal duplicated top-level commands and a plan; no changes were applied.");
    if (reply.plan) {
      deps.onProgress?.({ kind: "plan", plan: reply.plan });
      for (const step of reply.plan) {
        let calls = step.commands;
        if (!calls) {
          const compiled = await ask(step.goal);
          if (!compiled.ok) return stop(compiled.outcome, compiled.say);
          if (compiled.reply.status === "need_user") return stop("need_user", "The proposal needs clarification; no changes were applied.");
          if (compiled.reply.plan) return stop("need_user", "A compiled step must contain concrete commands; no changes were applied.");
          calls = compiled.reply.commands;
        }
        if (!calls) return stop("need_user", "A planned step has no concrete commands; no changes were applied.");
        pending.push(...calls);
        if (pending.length > 6) return stop("need_user", "The proposal exceeds six commands; no changes were applied.");
      }
      break;
    }
    if (reply.commands) pending.push(...reply.commands);
    if (pending.length > 6) return stop("need_user", "The proposal exceeds six commands; no changes were applied.");
    if (reply.status === "done") break;
    if (!reply.commands) return stop("need_user", "The proposal is incomplete; no changes were applied.");
    next = await ask();
  }
  if (!next.ok) return stop(next.outcome, next.say);
  if (aborted()) return cancelled();
  if (now() - started > limitMs) return stop("budget", "Preparation budget exhausted; no changes were applied.");
  if (!pending.length) return stop("done", "No changes were applied.");
  const invalid = pending.map((call) => validateCommand(call.command, call.args ?? {})).find((reason) => reason !== null);
  const problem = invalid ?? deps.bounded?.validate(pending);
  if (problem) return stop("need_user", `No changes were applied: ${problem}.`);

  deps.onProgress?.({ kind: "phase", phase: "stepping" });
  deps.onProgress?.({ kind: "step-start", index: 0, goal: "Apply complete bounded proposal", commands: pending });
  if (aborted()) return cancelled();
  const applied = await deps.env.runBatch(`moshi task: ${task.ask.slice(0, 48)}`, pending);
  deps.onProgress?.({ kind: "step-result", index: 0, results: applied.results });
  const presentation = applied.execution ? executionPresentation(applied.execution, aborted())
    : { outcome: "error" as const, say: "The native execution disposition is unavailable; effects are unconfirmed." };
  deps.onProgress?.({ kind: "phase", phase: "finalizing" });
  return {
    finalSnapshot: applied.snapshot,
    transcript: [{ commands: pending, results: applied.results, invalidCount: 0, ms: modelMs }],
    stepCount: 1, deferred: false, ...presentation, execution: applied.execution,
  };
}
