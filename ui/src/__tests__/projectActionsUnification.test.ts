// AL-018 — project (New/Open/Open Recent/Save/Save As) actions must be defined
// exactly once (menuActions.ts's FILE_MENU + runAction) and every UI surface that
// offers them must consume that single source rather than hand-rolling its own
// labels/handlers. This regression exercises one project action from each surface:
//   - the Settings panel's Project group (settings/SettingsPanel.tsx)
//   - the classic topbar File menu (ui/TopbarTools.tsx)
//   - the redesign "+" file-options menu (ui/FileOptions.tsx)
// The keyboard/native-menu surface is already covered by
// hooks/useKeyboardShortcuts.test.ts ("preserves native menu open_project file
// payloads"), which routes the same "mosh_menu" event through runAction.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectSettings } from "../settings/SettingsPanel";
import { FileMenu } from "../ui/TopbarTools";
import { FileOptions } from "../ui/FileOptions";
import { FILE_MENU } from "../menuActions";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";

function makeSnapshot(): Snapshot {
  return {
    schemaVersion: 1,
    session: {
      sampleRate: 48000,
      tempo: 120,
      key: { root: "C", scale: "major" },
      editFile: "/proj/song.mosh",
      dirty: false,
      audioEnabled: true,
      recentProjects: [
        { path: "/proj/song.mosh", name: "song.mosh" },
        { path: "/proj/old.mosh", name: "old.mosh" },
      ],
    },
    tracks: [],
    transport: { playing: false, position: 0 },
  } as unknown as Snapshot;
}

describe("AL-018 — project actions render from the single FILE_MENU source across surfaces", () => {
  let host: HTMLDivElement;
  let root: Root;
  const originalExec = useStore.getState().exec;
  const originalRefresh = useStore.getState().refresh;
  let execCalls: { command: string; args?: Record<string, unknown> }[];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    execCalls = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        execCalls.push({ command, args });
        return { ok: true, command };
      }),
      refresh: vi.fn(async () => {}),
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    useStore.setState({ exec: originalExec, refresh: originalRefresh });
    vi.restoreAllMocks();
  });

  it("Settings panel's Project actions ARE FILE_MENU (minus export), not a separately hand-rolled copy", async () => {
    const snapshot = makeSnapshot();
    await act(async () => {
      root.render(React.createElement(ProjectSettings, { snapshot }));
    });

    const expected = FILE_MENU.filter((m) => m.id !== "export_audio");
    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>(".pop-actions [data-action]"));
    expect(buttons.map((b) => b.dataset.action)).toEqual(expected.map((m) => m.id));
    expect(buttons.map((b) => b.textContent)).toEqual(expected.map((m) => m.label));

    const newBtn = buttons.find((b) => b.dataset.action === "new_project")!;
    await act(async () => {
      newBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});

    expect(execCalls).toContainEqual({ command: "new_project", args: undefined });
  });

  it("the classic topbar File menu dispatches a project action through the shared runAction seam", async () => {
    const snapshot = makeSnapshot();
    await act(async () => {
      root.render(React.createElement(FileMenu, { snapshot }));
    });

    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="File"]');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const menu = host.querySelector('[data-testid="file-menu"]');
    expect(menu).not.toBeNull();
    const saveBtn = menu!.querySelector<HTMLButtonElement>('[data-action="save"]');
    expect(saveBtn).not.toBeNull();
    await act(async () => {
      saveBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});

    expect(execCalls).toContainEqual({ command: "save", args: undefined });
  });

  it('the redesign "+" file-options menu dispatches a project action through the same seam', async () => {
    const snapshot = makeSnapshot();
    await act(async () => {
      root.render(React.createElement(FileOptions, { snapshot }));
    });

    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="file-options"]');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const menu = host.querySelector('[data-testid="file-options-menu"]');
    expect(menu).not.toBeNull();
    const newBtn = menu!.querySelector<HTMLButtonElement>('[data-action="new_project"]');
    expect(newBtn).not.toBeNull();
    await act(async () => {
      newBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});

    expect(execCalls).toContainEqual({ command: "new_project", args: undefined });
  });
});
