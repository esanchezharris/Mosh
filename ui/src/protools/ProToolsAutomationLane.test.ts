import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Track } from "../types";
import { ProToolsAutomationLane } from "./ProToolsAutomationLane";

const TRACK: Track = {
  id: "track-1",
  index: 0,
  name: "Audio",
  type: "audio",
  clips: [],
  plugins: [{
    index: 3,
    name: "Gain",
    type: "builtin",
    enabled: true,
    external: false,
    isInstrument: false,
    params: [{ index: 2, name: "Level", value: 0.5 }],
  }],
};

describe("ProToolsAutomationLane", () => {
  let host: HTMLDivElement;
  let root: Root;
  let execCalls: { readonly command: string; readonly args?: Record<string, unknown> }[];
  const originalExec = useStore.getState().exec;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    execCalls = [];
    useStore.setState({
      pxPerSec: 100,
      transport: { ...useStore.getState().transport, position: 3 },
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        execCalls.push({ command, args });
        return { ok: true, command };
      }),
    });
    act(() => root.render(React.createElement(ProToolsAutomationLane, { track: TRACK, width: 800 })));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ exec: originalExec });
    vi.restoreAllMocks();
  });

  it("adds a breakpoint at the playhead through store.exec when Enter is pressed", async () => {
    const lane = host.querySelector<HTMLElement>("[data-testid=protools-automation-lane]");
    if (!lane) throw new Error("automation lane is missing");
    lane.focus();

    act(() => lane.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", bubbles: true, cancelable: true,
    })));

    await vi.waitFor(() => expect(execCalls).toContainEqual({
      command: "add_automation_point",
      args: { trackId: "track-1", pluginIndex: 3, paramIndex: 2, time: 3, value: 0.5 },
    }));
  });

  it("exposes a keyboard-operable breakpoint control", () => {
    const lane = host.querySelector<HTMLElement>("[data-testid=protools-automation-lane]");

    expect(lane?.tagName).toBe("BUTTON");
    expect(lane?.getAttribute("type")).toBe("button");
    expect(lane?.getAttribute("aria-keyshortcuts")).toBe("Enter Space");
    expect(lane?.getAttribute("aria-label")).toBe("Audio automation, Level. Enter or Space adds a breakpoint at the playhead.");
  });

  it("removes an automation lane without a target from keyboard focus", () => {
    act(() => root.render(React.createElement(ProToolsAutomationLane, {
      track: { ...TRACK, plugins: [] }, width: 800,
    })));
    const lane = host.querySelector<HTMLButtonElement>("[data-testid=protools-automation-lane]");

    expect(lane?.disabled).toBe(true);
    expect(lane?.getAttribute("aria-label")).toBe("Audio automation, no target");
  });
});
