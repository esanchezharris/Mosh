// W1.2 — proves runTask.ts wires the produce lane onto PRODUCE_CLOUD_PROVIDERS
// (openai [the claude-cli shim's slot] -> openrouter -> deepseek -> xai) and
// PRODUCE_CHAT_OPTIONS (maxTokens 8192 / timeoutMs 180_000), while the DOSAGE
// lane's chatWithFallback keeps calling brainChat(messages) with NO provider or
// options — byte-identical to before this seam existed.
//
// Mirrors runTaskMemory.test.ts's "spy on runAgentLoop's deps" pattern: the real
// loop FSM runs (importOriginal), but the test intercepts `deps.chat` — the closure
// runTask.ts builds (produceCloudChat or chatWithFallback) — so it can be invoked
// directly and its calls into brainChat inspected, without needing to drive a full
// multi-step task through the loop just to observe one provider-selection call.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { runAgentLoopSpy } = vi.hoisted(() => ({ runAgentLoopSpy: vi.fn() }));
vi.mock("./loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./loop")>();
  return {
    ...actual,
    runAgentLoop: async (task: { ask: string }, deps: Parameters<typeof actual.runAgentLoop>[1]) => {
      runAgentLoopSpy(deps);
      return actual.runAgentLoop(task, deps);
    },
  };
});

const { brainChatMock } = vi.hoisted(() => ({ brainChatMock: vi.fn() }));
vi.mock("../../bridge", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../bridge")>(),
  archivePair: vi.fn(async () => {}),
  brainChat: brainChatMock,
  demoBrainAvailable: () => false,
}));

import { runLoopTask } from "./runTask";
import { useTaskStore } from "./taskStore";
import { useStore } from "../../store";
import { useSettings } from "../../settings/store";
import { __resetMockForTests } from "../../bridge.mock";
import type { ChatMessage } from "./loop";

const noopUi = { say: () => {}, utter: () => {} };
const DONE_REPLY = { content: JSON.stringify({ status: "done", say: "ok" }) };
const PRODUCE_CHAT_OPTIONS = { maxTokens: 8192, timeoutMs: 180_000 };
const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

/** Drive runLoopTask once with a canned "done" reply just far enough to capture the
 *  `deps.chat` closure runTask.ts wired up — its own outcome is irrelevant here. */
async function captureLoopChat(ask: string): Promise<(m: ChatMessage[]) => Promise<{ content: string; ms?: number }>> {
  runAgentLoopSpy.mockClear();
  brainChatMock.mockReset();
  brainChatMock.mockResolvedValue(DONE_REPLY);
  await runLoopTask(ask, noopUi);
  expect(runAgentLoopSpy).toHaveBeenCalledTimes(1);
  const deps = runAgentLoopSpy.mock.calls[0]![0] as { chat: (m: ChatMessage[]) => Promise<{ content: string; ms?: number }> };
  return deps.chat;
}

describe("runLoopTask — produce lane provider order + ChatOptions (W1.2)", () => {
  beforeEach(async () => {
    __resetMockForTests();
    runAgentLoopSpy.mockReset();
    brainChatMock.mockReset();
    useSettings.getState().set("produceLane", false);
    await useStore.getState().exec("new_project", {});
    await useStore.getState().refresh();
    useTaskStore.setState({ current: null, last: null, history: [], drawerOpen: false, signal: null });
  });

  it("a produce ask (flag on) tries openai first, at 8192 tokens / 180s", async () => {
    useSettings.getState().set("produceLane", true);
    const chat = await captureLoopChat("produce a dark trap beat");

    brainChatMock.mockReset();
    brainChatMock.mockResolvedValue(DONE_REPLY);
    const r = await chat(messages);

    expect(r.content).toBe(DONE_REPLY.content);
    expect(brainChatMock).toHaveBeenCalledTimes(1);
    expect(brainChatMock).toHaveBeenNthCalledWith(1, messages, "openai", PRODUCE_CHAT_OPTIONS);
  });

  it("openai rejecting falls through to openrouter, then deepseek, then xai — same options each time", async () => {
    useSettings.getState().set("produceLane", true);
    const chat = await captureLoopChat("produce a dark trap beat");

    brainChatMock.mockReset();
    brainChatMock
      .mockRejectedValueOnce(new Error("shim unreachable"))
      .mockRejectedValueOnce(new Error("openrouter 429"))
      .mockResolvedValueOnce(DONE_REPLY);
    const r = await chat(messages);

    expect(r.content).toBe(DONE_REPLY.content);
    expect(brainChatMock).toHaveBeenCalledTimes(3);
    expect(brainChatMock.mock.calls[0]).toEqual([messages, "openai", PRODUCE_CHAT_OPTIONS]);
    expect(brainChatMock.mock.calls[1]).toEqual([messages, "openrouter", PRODUCE_CHAT_OPTIONS]);
    expect(brainChatMock.mock.calls[2]).toEqual([messages, "deepseek", PRODUCE_CHAT_OPTIONS]);

    // one more rejection would reach xai, the last provider in the order
    brainChatMock.mockReset();
    brainChatMock
      .mockRejectedValueOnce(new Error("shim unreachable"))
      .mockRejectedValueOnce(new Error("openrouter 429"))
      .mockRejectedValueOnce(new Error("deepseek down"))
      .mockResolvedValueOnce(DONE_REPLY);
    await chat(messages);
    expect(brainChatMock.mock.calls[3]).toEqual([messages, "xai", PRODUCE_CHAT_OPTIONS]);
  });

  it("a DOSAGE ask (flag off) calls brainChat with no provider/options — byte-identical guard", async () => {
    const chat = await captureLoopChat("rename track two to vocals");

    brainChatMock.mockReset();
    brainChatMock.mockResolvedValue(DONE_REPLY);
    const r = await chat(messages);

    expect(r.content).toBe(DONE_REPLY.content);
    expect(brainChatMock).toHaveBeenCalledTimes(1);
    expect(brainChatMock).toHaveBeenNthCalledWith(1, messages);
  });
});
