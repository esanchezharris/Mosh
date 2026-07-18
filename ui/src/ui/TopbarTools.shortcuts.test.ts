import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSettings } from "../settings/store";
import type { Snapshot } from "../types";
import { FileMenu, HelpTool } from "./TopbarTools";

const snapshot = {
  session: { recentProjects: [], editFile: "", dirty: false },
  tracks: [],
} as unknown as Snapshot;

describe("profile-aware shortcut presentation", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useSettings.setState({
      values: { uiShell: "v2", workflowProfile: "mosh" },
      keyOverrides: {},
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function openMenus() {
    await act(async () => {
      root.render(React.createElement(React.Fragment, null,
        React.createElement(FileMenu, { snapshot }),
        React.createElement(HelpTool),
      ));
    });
    const triggers = host.querySelectorAll<HTMLButtonElement>(".pop-wrap > button");
    await act(async () => {
      triggers.forEach((button) => button.click());
    });
  }

  it.each([
    ["mosh", "⌘E"],
    ["fl", "⌘R"],
  ])("uses the %s effective export binding in File and Help", async (profile, accelerator) => {
    useSettings.setState({ values: { uiShell: "v2", workflowProfile: profile } });
    await openMenus();

    const exportItem = host.querySelector<HTMLElement>('[data-action="export_audio"]');
    expect(exportItem?.querySelector(".menu-accel")?.textContent).toBe(accelerator);
    const helpText = host.querySelector(".help-pop .pop")?.textContent ?? "";
    expect(helpText).toContain(accelerator);
    if (profile === "fl") expect(helpText).not.toContain("⌘E");
  });
});
