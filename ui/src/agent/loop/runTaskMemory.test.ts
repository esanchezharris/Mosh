// M2 — proves runTask.ts (the app-side loop glue) actually COMPUTES the memory
// section and passes it as LoopDeps.memory, closing the one link loop.test.ts
// (deps.memory -> every model call) and brainMemory.test.ts (brain.ts's identical
// hydrate+retrieveContext+flag pattern) don't individually cover. Wraps the REAL
// runAgentLoop (via importOriginal) so the rest of the task still runs for real
// against the dev mock backend — only deps.memory is intercepted for inspection.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { runAgentLoopSpy } = vi.hoisted(() => ({ runAgentLoopSpy: vi.fn() }));
vi.mock("./loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./loop")>();
  return {
    ...actual,
    runAgentLoop: async (task: { ask: string }, deps: Parameters<typeof actual.runAgentLoop>[1]) => {
      runAgentLoopSpy(deps.memory);
      return actual.runAgentLoop(task, deps);
    },
  };
});

import { runLoopTask } from "./runTask";
import { useTaskStore } from "./taskStore";
import { useStore } from "../../store";
import { useSettings } from "../../settings/store";
import { __resetMockForTests, mockExecute } from "../../bridge.mock";
import { __resetMemoryHydrationForTests } from "../memory/hydrate";

const noopUi = { say: () => {}, utter: () => {} };

describe("runLoopTask — M2 memory wiring", () => {
  beforeEach(async () => {
    __resetMockForTests();
    __resetMemoryHydrationForTests();
    runAgentLoopSpy.mockReset();
    useSettings.getState().set("agentMemory", true);
    await useStore.getState().exec("new_project", {});
    await useStore.getState().refresh();
    useTaskStore.setState({ current: null, last: null, history: [], drawerOpen: false, signal: null });
  });

  it("flag ON + a non-empty pool -> runAgentLoop receives a rendered memory string", async () => {
    // A PROJECT note (unscored — always included, no token-overlap dependency on the
    // task text) is the deterministic way to prove this without also depending on
    // retrieveContext's relevance ranking matching a particular ask.
    await mockExecute({
      command: "agent_memory_write",
      args: { scope: "project", item: "always keep the low end wide" },
    });

    await runLoopTask("build me a lofi sketch", noopUi);

    expect(runAgentLoopSpy).toHaveBeenCalledTimes(1);
    const memory = runAgentLoopSpy.mock.calls[0]![0] as string | undefined;
    expect(memory).toContain("Memory —");
    expect(memory).toContain("always keep the low end wide");
  });

  it("flag OFF -> runAgentLoop receives undefined even with a non-empty pool", async () => {
    await mockExecute({
      command: "agent_memory_write",
      args: { scope: "project", item: "always keep the low end wide" },
    });
    useSettings.getState().set("agentMemory", false);

    await runLoopTask("build me a lofi sketch", noopUi);

    expect(runAgentLoopSpy).toHaveBeenCalledTimes(1);
    expect(runAgentLoopSpy.mock.calls[0]![0]).toBeUndefined();
  });

  it("nothing ever written to agent memory -> runAgentLoop receives undefined (byte-identical to pre-M2)", async () => {
    await runLoopTask("build me a lofi sketch", noopUi);

    expect(runAgentLoopSpy).toHaveBeenCalledTimes(1);
    expect(runAgentLoopSpy.mock.calls[0]![0]).toBeUndefined();
  });
});
