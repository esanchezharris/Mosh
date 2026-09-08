import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMockForTests, mockSnapshot } from "../bridge.mock";
import type { Snapshot } from "../types";
import { nativeRequest, readAgentContext } from "../agent/loop/nativeTask";
import type { NativeExecution } from "../agent/loop/nativeTask";
import { useProducerRack } from "../agent/loop/producerRack";
import { useTaskStore } from "../agent/loop/taskStore";
import { ProducerRackSetup } from "./ProducerRackSetup";

vi.mock("../agent/loop/nativeTask", () => ({ readAgentContext: vi.fn(), nativeRequest: vi.fn() }));

const prepared: NativeExecution = { requestId: "discovered-after-restart", projectId: "unit-project", status: "prepared", appliedCount: 0 };

describe("ProducerRackSetup recovery UI (native boundary mocked)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    __resetMockForTests();
    useProducerRack.getState().setRack(null);
    useTaskStore.setState({ current: null, last: null, history: [], signal: null });
    const snapshot = await mockSnapshot<Snapshot>();
    vi.mocked(readAgentContext).mockResolvedValue({ projectId: "unit-project", epoch: "unit-epoch", revision: 1, snapshot, requests: [prepared] });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(React.createElement(ProducerRackSetup)));
    const details = host.querySelector("details");
    if (!details) throw new TypeError("Producer setup did not render");
    details.open = true;
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function click(testId: string) {
    const button = host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (!button) throw new TypeError(`Button missing: ${testId}`);
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
  }

  function select(requestId: string) {
    const input = host.querySelector<HTMLSelectElement>('[data-testid="producer-request-select"]');
    if (!input) throw new TypeError("Recorded-request selector missing");
    act(() => { input.value = requestId; input.dispatchEvent(new Event("change", { bubbles: true })); });
  }

  it("discovers an unknown prepared request ID and cancels it through the actual controls", async () => {
    vi.mocked(nativeRequest).mockResolvedValueOnce(prepared).mockResolvedValueOnce({ ...prepared, status: "cancelled" });
    expect(host.querySelector<HTMLInputElement>('[data-testid="producer-request-id"]')?.value).toBe("");

    await click("producer-request-discover");
    expect(host.querySelector('[data-testid="producer-request-select"]')?.textContent).toContain(prepared.requestId);
    expect(nativeRequest).not.toHaveBeenCalled();
    select(prepared.requestId);
    await click("producer-request-lookup");
    expect(host.querySelector('[data-testid="producer-request-status"]')?.textContent).toBe("prepared · 0 recorded applied command(s)");
    await click("producer-request-resolve");

    expect(nativeRequest).toHaveBeenNthCalledWith(1, "get_agent_request", { projectId: "unit-project", requestId: prepared.requestId });
    expect(nativeRequest).toHaveBeenNthCalledWith(2, "cancel_agent_request", { projectId: "unit-project", requestId: prepared.requestId });
    expect(host.querySelector('[data-testid="producer-request-status"]')?.textContent).toBe("cancelled · 0 recorded applied command(s)");
    expect(host.querySelector('[data-testid="producer-request-resolve"]')).toBeNull();
    expect(host.textContent).toContain("native engine confirmed no outstanding changes");
  });

  it("retains unresolved status and shows a native pre-state mismatch without claiming rollback", async () => {
    const snapshot = await mockSnapshot<Snapshot>();
    const unresolved: NativeExecution = { ...prepared, status: "unresolved", appliedCount: 1 };
    vi.mocked(readAgentContext).mockResolvedValue({ projectId: "unit-project", epoch: "unit-epoch", revision: 2, snapshot, requests: [unresolved] });
    vi.mocked(nativeRequest).mockResolvedValueOnce(unresolved).mockRejectedValueOnce(new Error("unresolved_request: restore the recorded pre-state before cancelling"));

    await click("producer-request-discover");
    select(unresolved.requestId);
    await click("producer-request-lookup");
    expect(host.querySelector('[data-testid="producer-request-resolve"]')?.textContent).toBe("Resolve restored pre-state");
    await click("producer-request-resolve");

    expect(host.querySelector('[data-testid="producer-request-status"]')?.textContent).toBe("unresolved · 1 recorded applied command(s)");
    expect(host.textContent).toContain("restore the recorded pre-state before cancelling");
    expect(host.textContent).not.toMatch(/changes were rolled back|confirmed no outstanding changes|cancelled ·/i);
    expect(host.querySelector('[data-testid="producer-request-resolve"]')).not.toBeNull();
    expect(nativeRequest).toHaveBeenCalledTimes(2);
  });

  it("surfaces discovery failure rather than presenting an empty successful inventory", async () => {
    vi.mocked(readAgentContext).mockRejectedValueOnce(new Error("Native request inventory unavailable"));

    await click("producer-request-discover");

    expect(host.textContent).toContain("Native request inventory unavailable");
    expect(host.textContent).not.toContain("No recorded requests in this project");
    expect(host.querySelector('[data-testid="producer-request-select"]')).toBeNull();
    expect(host.querySelector('[data-testid="producer-request-status"]')).toBeNull();
    expect(nativeRequest).not.toHaveBeenCalled();
  });
});
