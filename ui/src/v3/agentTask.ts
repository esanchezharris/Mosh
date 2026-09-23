import { useTaskStore, type TaskView } from "../agent/loop/taskStore";

// V3's read-only view of the agent task store (ui/src/agent/loop/taskStore.ts).
//
// While a Moshi loop task runs it keeps ONE native undo transaction open from its first
// command until the task ends (taskExec.ts), and Stop is only honoured between steps. Any
// edit the owner makes in that window is folded into Moshi's undo step, so a later ⌘Z
// would take the owner's work with it.
//
// A live task is only one of the two windows. A Moshi dock ask that runs through
// runAgentBatch (fast path, studio skills, section rework) holds a native batch while
// store.agentBusy is true and NO task is live. So an edit button gates on both. Call both
// hooks unconditionally (a `useA() || useB()` short-circuit would skip a hook and break
// React's hook order when a task starts):
//
//   const taskLive = useAgentTaskLive();
//   const agentBusy = useStore((s) => s.agentBusy);
//   const editLocked = taskLive || agentBusy;
//   <button disabled={editLocked} …>+ Drum beat</button>
//
// The Arrangement toolbar does this for all of its edit buttons (+ Audio track, + MIDI track,
// + Drum beat, + Chords, + MIDI clip). `+ Generate beat` (A19) should adopt the same gate.

/** True while an agent task is live (useTaskStore.current !== null). Re-renders on change. */
export const useAgentTaskLive = (): boolean => useTaskStore((s) => s.current !== null);

/** The same answer outside React (event handlers, guards). */
export const agentTaskLive = (): boolean => useTaskStore.getState().current !== null;

/** m:ss, never negative. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** "step i/N" (N = max(plan, steps), so a repair past the plan still reads sensibly), or
 *  "planning" before the first plan/step exists — never "step 0/0". */
export function taskProgress(task: Pick<TaskView, "plan" | "steps">): string {
  const n = Math.max(task.plan.length, task.steps.length);
  return n > 0 ? `step ${task.steps.length}/${n}` : "planning";
}
