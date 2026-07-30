import { describe, expect, it, vi } from "vitest";

const { brainChatMock, demoBrainAvailableMock } = vi.hoisted(() => ({
  brainChatMock: vi.fn(),
  demoBrainAvailableMock: vi.fn(),
}));
vi.mock("../../bridge", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../bridge")>(),
  archivePair: vi.fn(async () => {}),
  brainChat: brainChatMock,
  demoBrainAvailable: demoBrainAvailableMock,
}));

import { chatWithFallback } from "./runTask";
import { runLoopTask } from "./runTask";
import { __resetMockForTests } from "../../bridge.mock";
import { useStore } from "../../store";
import { useTaskStore } from "./taskStore";

describe("loop brain failure posture", () => {
  it("propagates a production provider failure instead of substituting the demo loop", async () => {
    demoBrainAvailableMock.mockReturnValue(false);
    brainChatMock.mockRejectedValue(new Error("unavailable"));

    await expect(chatWithFallback([{ role: "user", content: "make a beat" }])).rejects.toThrow("brain unavailable");
  });

  it("surfaces unavailable through the completed task and UI utterance", async () => {
    __resetMockForTests();
    await useStore.getState().exec("new_project", {});
    await useStore.getState().refresh();
    useTaskStore.setState({ current: null, last: null, history: [], drawerOpen: false, signal: null });
    demoBrainAvailableMock.mockReturnValue(false);
    brainChatMock.mockRejectedValue(new Error("unavailable"));
    const utterances: string[] = [];

    const run = await runLoopTask("build a beat", { say: () => {}, utter: (intent, say) => utterances.push(`${intent}:${say ?? ""}`) });

    expect(run.outcome).toBe("unavailable");
    expect(utterances.at(-1)).toBe("UHOH:brain unavailable");
    expect(useTaskStore.getState().last?.outcome).toBe("unavailable");
  });
});
