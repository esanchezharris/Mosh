import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMockForTests } from "../../bridge.mock";
import { useStore } from "../../store";
import type { Snapshot } from "../../types";
import { useTaskStore } from "./taskStore";

const { brainChatMock } = vi.hoisted(() => ({
  brainChatMock: vi.fn(),
}));

vi.mock("../../bridge", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../bridge")>(),
  archivePair: vi.fn(async () => {}),
  brainChat: brainChatMock,
  demoBrainAvailable: () => false,
}));

import { runLoopTask } from "./runTask";

function snapshot(): Snapshot {
  const value = useStore.getState().snapshot;
  if (!value) throw new Error("no snapshot");
  return value;
}

describe("runLoopTask provider failures", () => {
  beforeEach(async () => {
    brainChatMock.mockReset();
    __resetMockForTests();
    await useStore.getState().exec("new_project", {});
    await useStore.getState().refresh();
    useTaskStore.setState({ current: null, last: null, history: [], drawerOpen: false, signal: null });
  });

  it("fails closed without demo commands on the production surface", async () => {
    brainChatMock.mockRejectedValue(new Error("private upstream detail"));
    const before = JSON.stringify(snapshot());
    const says: Array<string | null> = [];
    const utters: string[] = [];

    const run = await runLoopTask("build me a lofi sketch", {
      say: (text) => says.push(text),
      utter: (intent) => utters.push(intent),
    });

    await useStore.getState().refresh();
    expect(run.outcome).toBe("unavailable");
    expect(run.stepCount).toBe(0);
    expect(JSON.stringify(snapshot())).toBe(before);
    expect(says.at(-1)).toBe("can't reach my brain — check setup and try again");
    expect(utters.at(-1)).toBe("UHOH");
  });
});
