import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSettings } from "../settings/store";
import type { Snapshot } from "../types";
import { FileOptions } from "./FileOptions";

const snapshot = {
  session: { recentProjects: [], editFile: "", dirty: false, audioEnabled: true },
  tracks: [],
} as unknown as Snapshot;

describe("FileOptions effective shortcut presentation", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useSettings.setState({
      values: { uiShell: "v2", workflowProfile: "mosh" },
      keyOverrides: {
        mosh: { "key.open_project": "Mod+P" },
        fl: { "key.open_project": "Mod+L" },
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it.each([
    ["mosh", "⌘P"],
    ["fl", "⌘L"],
  ])("renders the %s profile's effective File accelerators", async (profile, openAccelerator) => {
    useSettings.setState({ values: { uiShell: "v2", workflowProfile: profile } });
    await act(async () => root.render(React.createElement(FileOptions, { snapshot })));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="file-options"]')?.click());

    const menu = host.querySelector('[data-testid="file-options-menu"]');
    const accelerator = (action: string) =>
      menu?.querySelector(`[data-action="${action}"] .menu-accel`)?.textContent;
    expect(accelerator("open_project")).toBe(openAccelerator);
    expect(accelerator("save")).toBe("⌘S");
    expect(accelerator("save_as")).toBe("⌘⇧S");
  });
});
