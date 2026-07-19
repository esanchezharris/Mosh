// The app-side glue for an agentic task: composer text in → the loop runs over
// the TASK-scoped executor (one undo unit), progress streams into the task
// store (the drawer renders it), Moshi utters only at the beats (ACK_WORKING on
// start, DONE/HUH/UHOH at the end — no per-step creature spam), and the brain
// transport degrades to the deterministic loop mock when the proxy is
// unreachable (preview/e2e), exactly like the single-shot brain does.
//
// Loop tasks deliberately do NOT set agentChangeSet — the drawer carries the
// per-step detail, so the ChangeToast stays quiet for them by construction.

import { brainChat } from "../../bridge";
import { useSettings } from "../../settings/store";
import { runAgentLoop, type ChatMessage, type LoopRun } from "./loop";
import { createTaskExecutor, undoAgentTask } from "./taskExec";
import { mockLoopChat } from "./loopBrainMock";
import { useTaskStore } from "./taskStore";

export const agenticLoopOn = (): boolean => useSettings.getState().get("agenticLoop") === true;

export type TaskUi = {
  say(text: string | null): void;
  utter(intent: string, say?: string): void;
};

const END_UTTER: Record<LoopRun["outcome"], { intent: string; fallback?: string }> = {
  done: { intent: "DONE" },
  need_user: { intent: "HUH" },
  budget: { intent: "UHOH", fallback: "ran out of road — want me to keep going?" },
  error: { intent: "UHOH", fallback: "hmm — that broke partway" },
  aborted: { intent: "IDLE_MURMUR", fallback: "stopped — kept what's done" },
};

async function chatWithFallback(messages: ChatMessage[]): Promise<{ content: string; ms?: number }> {
  try {
    return await brainChat(messages);
  } catch {
    return mockLoopChat(messages); // proxy unreachable → the deterministic demo loop
  }
}

/** Run one agentic task end-to-end. Resolves when the task finishes (any outcome). */
export async function runLoopTask(text: string, ui: TaskUi): Promise<LoopRun> {
  const store = useTaskStore.getState();
  const signal = store.begin(text);
  ui.utter("ACK_WORKING");

  const exec = createTaskExecutor(text.slice(0, 48), { utterance: text, source: "agent_loop" });
  let run: LoopRun;
  try {
    run = await runAgentLoop({ ask: text }, {
      chat: chatWithFallback,
      env: exec.env,
      signal,
      onProgress: (ev) => useTaskStore.getState().progress(ev),
    });
  } finally {
    await exec.close(); // the task's undo transaction closes on EVERY exit path
  }

  useTaskStore.getState().finish(run);
  const end = END_UTTER[run.outcome];
  const sayText = run.say ?? end.fallback;
  ui.say(sayText ?? null);
  ui.utter(end.intent, sayText);
  return run;
}

export { undoAgentTask };
