// Multi-turn driving for MoshAgentBench: run a task's user turns in order and
// stitch them into ONE AgentTaskRun that scoreTask can grade.
//
// Lives here rather than in scripts/agentBench.mts so vitest can drive it with a
// scripted brain and the dev mock env — the harness itself is then covered with
// zero API calls, which is the only way a conversational bug gets caught before
// it costs a live sweep.
//
// The two properties worth stating plainly, because both are load-bearing:
//
// 1. A task with no `followUps` is a ONE-TURN conversation: exactly one runner
//    invocation, `history` empty. That call is identical to the pre-conversation
//    one, which is what keeps every scoreboard recorded before this existed
//    comparable to every scoreboard recorded after it.
//
// 2. The env is NOT reset between turns. It accumulates the command script
//    (cumulative-prefix replay), so on turn N the agent observes a session that
//    genuinely contains what it did on turns 0..N-1. Without that, "undo that"
//    and "no, the other one" would be unanswerable and the whole category would
//    be measuring nothing.

import type { AgentEnv, AgentRunner, AgentTaskRun, ConversationMessage, StepRecord } from "../agent/loopSeam";

export type ConversationTask = {
  readonly ask: string;
  readonly followUps?: readonly { readonly say: string }[];
  readonly maxSteps?: number;
};

/** The turns a task will drive, in order. `ask` is always turn 0. */
export const utterancesOf = (task: ConversationTask): string[] =>
  [task.ask, ...(task.followUps ?? []).map((f) => f.say)];

/** What the model produced this turn, replayed to it next turn.
 *
 *  The commands go in alongside the words on purpose: a turn that acted and then
 *  gets "undo that" has to know WHAT it did, and re-deriving that from the
 *  snapshot means guessing which of the visible state it was responsible for. */
export function assistantTurnMessage(run: AgentTaskRun): ConversationMessage {
  const commands = run.transcript.flatMap((s) => [...s.commands]);
  const say = run.transcript.map((s) => s.say).filter(Boolean).join(" ");
  return {
    role: "assistant",
    content: JSON.stringify({ say: say || undefined, commands: commands.length ? commands : undefined }),
  };
}

export async function runConversation(
  task: ConversationTask,
  runner: AgentRunner,
  env: AgentEnv,
  opts: { readonly maxSteps: number },
): Promise<AgentTaskRun> {
  const utterances = utterancesOf(task);
  if (utterances.length === 0) throw new Error("conversation task has no utterances");

  const history: ConversationMessage[] = [];
  const transcript: StepRecord[] = [];
  let last: AgentTaskRun | undefined;

  for (let turn = 0; turn < utterances.length; turn++) {
    const ask = utterances[turn];
    const run = await runner({ ask, history: [...history] }, env, opts);
    last = run;
    // Stamp the turn so turn-addressed goals (askedAtTurn/actedAtTurn/…) can find
    // their steps. Runners never set this; only the conversation driver knows it.
    for (const s of run.transcript) transcript.push({ ...s, turn });

    // A broken brain ends the conversation. Replaying further user turns into a
    // failed runner would record noise as behaviour.
    if (run.error) break;
    if (turn < utterances.length - 1) {
      history.push({ role: "user", content: ask });
      history.push(assistantTurnMessage(run));
    }
  }

  return {
    finalSnapshot: last!.finalSnapshot,
    transcript,
    stepCount: transcript.length,
    // Deferred across the WHOLE conversation. A task that asks on turn 0 and acts
    // on turn 1 is NOT a deferral — rewarding that is the point of the category.
    deferred: transcript.every((s) => s.commands.length === 0),
    error: last!.error,
  };
}
