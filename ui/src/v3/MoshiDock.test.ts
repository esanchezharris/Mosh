import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoshiDock, recordingDisablesDock } from "./MoshiDock";
import { useStore } from "../store";

vi.mock("../vendor/moshi.js", () => ({}));
vi.mock("../agent/voiceInput", () => ({
  createVoiceInput: () => null,
  isVoiceSupported: () => false,
}));
vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, brainRuntimeStatus: async () => ({ state: "unavailable" }), onEvent: () => () => {} };
});

describe("v3 Moshi dock", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      agentBusy: false,
      celebrateTick: 0,
      agentChangeSet: null,
      transport: { playing: false, recording: false, position: 0, looping: false } as never,
      setAgentBusy: vi.fn(),
      setAgentChangeSet: vi.fn(),
      pushAgentUtter: vi.fn(),
      setAgentListening: vi.fn(),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("recording disables the dock", async () => {
    expect(recordingDisablesDock(true)).toBe(true);
    expect(recordingDisablesDock(false)).toBe(false);
    useStore.setState({ transport: { playing: false, recording: true, position: 0, looping: false } as never });
    await act(async () => {
      root.render(React.createElement(MoshiDock));
      await Promise.resolve();
    });
    const dock = host.querySelector('[data-testid="v3-moshi-dock"]');
    expect(dock?.getAttribute("data-recording-safe")).toBe("true");
    expect(host.querySelector<HTMLInputElement>('[data-testid="v3-moshi-field"]')?.disabled).toBe(true);
    expect(host.querySelector('[data-testid="v3-receipt"]')).toBeNull();
  });
});
