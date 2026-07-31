import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  cockpitRuntimeMock,
  createVoiceInputMock,
  realtimeControllerMock,
  requestSupervisorMock,
  runAgentBatchMock,
  voiceCallbacks,
} = vi.hoisted(() => {
  const callbacks: { current: { onFinal?: (text: string) => void } | null } = { current: null };
  return {
    cockpitRuntimeMock: {
      client: { realtimeSecret: vi.fn(async () => "ek_test") },
      createFromText: vi.fn(),
      createReport: vi.fn(),
      getSnapshot: vi.fn(() => ({ status: "active" })),
    },
    createVoiceInputMock: vi.fn((cb: { onFinal?: (text: string) => void }) => {
      callbacks.current = cb;
      return { start: vi.fn(), stop: vi.fn(), abort: vi.fn(), listening: false };
    }),
    realtimeControllerMock: {
      connect: vi.fn(async () => { throw new Error("realtime failed"); }),
      dispose: vi.fn(async () => undefined),
      press: vi.fn(),
      release: vi.fn(),
      cancel: vi.fn(),
      setPlaybackActive: vi.fn(),
    },
    requestSupervisorMock: vi.fn(),
    runAgentBatchMock: vi.fn(),
    voiceCallbacks: callbacks,
  };
});
vi.mock("../agent/capabilityRuntime", () => ({
  requestCapabilitySupervisor: requestSupervisorMock,
  executeDirectSafeCapabilities: vi.fn(),
  isDirectSafeCall: () => false,
  recordCapabilityToolResult: (telemetry: unknown) => telemetry,
  emitCapabilityTelemetry: vi.fn(),
}));
vi.mock("../agent/executor", () => ({ runAgentBatch: runAgentBatchMock, logAgentTurn: vi.fn(async () => {}) }));
vi.mock("../agent/ownerCockpitRuntime", () => ({
  ownerCockpitRuntime: cockpitRuntimeMock,
  useOwnerCockpit: () => ({
    status: "active",
    retainTranscript: false,
    disclosure: null,
    reports: [],
    pendingNotes: 0,
    urgentMessage: null,
    error: null,
    lastEvent: null,
  }),
}));
vi.mock("../agent/openAIRealtime", () => ({
  createOpenAIRealtimeController: () => realtimeControllerMock,
}));
vi.mock("../agent/voiceInput", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent/voiceInput")>();
  return {
    ...actual,
    createVoiceInput: createVoiceInputMock,
    isVoiceSupported: () => true,
  };
});

import { AgentComposer } from "./AgentComposer";
import { useStore } from "../store";
import { useSettings } from "../settings/store";

const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;

describe("AgentComposer supervisor entry point", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.clearAllMocks();
    voiceCallbacks.current = null;
    requestSupervisorMock.mockResolvedValue({ plan: { intent: "ACK_GOT_IT", say: "done" }, calls: [{ command: "create_track", args: { name: "Lead" } }], telemetry: { latencyMs: 1 } });
    runAgentBatchMock.mockResolvedValue({ entries: [{ ok: true }], applied: 1 });
    useStore.setState({ agentBusy: false, snapshot: null });
    useSettings.getState().set("ownerCockpit", true);
    act(() => { root.render(React.createElement(AgentComposer)); });
  });

  afterEach(() => {
    act(() => root.unmount());
    useSettings.getState().set("ownerCockpit", false);
    host.remove();
  });

  it("routes a non-direct ask through the host before the validated executor", async () => {
    const input = host.querySelector<HTMLInputElement>("[data-testid='agent-input']")!;
    valueSetter.call(input, "create a lead track");
    act(() => { input.dispatchEvent(new Event("input", { bubbles: true })); });
    const send = host.querySelector<HTMLButtonElement>("[data-testid='agent-send']")!;
    await act(async () => { send.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(requestSupervisorMock).toHaveBeenCalledWith("create a lead track", expect.any(Object));
    expect(runAgentBatchMock).toHaveBeenCalledWith("done", [{ command: "create_track", args: { name: "Lead" } }], expect.objectContaining({ source: "supervisor" }));
  });

  it("never sends a complex Apple fallback transcript containing a safe keyword to the supervisor", async () => {
    const mic = host.querySelector<HTMLButtonElement>("[data-testid='agent-mic']")!;
    await act(async () => {
      mic.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      await Promise.resolve();
    });
    expect(createVoiceInputMock).toHaveBeenCalledOnce();

    await act(async () => {
      voiceCallbacks.current?.onFinal?.("stop playback and rebuild the chorus around my vocal");
      await Promise.resolve();
    });

    expect(requestSupervisorMock).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Realtime unavailable — type complex requests.");
  });
});
