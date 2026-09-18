import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsModal } from "./SettingsModal";
import { FileMenu } from "./FileMenu";
import { useV3 } from "./shellState";
import { useSettings } from "../settings/store";
import { pushEscapeHandler, escapeStackDepth } from "../hooks/escapeStack";
import type { Snapshot } from "../types";

vi.mock("../settings/SettingsPanel", () => ({
  EngineSettings: () => null,
  AudioRouting: () => null,
  ProjectSettings: () => null,
}));

const snapshot: Snapshot = {
  schemaVersion: 1,
  session: { sampleRate: 48000, tempo: 120, editFile: "/mock/song.mosh", key: { tonic: "C", mode: "major" } },
  tracks: [],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

function control<T extends HTMLElement>(host: HTMLElement, selector: string): T {
  const element = host.querySelector<T>(selector);
  if (!element) throw new Error(`Missing control: ${selector}`);
  return element;
}

describe("V3 Settings overlay keyboard boundaries", () => {
  let host: HTMLDivElement;
  let root: Root;
  let trigger: HTMLButtonElement;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    useSettings.setState({ values: { uiShell: "v3" } });
    useV3.setState({ settingsOpen: false, fileOpen: false, historyOpen: false });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    act(() => root.render(React.createElement(SettingsModal, { snapshot })));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    trigger.remove();
    useSettings.setState({ values: {} });
    useV3.setState({ settingsOpen: false, fileOpen: false, historyOpen: false });
    expect(escapeStackDepth()).toBe(0);
  });

  it("moves focus into Settings when the mounted overlay opens", () => {
    act(() => useV3.getState().setSettingsOpen(true));

    const dialog = control(host, '[role="dialog"]');
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(control(host, '[aria-label="Close"]'));
  });

  it.each([false, true])("wraps Tab within Settings when shiftKey is %s", (shiftKey) => {
    act(() => useV3.getState().setSettingsOpen(true));
    const controls = host.querySelectorAll<HTMLElement>("button, input, select, textarea");
    const first = controls.item(0);
    const last = controls.item(controls.length - 1);
    const start = shiftKey ? first : last;
    start.focus();

    act(() => start.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true })));

    expect(document.activeElement).toBe(shiftKey ? last : first);
  });

  it.each(["escape", "close", "scrim"])("restores the trigger when Settings closes using %s", (method) => {
    act(() => useV3.getState().setSettingsOpen(true));

    act(() => {
      if (method === "escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      else control(host, method === "close" ? '[aria-label="Close"]' : ".scrim").click();
    });

    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("leaves a newer overlay on top of Settings after a settings rerender", () => {
    act(() => useV3.getState().setSettingsOpen(true));
    const upperClose = vi.fn();
    const pop = pushEscapeHandler(upperClose);
    act(() => useSettings.setState({ values: { uiShell: "v3", colorway: "violet" } }));

    try {
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

      expect(upperClose).toHaveBeenCalledOnce();
      expect(useV3.getState().settingsOpen).toBe(true);
    } finally {
      pop();
    }
  });

  it("returns focus to the File trigger when Settings was opened from its menu", () => {
    act(() => {
      root.render(React.createElement(React.Fragment, null,
        React.createElement(FileMenu, { title: "song" }),
        React.createElement(SettingsModal, { snapshot })));
      useV3.getState().setFileOpen(true);
    });
    const settings = control(host, '[data-testid="v3-open-settings"]');
    settings.focus();
    act(() => settings.click());

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

    expect(document.activeElement).toBe(control(host, '[data-testid="v3-file-trigger"]'));
  });
});
