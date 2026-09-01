import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrainRuntimeStatus } from "../bridge";
import { useBrainRuntime } from "./useBrainRuntime";

const bridgeMock = vi.hoisted(() => {
  const state: { eventHandler?: (payload: unknown) => void } = {};
  return {
    state,
    statusCall: vi.fn(async (): Promise<BrainRuntimeStatus> => ({ configured: true, state: "off" })),
    startCall: vi.fn(async (): Promise<BrainRuntimeStatus> => ({ configured: true, state: "starting" })),
    stopCall: vi.fn(async (): Promise<BrainRuntimeStatus> => ({ configured: true, state: "stopping" })),
  };
});

vi.mock("../bridge", () => ({
  brainRuntimeStatus: bridgeMock.statusCall,
  brainRuntimeStart: bridgeMock.startCall,
  brainRuntimeStop: bridgeMock.stopCall,
  parseBrainRuntimeStatus: (value: BrainRuntimeStatus) => value,
  onEvent: (_name: string, handler: (payload: unknown) => void) => {
    bridgeMock.state.eventHandler = handler;
    return () => { delete bridgeMock.state.eventHandler; };
  },
}));

function Harness() {
  const runtime = useBrainRuntime();
  return React.createElement("div", null,
    React.createElement("output", { "data-state": runtime.status.state }, runtime.status.state),
    React.createElement("button", { onClick: () => void runtime.start() }, "start"),
    React.createElement("button", { onClick: () => void runtime.stop() }, "stop"),
  );
}

describe("shared local brain runtime hook", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    bridgeMock.statusCall.mockClear();
    bridgeMock.startCall.mockClear();
    bridgeMock.stopCall.mockClear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("shares status events and routes start and stop through the native bridge", async () => {
    await act(async () => root.render(React.createElement(Harness)));
    expect(bridgeMock.statusCall).toHaveBeenCalledTimes(1);
    expect(host.querySelector("output")?.dataset.state).toBe("off");

    await act(async () => host.querySelectorAll("button")[0]?.click());
    expect(bridgeMock.startCall).toHaveBeenCalledTimes(1);
    expect(host.querySelector("output")?.dataset.state).toBe("starting");

    await act(async () => bridgeMock.state.eventHandler?.({ configured: true, state: "ready" }));
    expect(host.querySelector("output")?.dataset.state).toBe("ready");

    await act(async () => host.querySelectorAll("button")[1]?.click());
    expect(bridgeMock.stopCall).toHaveBeenCalledTimes(1);
    expect(host.querySelector("output")?.dataset.state).toBe("stopping");
  });
});
