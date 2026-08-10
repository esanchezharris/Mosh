import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTaskStore, type TaskView } from "../agent/loop/taskStore";
import { useStore } from "../store";
import type { Snapshot } from "../types";
import { AppProTools } from "./AppProTools";

vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return { ...actual, isNative: () => true };
});
vi.mock("../hooks/useKeyboardShortcuts", () => ({ useKeyboardShortcuts: vi.fn() }));
vi.mock("../hooks/useQwertyMidi", () => ({ useQwertyMidi: vi.fn() }));
vi.mock("../hooks/useFileDrop", () => ({ useFileDrop: () => false }));
vi.mock("./ProToolsArrangement", () => ({
  ProToolsArrangement: () => React.createElement("div", { "data-testid": "pt-arrangement-stub" }),
}));
vi.mock("./ProToolsDetailDock", () => ({ ProToolsDetailDock: () => null }));
vi.mock("./ProToolsStatusBar", () => ({ ProToolsStatusBar: () => null }));

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-moshi.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

function runningTask(): TaskView {
  return {
    ask: "tighten the vocal timing",
    phase: "planning",
    plan: [{ goal: "align the vocal" }],
    steps: [],
    startedAt: 1,
  };
}

function completedTask(): TaskView {
  return {
    ...runningTask(),
    phase: "finalizing",
    steps: [{ goal: "align the vocal", commands: [], results: [], running: false }],
    outcome: "done",
    endedAt: 2,
  };
}

describe("Pro Tools Moshi drawer", () => {
  let host: HTMLDivElement;
  let root: Root;
  const originalState = useStore.getState();

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      snapshot: SNAPSHOT,
      projectEpoch: 1,
      transport: SNAPSHOT.transport,
      selectedTrackId: null,
      lastError: null,
      peers: {},
      agentBusy: false,
      agentChangeSet: {
        label: "tighten vocal",
        entries: [{ index: 0, command: "move_clip", summary: "Moved vocal clip", ok: true }],
        applied: 1,
      },
    });
    useTaskStore.setState({
      current: runningTask(),
      last: null,
      history: [],
      drawerOpen: true,
      signal: { aborted: false },
      sink: null,
    });
    act(() => root.render(React.createElement(AppProTools)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.querySelectorAll(".v2-menu-panel-floating, .mosh-tip").forEach((node) => node.remove());
    useStore.setState({
      snapshot: originalState.snapshot,
      projectEpoch: originalState.projectEpoch,
      transport: originalState.transport,
      selectedTrackId: originalState.selectedTrackId,
      lastError: originalState.lastError,
      peers: originalState.peers,
      agentBusy: originalState.agentBusy,
      agentChangeSet: originalState.agentChangeSet,
    });
    useTaskStore.setState({ current: null, last: null, history: [], drawerOpen: false, signal: null, sink: null });
  });

  it("is collapsed by default, opens nonmodally, and focuses the shared composer", async () => {
    expect(host.querySelector("[data-testid=pt-moshi-drawer]")).toBeNull();
    const trigger = host.querySelector<HTMLButtonElement>("[data-testid=pt-ask-moshi]");
    if (!trigger) throw new Error("Ask Moshi trigger is missing");
    act(() => trigger.focus());

    await act(async () => trigger.click());

    const drawer = host.querySelector<HTMLElement>("[data-testid=pt-moshi-drawer]");
    expect(drawer?.getAttribute("role")).toBe("complementary");
    expect(drawer?.hasAttribute("aria-modal")).toBe(false);
    expect(document.activeElement).toBe(drawer?.querySelector("[data-testid=agent-input]"));
    expect(drawer?.querySelector("[data-testid=agent-stop]")).not.toBeNull();
    expect(drawer?.querySelector("[data-testid=v2-toast-undo]")).not.toBeNull();
  });

  it("exposes task Undo and restores focus when closed", async () => {
    const trigger = host.querySelector<HTMLButtonElement>("[data-testid=pt-ask-moshi]");
    if (!trigger) throw new Error("Ask Moshi trigger is missing");
    await act(async () => trigger.click());

    act(() => useTaskStore.setState({ current: null, last: completedTask(), drawerOpen: true, signal: null }));
    expect(host.querySelector("[data-testid=agent-undo-task]")).not.toBeNull();

    const close = host.querySelector<HTMLButtonElement>("[data-testid=pt-moshi-close]");
    if (!close) throw new Error("Moshi close button is missing");
    await act(async () => close.click());
    expect(host.querySelector("[data-testid=pt-moshi-drawer]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
