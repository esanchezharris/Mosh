// The full app-side loop integration, hermetic: runLoopTask → chatWithFallback
// (the explicit Vitest dev surface permits the deterministic loopBrainMock) → the
// loop FSM → the TASK-scoped executor → the dev mock backend. One ask becomes a
// real two-step task, the store view fills in, and ONE undo reverts everything.

import { describe, it, expect, beforeEach } from "vitest";
import { runLoopTask, agenticLoopOn } from "./runTask";
import { useTaskStore } from "./taskStore";
import { useStore } from "../../store";
import { __resetMockForTests } from "../../bridge.mock";
import type { Snapshot } from "../../types";

function snap(): Snapshot {
  const s = useStore.getState().snapshot;
  if (!s) throw new Error("no snapshot");
  return s;
}

const noopUi = { say: () => {}, utter: () => {} };

describe("runLoopTask — composer ask → multi-step task → one undo unit", () => {
  beforeEach(async () => {
    __resetMockForTests();
    // Start EMPTY: the dev seed already carries a "Drums" track, which would
    // make every drum assertion below vacuously true against the seed.
    await useStore.getState().exec("new_project", {});
    await useStore.getState().refresh();
    useTaskStore.setState({ current: null, last: null, history: [], drawerOpen: false, signal: null });
  });

  it("the lofi script runs two steps against the real mock and lands done", async () => {
    const utters: string[] = [];
    const run = await runLoopTask("build me a lofi sketch", { say: () => {}, utter: (i) => utters.push(i) });

    expect(run.outcome).toBe("done");
    expect(run.stepCount).toBe(2);
    expect(snap().session.tempo).toBe(80);                                  // step 1
    const drums = snap().tracks.find((t) => t.name === "Drums");
    expect(drums, "add_drum_pattern created its Drums track").toBeTruthy(); // step 2
    if (!drums) throw new Error("add_drum_pattern did not create its Drums track");
    const firstClip = drums.clips[0];
    if (!firstClip) throw new Error("add_drum_pattern did not create a clip");
    expect((firstClip.notes ?? []).length).toBeGreaterThanOrEqual(8);

    // beats only: ACK_WORKING at start, DONE at the end — no per-step spam
    expect(utters[0]).toBe("ACK_WORKING");
    expect(utters[utters.length - 1]).toBe("DONE");

    // the store view is renderable history now
    const st = useTaskStore.getState();
    expect(st.current).toBeNull();
    expect(st.last?.outcome).toBe("done");
    expect(st.last?.steps).toHaveLength(2);
    expect(st.last?.plan.map((p) => p.goal)).toEqual(["set a lazy tempo", "lay dusty drums"]);
    expect(st.history).toHaveLength(1);

    // ONE undo reverts the WHOLE task (tempo AND the drum track)
    const u = await useStore.getState().exec("undo");
    expect(u.ok).toBe(true);
    await useStore.getState().refresh();
    expect(snap().session.tempo).toBe(120);
    expect(snap().tracks.some((t) => t.name === "Drums")).toBe(false);
  });

  it("an unrecognized ask parks as need_user with zero session mutation", async () => {
    const before = JSON.stringify(snap());
    const run = await runLoopTask("do the thing", noopUi);

    expect(run.outcome).toBe("need_user");
    expect(run.deferred).toBe(true);
    expect(useTaskStore.getState().last?.outcome).toBe("need_user");
    await useStore.getState().refresh();
    expect(JSON.stringify(snap())).toBe(before);
  });

  it("agenticLoopOn stays off without the developer build flag", () => {
    expect(agenticLoopOn()).toBe(false);
  });
});
