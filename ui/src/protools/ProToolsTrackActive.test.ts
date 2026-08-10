import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { ProToolsTrackHeaders } from "./ProToolsTrackHeaders";
import { useProTools } from "./proToolsState";

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-track-active.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [
    { id: "vocal", index: 0, name: "Vocal", type: "audio", clips: [], active: true },
    { id: "print", index: 1, name: "Print Stem", type: "audio", clips: [], active: false },
  ],
  transport: {
    playing: false,
    recording: false,
    position: 0,
    looping: false,
    loopStart: 0,
    loopEnd: 0,
  },
};

describe("Pro Tools Track List active state", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  const originalExec = useStore.getState().exec;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({
      snapshot: SNAPSHOT,
      projectEpoch: 91,
      selectedTrackId: "print",
      lastError: null,
      exec,
    });
    useProTools.getState().resetForProject();
    useProTools.setState({ trackSelectionIds: ["print"] });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.querySelectorAll(".v2-menu-panel-floating").forEach((node) => node.remove());
    useStore.setState({ snapshot: null, selectedTrackId: null, lastError: null, exec: originalExec });
  });

  it("keeps an inactive track visible with explicit visual and accessible state", () => {
    // Given an active source track and an inactive print track.
    act(() => root.render(React.createElement(ProToolsTrackHeaders, { snapshot: SNAPSHOT })));

    // When the Track List header bank renders.
    const print = host.querySelector<HTMLElement>('[data-track-id="print"]');
    const select = print?.querySelector<HTMLButtonElement>("[data-testid=pt-track-select]");

    // Then inactive remains separate from hidden and is announced without silencing visibility.
    expect(host.querySelectorAll("[data-testid=pt-track-header]")).toHaveLength(2);
    expect(print?.dataset.trackActive).toBe("false");
    expect(select?.getAttribute("aria-label")).toBe("Select track Print Stem, inactive");
    expect(print?.textContent).toContain("Inactive");
  });

  it("makes selected inactive tracks active through store.exec", async () => {
    // Given Print Stem is selected and inactive.
    act(() => root.render(React.createElement(ProToolsTrackHeaders, { snapshot: SNAPSHOT })));

    // When Make Selected Tracks Active is chosen from the Track List menu.
    const trigger = host.querySelector<HTMLButtonElement>("[data-testid=pt-track-visibility-menu]");
    if (!trigger) throw new Error("Track List menu trigger is missing");
    await act(async () => trigger.click());
    const action = document.querySelector<HTMLButtonElement>(
      '[data-testid="pt-track-active-selected"]',
    );
    if (!action) throw new Error("Make Selected Tracks Active is missing");
    await act(async () => action.click());

    // Then the project mutation uses the one command seam with an explicit boolean.
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith(
      "set_track_active",
      { trackId: "print", active: true },
    ));
  });

  it("surfaces a rejected active-state command through the shared error bar state", async () => {
    // Given the native command will reject the selected inactive track.
    exec.mockResolvedValueOnce({
      ok: false,
      command: "set_track_active",
      error: "track is locked by another collaborator",
    });
    act(() => root.render(React.createElement(ProToolsTrackHeaders, { snapshot: SNAPSHOT })));

    // When Make Selected Tracks Active is chosen.
    const trigger = host.querySelector<HTMLButtonElement>("[data-testid=pt-track-visibility-menu]");
    if (!trigger) throw new Error("Track List menu trigger is missing");
    await act(async () => trigger.click());
    const action = document.querySelector<HTMLButtonElement>(
      '[data-testid="pt-track-active-selected"]',
    );
    if (!action) throw new Error("Make Selected Tracks Active is missing");
    await act(async () => action.click());

    // Then the existing Pro Tools error surface receives the native reason.
    await vi.waitFor(() => expect(useStore.getState().lastError)
      .toBe("track is locked by another collaborator"));
  });
});
