// View-state for the agent drawer — a THIN zustand slice (the shellState
// idiom): the loop's progress events reduce into a renderable task view, the
// Stop button flips the shared abort signal, and finished tasks accumulate in
// an in-memory history behind the AgentHistorySink seam (the memory lane plugs
// persistence in there later — no storage here).

import { create } from "zustand";
import type { AgentCommandCall } from "../destructiveScreen";
import type { StepCommandResult } from "../loopSeam";
import type { LoopOutcome, LoopProgressEvent, LoopRun } from "./loop";

export type StepView = {
  goal?: string;
  commands: readonly AgentCommandCall[];
  results: readonly StepCommandResult[];
  running: boolean;
};

export type TaskView = {
  ask: string;
  phase: "planning" | "stepping" | "repairing" | "finalizing";
  plan: readonly { goal: string }[];
  steps: StepView[];
  say?: string;
  outcome?: LoopOutcome;
  startedAt: number;
  endedAt?: number;
};

/** Where finished tasks go — M2 plugs the per-project sidecar in here. */
export type AgentHistorySink = { append(task: TaskView): void };

interface TaskState {
  current: TaskView | null;
  /** The most recent finished task (the drawer's collapsed-recall view). */
  last: TaskView | null;
  history: TaskView[];
  drawerOpen: boolean;
  /** The live abort signal the loop polls; Stop flips it. */
  signal: { aborted: boolean } | null;
  sink: AgentHistorySink | null;

  begin(ask: string): { aborted: boolean };
  progress(ev: LoopProgressEvent): void;
  finish(run: LoopRun): void;
  requestStop(): void;
  setDrawerOpen(b: boolean): void;
  setSink(sink: AgentHistorySink | null): void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  current: null,
  last: null,
  history: [],
  drawerOpen: false,
  signal: null,
  sink: null,

  begin(ask) {
    const signal = { aborted: false };
    set({
      current: { ask, phase: "planning", plan: [], steps: [], startedAt: Date.now() },
      signal,
      drawerOpen: true,
    });
    return signal;
  },

  progress(ev) {
    const cur = get().current;
    if (!cur) return;
    if (ev.kind === "phase") {
      set({ current: { ...cur, phase: ev.phase } });
    } else if (ev.kind === "plan") {
      set({ current: { ...cur, plan: ev.plan.map((p) => ({ goal: p.goal })), say: ev.say ?? cur.say } });
    } else if (ev.kind === "step-start") {
      const steps = [...cur.steps];
      steps[ev.index] = { goal: ev.goal, commands: ev.commands, results: [], running: true };
      set({ current: { ...cur, phase: "stepping", steps } });
    } else if (ev.kind === "step-result") {
      const steps = [...cur.steps];
      const s = steps[ev.index];
      if (s) steps[ev.index] = { ...s, results: ev.results, running: false };
      set({ current: { ...cur, steps } });
    }
  },

  finish(run) {
    const cur = get().current;
    if (!cur) return;
    const done: TaskView = { ...cur, phase: "finalizing", outcome: run.outcome, say: run.say ?? cur.say, endedAt: Date.now() };
    get().sink?.append(done);
    set((s) => ({ current: null, last: done, history: [...s.history, done], signal: null }));
  },

  requestStop() {
    const sig = get().signal;
    if (sig) sig.aborted = true;
  },

  setDrawerOpen(b) { set({ drawerOpen: b }); },
  setSink(sink) { set({ sink }); },
}));
