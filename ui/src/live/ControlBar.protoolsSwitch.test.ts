import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MoshTipProvider } from "../chrome/Tooltip";
import { useSettings } from "../settings/store";
import { useStore } from "../store";
import type { Snapshot } from "../types";
import { ControlBar } from "./ControlBar";

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: { sampleRate: 48_000, tempo: 120, editFile: "/tmp/live-switch.mosh", key: { tonic: "C", mode: "major" } },
  tracks: [],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

describe("Live shell Pro Tools switch", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    useSettings.getState().reset();
    useSettings.getState().set("uiShell", "live");
    useStore.setState({ snapshot: SNAPSHOT, transport: SNAPSHOT.transport });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(
      React.createElement(MoshTipProvider, { delay: 0 }, React.createElement(ControlBar, { snapshot: SNAPSHOT })),
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.querySelectorAll(".v2-menu-panel-floating, .mosh-tip").forEach((node) => node.remove());
    localStorage.clear();
    useSettings.getState().reset();
    useStore.setState({ snapshot: null });
  });

  it("switches to Pro Tools from one overflow-menu pick", async () => {
    const menu = host.querySelector<HTMLButtonElement>("[data-testid=live-menu]");
    if (!menu) throw new Error("Live shell menu is missing");
    await act(async () => menu.click());
    const item = document.querySelector<HTMLButtonElement>("[data-testid=live-switch-protools]");
    if (!item) throw new Error("Switch to Pro Tools action is missing");

    await act(async () => item.click());

    expect(useSettings.getState().get("uiShell")).toBe("protools");
  });
});
