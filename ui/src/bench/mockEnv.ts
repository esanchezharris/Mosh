// MoshAgentBench — the MOCK substrate AgentEnv. Executes through the REAL
// production executor path (runAgentBatch → validateCommand → screenDestructive
// → batch_begin/…/batch_end → store.exec → the dev mock), so the bench's mock
// runs exercise exactly the semantics the app ships — no parallel executor.
//
// runMockSetup mirrors --run-script's ${VAR} capture/substitute semantics so
// one task definition replays on both substrates. It bootstraps with
// new_project because a fresh HEADLESS engine starts empty, while the dev
// mock's reset state is the demo seed — without this, tasks like
// "midiNoteCount on Drums" would grade the demo session's pre-existing notes
// (the vacuous-pass class this repo has been bitten by before).

import { useStore } from "../store";
import { runAgentBatch } from "../agent/executor";
import type { AgentEnv, StepCommandResult } from "../agent/loopSeam";
import type { Cmd } from "./cases";

export async function runMockSetup(setup: readonly Cmd[]): Promise<Record<string, string>> {
  const { exec } = useStore.getState();
  const vars: Record<string, string> = {};
  const substitute = (v: unknown): unknown =>
    typeof v === "string" ? v.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, k: string) => vars[k] ?? `\${${k}}`) : v;

  const boot = await exec("new_project", {});
  if (!boot.ok) throw new Error(`mock setup: new_project failed: ${boot.error}`);

  for (const c of setup) {
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c.args ?? {})) args[k] = substitute(v);
    const res = await exec(c.command, args);
    if (!res.ok) throw new Error(`mock setup: ${c.command} failed: ${res.error}`);
    if (c.capture) {
      const data = (res.data ?? {}) as Record<string, unknown>;
      for (const [varName, field] of Object.entries(c.capture)) {
        const val = data[field];
        if (val === undefined || val === null)
          throw new Error(`mock setup: ${c.command} returned no "${field}" to capture as ${varName}`);
        vars[varName] = String(val);
      }
    }
  }
  await useStore.getState().refresh();
  return vars;
}

export function makeMockEnv(): AgentEnv {
  return {
    async getSnapshot() {
      await useStore.getState().refresh();
      const s = useStore.getState().snapshot;
      if (!s) throw new Error("mock env: store has no snapshot");
      return s;
    },
    async runBatch(label, calls) {
      const cs = await runAgentBatch(label, calls, { source: "agent-bench" });
      await useStore.getState().refresh();
      const s = useStore.getState().snapshot;
      if (!s) throw new Error("mock env: store has no snapshot after batch");
      const results: StepCommandResult[] = cs.entries.map((e) => ({ command: e.command, ok: e.ok, error: e.error }));
      return { results, snapshot: s };
    },
  };
}
