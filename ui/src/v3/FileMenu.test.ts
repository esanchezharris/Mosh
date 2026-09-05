import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileMenu } from "./FileMenu";
import { TopBar } from "./TopBar";
import { useV3 } from "./shellState";
import { useStore } from "../store";
import type { Snapshot } from "../types";

vi.mock("../menuActions", () => ({ runAction: vi.fn() }));

function snap(): Snapshot {
  return {
    schemaVersion: 1,
    session: { sampleRate: 48000, tempo: 120, length: 16, editFile: "/mock/song.mosh", metronome: false },
    tracks: [],
  } as unknown as Snapshot;
}

describe("v3 File menu + top bar", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useV3.setState({ fileOpen: true, posture: "studio", historyOpen: false, settingsOpen: false });
    useStore.setState({ transport: { playing: false, recording: false, position: 0, looping: false } as never, snap: true });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("keeps the closed File panel inert so the 180ms in-flow menu is not a keyboard trap", () => {
    useV3.setState({ fileOpen: false });
    act(() => root.render(React.createElement(FileMenu, { title: "untitled" })));
    const menu = host.querySelector<HTMLElement>('[data-testid="v3-file-menu"]');
    expect(menu?.inert).toBe(true);
    expect(menu?.getAttribute("aria-hidden")).toBe("true");
    act(() => useV3.setState({ fileOpen: true }));
    expect(host.querySelector<HTMLElement>('[data-testid="v3-file-menu"]')?.inert).toBe(false);
  });

  it("has Templates › Recording Booth / Full Studio and no Studio/Booth top toggle", () => {
    act(() => root.render(React.createElement(FileMenu, { title: "untitled" })));
    expect(host.querySelector('[data-testid="v3-templates"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="v3-template-booth"]')?.textContent).toMatch(/Recording Booth/);
    expect(host.querySelector('[data-testid="v3-template-studio"]')?.textContent).toMatch(/Full Studio/);
    expect(host.textContent).toMatch(/soon/);
    expect(host.querySelector('[data-testid="v3-studio-toggle"]')).toBeNull();
  });

  it("has History and no Undo button on the top bar", () => {
    act(() => root.render(React.createElement(TopBar, { snapshot: snap() })));
    expect(host.querySelector('[data-testid="v3-history"]')).not.toBeNull();
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Undo")).toBe(false);
  });
});
