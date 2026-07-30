import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requestSupervisorMock, runAgentBatchMock } = vi.hoisted(() => ({ requestSupervisorMock: vi.fn(), runAgentBatchMock: vi.fn() }));
vi.mock("../agent/capabilityRuntime", () => ({
  requestCapabilitySupervisor: requestSupervisorMock,
  executeDirectSafeCapabilities: vi.fn(),
  isDirectSafeCall: () => false,
  recordCapabilityToolResult: (telemetry: unknown) => telemetry,
  emitCapabilityTelemetry: vi.fn(),
}));
vi.mock("../agent/executor", () => ({ runAgentBatch: runAgentBatchMock, logAgentTurn: vi.fn(async () => {}) }));

import { AgentComposer } from "./AgentComposer";
import { useStore } from "../store";

const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;

describe("AgentComposer supervisor entry point", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    requestSupervisorMock.mockResolvedValue({ plan: { intent: "ACK_GOT_IT", say: "done" }, calls: [{ command: "create_track", args: { name: "Lead" } }], telemetry: { latencyMs: 1 } });
    runAgentBatchMock.mockResolvedValue({ entries: [{ ok: true }], applied: 1 });
    useStore.setState({ agentBusy: false, snapshot: null });
    act(() => { root.render(React.createElement(AgentComposer)); });
  });

  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("routes a non-direct ask through the host before the validated executor", async () => {
    const input = host.querySelector<HTMLInputElement>("[data-testid='agent-input']")!;
    valueSetter.call(input, "create a lead track");
    act(() => { input.dispatchEvent(new Event("input", { bubbles: true })); });
    const send = host.querySelector<HTMLButtonElement>("[data-testid='agent-send']")!;
    await act(async () => { send.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(requestSupervisorMock).toHaveBeenCalledWith("create a lead track", expect.any(Object));
    expect(runAgentBatchMock).toHaveBeenCalledWith("done", [{ command: "create_track", args: { name: "Lead" } }], expect.objectContaining({ source: "supervisor" }));
  });
});
