import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { Snapshot } from "../types";
import { SettingsOverlay } from "./AppProTools";

vi.mock("../settings/SettingsPanel", () => ({
  SettingsPanel: () => React.createElement(React.Fragment, null,
    React.createElement("button", { type: "button" }, "First setting"),
    React.createElement("button", { type: "button" }, "Last setting")),
}));

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-settings.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

function Harness() {
  const [open, setOpen] = useState(false);
  return React.createElement(React.Fragment, null,
    React.createElement("button", { type: "button", onClick: () => setOpen(true) }, "Open settings"),
    open ? React.createElement(SettingsOverlay, { onClose: () => setOpen(false) }) : null);
}

describe("Pro Tools settings overlay", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({ snapshot: SNAPSHOT });
    act(() => root.render(React.createElement(Harness)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ snapshot: null });
  });

  it("moves focus into the dialog, traps Tab, closes with Escape, and restores the trigger", () => {
    const trigger = host.querySelector<HTMLButtonElement>("button");
    if (!trigger) throw new Error("settings trigger is missing");
    trigger.focus();
    act(() => trigger.click());
    const close = host.querySelector<HTMLButtonElement>("[data-testid=pt-settings-close]");
    const last = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).at(-1);
    if (!close || !last) throw new Error("settings controls are missing");

    expect(document.activeElement).toBe(close);
    act(() => close.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Tab", shiftKey: true, bubbles: true, cancelable: true,
    })));
    expect(document.activeElement).toBe(last);
    act(() => last.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Tab", bubbles: true, cancelable: true,
    })));
    expect(document.activeElement).toBe(close);

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(host.querySelector("[data-testid=pt-settings-dialog]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("provides a visible close button and dismisses on backdrop click", () => {
    const trigger = host.querySelector<HTMLButtonElement>("button");
    if (!trigger) throw new Error("settings trigger is missing");
    act(() => trigger.click());
    const close = host.querySelector<HTMLButtonElement>("[data-testid=pt-settings-close]");
    const backdrop = host.querySelector<HTMLElement>("[data-testid=pt-settings-backdrop]");

    expect(close?.textContent).toContain("Close");
    if (!backdrop) throw new Error("settings backdrop is missing");
    act(() => backdrop.click());
    expect(host.querySelector("[data-testid=pt-settings-dialog]")).toBeNull();
  });
});
