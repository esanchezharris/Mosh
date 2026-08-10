import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoshTipProvider } from "../chrome/Tooltip";
import { FILE_MENU } from "../menuActions";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { useShell } from "../v2/shellState";
import { ProToolsToolbar } from "./ProToolsToolbar";
import { useProTools } from "./proToolsState";

const bridge = vi.hoisted(() => ({
  pickFiles: vi.fn(async () => ({ ok: false, files: [] as string[] })),
  pickSaveFile: vi.fn(async () => ({ ok: false, file: "" })),
  brainChat: vi.fn(),
}));

vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return { ...actual, ...bridge };
});

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-session.mosh",
    projectExtension: "mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

describe("Pro Tools Session menu", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  const originalExec = useStore.getState().exec;
  const originalRefresh = useStore.getState().refresh;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({ snapshot: SNAPSHOT, transport: SNAPSHOT.transport, exec, refresh: vi.fn(async () => {}) });
    useShell.setState({ timeRange: null, timeRangeDragging: false });
    useProTools.getState().resetForProject(useProTools.getState().projectEpoch + 1);
    act(() => root.render(
      React.createElement(MoshTipProvider, { delay: 0 },
        React.createElement(ProToolsToolbar, {
          snapshot: SNAPSHOT,
          onOpenSettings: vi.fn(),
          moshiOpen: false,
          onToggleMoshi: vi.fn(),
          moshiButtonRef: React.createRef<HTMLButtonElement>(),
        })),
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.querySelectorAll(".v2-menu-panel-floating, .mosh-tip").forEach((node) => node.remove());
    useStore.setState({ snapshot: null, exec: originalExec, refresh: originalRefresh });
    useShell.setState({ timeRange: null, timeRangeDragging: false });
    bridge.pickFiles.mockClear();
    bridge.pickSaveFile.mockClear();
  });

  async function openMenu(): Promise<void> {
    const trigger = host.querySelector<HTMLButtonElement>("[data-testid=pt-session-menu]");
    if (!trigger) throw new Error("Session menu trigger is missing");
    await act(async () => trigger.click());
  }

  it("renders the canonical file actions in their shared order", async () => {
    await openMenu();

    const actions = Array.from(document.querySelectorAll<HTMLElement>("[data-pt-session-action]"));
    expect(actions.map((item) => item.dataset.ptSessionAction)).toEqual(FILE_MENU.map((item) => item.id));
    expect(actions.map((item) => item.textContent?.trim())).toEqual(
      FILE_MENU.map((item) => `${item.label}${item.accel}`),
    );
  });

  it("dispatches Save through runAction and store.exec", async () => {
    await openMenu();
    const save = document.querySelector<HTMLButtonElement>("[data-pt-session-action=save]");
    if (!save) throw new Error("Save action is missing");

    await act(async () => save.click());

    expect(exec).toHaveBeenCalledWith("save");
  });

  it("does not issue Open or Save As commands when their native picker is canceled", async () => {
    await openMenu();
    const open = document.querySelector<HTMLButtonElement>("[data-pt-session-action=open_project]");
    if (!open) throw new Error("Open action is missing");
    await act(async () => open.click());
    expect(bridge.pickFiles).toHaveBeenCalledTimes(1);
    expect(exec).not.toHaveBeenCalled();

    await openMenu();
    const saveAs = document.querySelector<HTMLButtonElement>("[data-pt-session-action=save_as]");
    if (!saveAs) throw new Error("Save As action is missing");
    await act(async () => saveAs.click());
    expect(bridge.pickSaveFile).toHaveBeenCalledTimes(1);
    expect(exec).not.toHaveBeenCalled();
  });

  it("unlinks Timeline and Edit selection from an accessible pressed control", () => {
    // Given the default linked control and a current Edit selection.
    act(() => useShell.setState({ timeRange: { start: 2, end: 6 } }));
    const link = host.querySelector<HTMLButtonElement>("[data-testid=pt-selection-link]");
    if (!link) throw new Error("Timeline and Edit selection link control is missing");
    expect(link.getAttribute("aria-pressed")).toBe("true");

    // When the visible toolbar control is pressed.
    act(() => link.click());

    // Then it exposes the unlinked state without issuing a project command.
    expect(link.getAttribute("aria-pressed")).toBe("false");
    expect(link.getAttribute("aria-label")).toMatch(/Link Timeline and Edit Selection/i);
    expect(useProTools.getState().timelineSelection).toEqual({ start: 2, end: 6 });
    expect(exec).not.toHaveBeenCalled();
  });
});
