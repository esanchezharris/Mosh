// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({ isNative: () => true }));
vi.mock("../hooks/useKeyboardShortcuts", () => ({ useKeyboardShortcuts: () => undefined }));
vi.mock("../hooks/useFileDrop", () => ({ useFileDrop: () => false }));
vi.mock("./TopBar", () => ({ TopBar: () => null }));
vi.mock("./lanes/TrackLaneList", () => ({ TrackLaneList: () => null }));
vi.mock("./RightRail", () => ({ RightRail: () => null }));
vi.mock("./Composer", () => ({ Composer: () => null }));
vi.mock("../ui/PianoRoll", () => ({ PianoRoll: () => null }));
vi.mock("../ui/RecoveryNotice", () => ({ RecoveryNotice: () => null }));
vi.mock("../ui/AudioDeviceNotice", () => ({ AudioDeviceNotice: () => null }));
vi.mock("../ui/FeltWrongDialog", () => ({ FeltWrongDialog: () => null }));
vi.mock("./SessionPicker", () => ({ SessionPicker: () => null }));
vi.mock("../ui/MissingMediaBanner", () => ({ MissingMediaBanner: () => null }));
vi.mock("../ui/AutomationPanel", () => ({ AutomationPanel: () => null }));
vi.mock("../ui/DrumWindow", () => ({ DrumWindow: () => null }));
vi.mock("./ChangeToast", () => ({ ChangeToast: () => null }));
vi.mock("./MemoryToast", () => ({ MemoryToast: () => null }));
vi.mock("../ui/SampleBrowser", () => ({
  SampleBrowser: () => React.createElement("div", null, "Sample browser body"),
}));
vi.mock("./PluginBrowser", () => ({
  PluginDock: () => React.createElement("div", null, "Plugin browser body"),
}));

import { useStore } from "../store";
import { AppV2 } from "./AppV2";
import { LeftDrawer } from "./LeftDrawer";
import { useShell } from "./shellState";

describe("AppV2 Browser open-state integration", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useShell.setState({ browserOpen: false, browserTab: "sounds" });
    useStore.setState({ snapshot: null, lastError: null, peers: {} });
    host = document.createElement("div");
    document.body.replaceChildren(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    document.body.replaceChildren();
  });

  it("updates the shell width state and drawer content in the same pull-tab transition", async () => {
    await act(async () => { root.render(React.createElement(AppV2)); });

    const shell = host.querySelector<HTMLElement>('[data-testid="v2-shell"]')!;
    expect(shell.dataset.leftOpen).toBe("false");
    expect(host.querySelector('[data-testid="v2-browser-close"]')).toBeNull();

    const pull = host.querySelector<HTMLButtonElement>('[data-testid="v2-browser-pull"]')!;
    await act(async () => {
      pull.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(shell.dataset.leftOpen).toBe("true");
    expect(host.querySelector('[data-testid="v2-browser-drawer"]')?.classList.contains("open")).toBe(true);
    expect(host.querySelector('[data-testid="v2-browser-close"]')).not.toBeNull();
    expect(host.textContent).toContain("Sample browser body");
  });

  it("uses the AppV2-owned open value instead of subscribing to a second copy", async () => {
    useShell.setState({ browserOpen: false });
    await act(async () => {
      root.render(React.createElement(LeftDrawer, { open: true }));
    });

    expect(host.querySelector('[data-testid="v2-browser-drawer"]')?.classList.contains("open")).toBe(true);
    expect(host.querySelector('[data-testid="v2-browser-close"]')).not.toBeNull();
  });

  it("maps the parent-owned shell state to the live left grid column", () => {
    const arrangementCss = readFileSync(resolve(process.cwd(), "src/v2/css/30-arrangement.css"), "utf8");
    const tokenCss = readFileSync(resolve(process.cwd(), "src/v2/css/00-tokens.css"), "utf8");
    expect(arrangementCss).toMatch(
      /grid-template-columns:\s*var\(--v2-left-w\)\s+minmax\(0,\s*1fr\)\s+var\(--v2-right-w\)/,
    );
    expect(tokenCss).toMatch(/\.v2-shell\[data-left-open="true"\]\s*\{[^}]*--v2-left-w:\s*var\(--v2-browser-w\)/s);
    expect(tokenCss).toMatch(/\.v2-shell\[data-left-open="false"\]\s*\{[^}]*--v2-left-w:\s*var\(--v2-tab-w\)/s);
  });
});
