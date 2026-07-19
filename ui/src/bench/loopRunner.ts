// The Phase-B agentic loop as an AgentRunner — the drop-in the bench was built
// for: `agent-bench --runner loop` measures the SAME loop the app ships,
// through the same env seam as the single-shot baseline. LoopRun already
// extends AgentTaskRun, so this is a thin budget/chat adapter, not a re-wrap.

import { runAgentLoop, type ChatMessage } from "../agent/loop/loop";
import type { AgentRunner } from "../agent/loopSeam";

export type LoopChatFn = (messages: ChatMessage[]) => Promise<{ content: string; ms?: number }>;

export function makeLoopRunner(deps: { chat: LoopChatFn }): AgentRunner {
  return async (task, env, opts) =>
    runAgentLoop({ ask: task.ask }, { chat: deps.chat, env, budgets: { maxSteps: opts.maxSteps } });
}
