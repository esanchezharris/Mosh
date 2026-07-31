import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  cockpitRuntimeMock,
  createVoiceInputMock,
  realtimeControllerMock,
  requestSupervisorMock,
  runAgentBatchMock,
  runLoopTaskMock,
  cockpitStatus,
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
      connect: vi.fn<() => Promise<void>>(async () => { throw new Error("realtime failed"); }),
      dispose: vi.fn(async () => undefined),
      inputMode: "webrtc-microphone" as const,
      submitTranscript: vi.fn(),
      press: vi.fn(),
      release: vi.fn(),
      cancel: vi.fn(),
      setPlaybackActive: vi.fn(),
    },
    requestSupervisorMock: vi.fn(),
    runAgentBatchMock: vi.fn(),
    runLoopTaskMock: vi.fn(async () => ({ outcome: "done" })),
    cockpitStatus: { current: "active" as "active" | "inactive" },
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
vi.mock("../agent/loop/runTask", () => ({
  loopAllowed: () => true,
  runLoopTask: runLoopTaskMock,
}));
vi.mock("../agent/ownerCockpitRuntime", () => ({
  ownerCockpitRuntime: cockpitRuntimeMock,
  useOwnerCockpit: () => ({
    status: cockpitStatus.current,
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

const defaultStopRecord = useStore.getState().stopRecord;
const valueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value",
)?.set;
if (!valueSetter) throw new Error("HTMLInputElement value setter is unavailable");

describe("AgentComposer supervisor entry point", () => {
  let host: HTMLDivElement;
  let root: Root;

  function requiredElement<T extends Element>(selector: string): T {
    const element = host.querySelector<T>(selector);
    if (!element) throw new Error(`Missing required test element: ${selector}`);
    return element;
  }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.clearAllMocks();
    voiceCallbacks.current = null;
    requestSupervisorMock.mockResolvedValue({ plan: { intent: "ACK_GOT_IT", say: "done" }, calls: [{ command: "create_track", args: { name: "Lead" } }], telemetry: { latencyMs: 1 } });
    runAgentBatchMock.mockResolvedValue({ entries: [{ ok: true }], applied: 1 });
    const transport = useStore.getState().transport;
    useStore.setState({
      agentBusy: false,
      snapshot: null,
      stopRecord: defaultStopRecord,
      transport: { ...transport, recording: false },
    });
    cockpitStatus.current = "active";
    useSettings.getState().set("ownerCockpit", true);
    act(() => { root.render(React.createElement(AgentComposer)); });
  });

  afterEach(() => {
    act(() => root.unmount());
    useSettings.getState().set("ownerCockpit", false);
    host.remove();
  });

  it("routes a non-direct ask through the host before the validated executor", async () => {
    const input = requiredElement<HTMLInputElement>("[data-testid='agent-input']");
    valueSetter.call(input, "create a lead track");
    act(() => { input.dispatchEvent(new Event("input", { bubbles: true })); });
    const send = requiredElement<HTMLButtonElement>("[data-testid='agent-send']");
    await act(async () => { send.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(requestSupervisorMock).toHaveBeenCalledWith("create a lead track", expect.any(Object));
    expect(runAgentBatchMock).toHaveBeenCalledWith("done", [{ command: "create_track", args: { name: "Lead" } }], expect.objectContaining({ source: "supervisor" }));
  });

  it("routes the same complex ask exclusively through the flag-selected MoshOps executor seam", async () => {
    const ask = "build me a lofi sketch";
    const input = requiredElement<HTMLInputElement>("[data-testid='agent-input']");
    const send = requiredElement<HTMLButtonElement>("[data-testid='agent-send']");
    const submit = async () => {
      valueSetter.call(input, ask);
      act(() => { input.dispatchEvent(new Event("input", { bubbles: true })); });
      await act(async () => { send.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    };

    await act(async () => { useSettings.getState().set("ownerCockpit", false); });
    await submit();

    expect(runLoopTaskMock).toHaveBeenCalledWith(ask, expect.any(Object));
    expect(requestSupervisorMock).not.toHaveBeenCalled();
    expect(runAgentBatchMock).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await act(async () => { useSettings.getState().set("ownerCockpit", true); });
    await submit();

    expect(requestSupervisorMock).toHaveBeenCalledWith(ask, expect.any(Object));
    expect(runLoopTaskMock).not.toHaveBeenCalled();
    expect(runAgentBatchMock).toHaveBeenCalledWith(
      "done",
      [{ command: "create_track", args: { name: "Lead" } }],
      expect.objectContaining({ utterance: ask, source: "supervisor" }),
    );
  });

  it("never sends a complex Apple fallback transcript containing a safe keyword to the supervisor", async () => {
    const mic = requiredElement<HTMLButtonElement>("[data-testid='agent-mic']");
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

  it("returns an explicit start-required result without invoking the hosted supervisor", async () => {
    cockpitStatus.current = "inactive";
    await act(async () => { useSettings.getState().set("ownerCockpit", true); });
    act(() => { root.render(React.createElement(AgentComposer)); });
    const input = requiredElement<HTMLInputElement>("[data-testid='agent-input']");
    valueSetter.call(input, "build a bridge");
    act(() => { input.dispatchEvent(new Event("input", { bubbles: true })); });

    await act(async () => {
      requiredElement<HTMLButtonElement>("[data-testid='agent-send']")
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(requestSupervisorMock).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Start the owner playtest before using the hosted supervisor.");
  });

  it.each([
    { cockpitEnabled: false, status: "inactive" as const },
    { cockpitEnabled: true, status: "inactive" as const },
  ])("preserves legacy record-to-review PTT while recording for $cockpitEnabled/$status", async ({
    cockpitEnabled,
    status,
  }) => {
    cockpitStatus.current = status;
    await act(async () => { useSettings.getState().set("ownerCockpit", cockpitEnabled); });
    const stopRecord = vi.fn(async () => undefined);
    const transport = useStore.getState().transport;
    act(() => {
      useStore.setState({
        stopRecord,
        transport: { ...transport, recording: true },
      });
    });
    act(() => { root.render(React.createElement(AgentComposer)); });

    await act(async () => {
      requiredElement<HTMLButtonElement>("[data-testid='agent-mic']")
        .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });

    expect(stopRecord).toHaveBeenCalledOnce();
    expect(createVoiceInputMock).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain("Stop recording before talking to Moshi.");
  });

  it("refuses cockpit Realtime PTT while an active owner playtest is recording", async () => {
    const transport = useStore.getState().transport;
    act(() => { useStore.setState({ transport: { ...transport, recording: true } }); });

    await act(async () => {
      requiredElement<HTMLButtonElement>("[data-testid='agent-mic']")
        .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });

    expect(createVoiceInputMock).not.toHaveBeenCalled();
    expect(realtimeControllerMock.connect).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Stop recording before talking to Moshi.");
  });

  it("supports assistive click-to-toggle Realtime PTT on the native accessibility path", async () => {
    realtimeControllerMock.connect.mockResolvedValueOnce(undefined);
    realtimeControllerMock.press.mockResolvedValueOnce({ ok: true });
    const mic = requiredElement<HTMLButtonElement>("[data-testid='agent-mic']");

    await act(async () => {
      mic.click();
      await Promise.resolve();
    });

    expect(mic.disabled).toBe(false);
    expect(realtimeControllerMock.connect).toHaveBeenCalledOnce();
    expect(realtimeControllerMock.press).toHaveBeenCalledWith({ recording: false });
    expect(createVoiceInputMock).not.toHaveBeenCalled();
    expect(mic.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      mic.click();
      await Promise.resolve();
    });

    expect(realtimeControllerMock.release).toHaveBeenCalledOnce();
    expect(mic.getAttribute("aria-pressed")).toBe("false");
  });
});
