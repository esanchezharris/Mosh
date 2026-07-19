// The app-side glue for an agentic task: composer text in → the loop runs over
// the TASK-scoped executor (one undo unit), progress streams into the task
// store (the drawer renders it), Moshi utters only at the beats (ACK_WORKING on
// start, DONE/HUH/UHOH at the end — no per-step creature spam), and the brain
// transport degrades to the deterministic loop mock when the proxy is
// unreachable (preview/e2e), exactly like the single-shot brain does.
//
// Loop tasks deliberately do NOT set agentChangeSet — the drawer carries the
// per-step detail, so the ChangeToast stays quiet for them by construction.
//
// M2 (Phase-B memory lane, flag `agentMemory`): the memory section is computed ONCE
// here, before the loop starts (loop.ts's FSM is pure/deps-injected — it never calls
// the bridge itself), and passed through LoopDeps.memory so every step's prompt
// carries the SAME section (hydration/ranking is a one-time task cost, never a
// per-step one).
//
// M3: the memory section ALSO carries the remember_preference pseudo-command's
// serve-time doc (memory/rememberPreference.ts) whenever the flag is on, regardless
// of pool content — see brain.ts's memorySectionFor for why (a fresh install must
// still learn the tool exists). `memory` is undefined only when the flag itself is
// off, so it's the ONLY case where every step's prompt stays byte-identical to the
// pre-M2 shape.

import { archivePair, brainChat } from "../../bridge";
import { useSettings } from "../../settings/store";
import { useStore } from "../../store";
import { runAgentLoop, type ChatMessage, type LoopRun } from "./loop";
import { createTaskExecutor, undoAgentTask } from "./taskExec";
import { mockLoopChat } from "./loopBrainMock";
import { useTaskStore } from "./taskStore";
import { ensureMemoryHydrated, poolsNonEmpty } from "../memory/hydrate";
import { retrieveContext } from "../memory/retrieveContext";
import { rememberPreferenceToolDoc } from "../memory/rememberPreference";

export const agenticLoopOn = (): boolean => useSettings.getState().get("agenticLoop") === true;
const memoryOn = (): boolean => useSettings.getState().get("agentMemory") !== false;

/** Mirrors brain.ts's memorySectionFor — same flag, same hydrate+retrieveContext+
 *  tool-doc pairing. Kept as its own function (not shared with brain.ts) since the
 *  two call sites differ in WHEN they call it: brain.ts per turn, this one ONCE per
 *  task before the loop starts. Returns undefined (not "") only when the flag is
 *  off — LoopDeps.memory is itself optional, and buildLoopSystemPrompt's own
 *  omitted/undefined contract is what keeps that path byte-identical when off. */
async function memorySectionFor(query: string): Promise<string | undefined> {
  if (!memoryOn()) return undefined;
  const pools = await ensureMemoryHydrated();
  const retrieved = poolsNonEmpty(pools) ? retrieveContext(query, pools) : "";
  return [retrieved, rememberPreferenceToolDoc()].filter(Boolean).join("\n\n");
}

/** The loop runs only when the flag is on AND we're not in a multiplayer
 *  session (v1: a long-lived open batch vs the MP lock table is unplaytested —
 *  gate it off; the legacy single-shot path stays available in MP). */
export const loopAllowed = (): boolean => agenticLoopOn() && !useStore.getState().mp.active;

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

  const exec = createTaskExecutor(text.slice(0, 48), { utterance: text, source: "agent_loop" }, { signal });
  const memory = await memorySectionFor(text);
  let run: LoopRun;
  try {
    run = await runAgentLoop({ ask: text }, {
      chat: chatWithFallback,
      env: exec.env,
      signal,
      onProgress: (ev) => useTaskStore.getState().progress(ev),
      memory,
    });
  } finally {
    await exec.close(); // the task's undo transaction closes on EVERY exit path
  }

  useTaskStore.getState().finish(run);

  // Archive the task transcript for the future LOOP dataset lane — a NEW,
  // versioned surface (source-tagged; the multi-step reply contract must never
  // fold into the single-shot SFT mixes). Best-effort, no-op outside native.
  void archivePair({
    source: "agent-loop",
    v: 1,
    utterance: text,
    outcome: run.outcome,
    steps: run.transcript.map((s) => ({
      commands: s.commands,
      results: s.results.map((r) => ({ command: r.command, ok: r.ok, error: r.error })),
    })),
  }).catch(() => { /* archival must never affect the task */ });

  const end = END_UTTER[run.outcome];
  const sayText = run.say ?? end.fallback;
  ui.say(sayText ?? null);
  ui.utter(end.intent, sayText);
  return run;
}

export { undoAgentTask };
