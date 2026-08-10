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
    editFile: "/tmp/protools-track-visibility.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: ["Vocal", "Bass", "Keys"].map((name, index) => ({
    id: name.toLowerCase(),
    index,
    name,
    type: "audio",
    clips: [],
  })),
  transport: {
    playing: false,
    recording: false,
    position: 0,
    looping: false,
    loopStart: 0,
    loopEnd: 0,
  },
};

describe("Pro Tools Track List visibility", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  const originalExec = useStore.getState().exec;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({ snapshot: SNAPSHOT, projectEpoch: 71, exec });
    useProTools.getState().resetForProject();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.querySelectorAll(".v2-menu-panel-floating").forEach((node) => node.remove());
    useStore.setState({ snapshot: null, exec: originalExec });
  });

  it("removes a hidden track from the Edit header bank without a project command", () => {
    // Given all three session tracks are shown in order.
    act(() => root.render(React.createElement(ProToolsTrackHeaders, { snapshot: SNAPSHOT })));
    const shownTrackIds = () => [...host.querySelectorAll<HTMLElement>("[data-testid=pt-track-header]")]
      .map((header) => header.dataset.trackId);
    expect(shownTrackIds()).toEqual(["vocal", "bass", "keys"]);

    // When Bass is hidden through Pro Tools view state.
    act(() => useProTools.getState().setTrackShown("bass", false));

    // Then the header bank closes the gap and session commands remain untouched.
    expect(shownTrackIds()).toEqual(["vocal", "keys"]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("keeps a hidden track recoverable from the Track List menu", async () => {
    // Given Bass is hidden before the Edit Window renders.
    useProTools.getState().setTrackShown("bass", false);
    act(() => root.render(React.createElement(ProToolsTrackHeaders, { snapshot: SNAPSHOT })));
    expect(host.querySelectorAll("[data-testid=pt-track-header]")).toHaveLength(2);

    // When the producer opens the persistent Track List and shows Bass again.
    const trigger = host.querySelector<HTMLButtonElement>("[data-testid=pt-track-visibility-menu]");
    if (!trigger) throw new Error("Track List visibility trigger is missing");
    await act(async () => trigger.click());
    const bass = await vi.waitFor(() => {
      const item = document.querySelector<HTMLButtonElement>("[data-testid=pt-track-visibility-bass]");
      expect(item?.getAttribute("aria-label")).toBe("Show Bass track");
      return item;
    });
    if (!bass) throw new Error("Bass visibility item is missing");
    await act(async () => bass.click());

    // Then Bass returns in session order without changing project data.
    await vi.waitFor(() => expect(host.querySelectorAll("[data-testid=pt-track-header]")).toHaveLength(3));
    expect(exec).not.toHaveBeenCalled();
  });

  it("distinguishes an all-hidden Edit Window from an empty session", () => {
    // Given every existing session track is hidden.
    ["vocal", "bass", "keys"].forEach((trackId) => {
      useProTools.getState().setTrackShown(trackId, false);
    });

    // When the Track List renders without a shown row.
    act(() => root.render(React.createElement(ProToolsTrackHeaders, { snapshot: SNAPSHOT })));

    // Then it explains that tracks are hidden and keeps the recovery menu enabled.
    expect(host.querySelectorAll("[data-testid=pt-track-header]")).toHaveLength(0);
    expect(host.querySelector("[role=status]")?.textContent).toBe("No tracks shown");
    expect(host.querySelector<HTMLButtonElement>("[data-testid=pt-track-visibility-menu]")?.disabled)
      .toBe(false);
  });

  it("shows only the selected Track Names", async () => {
    // Given Bass is the only selected Track Name.
    useStore.setState({ selectedTrackId: "bass" });
    useProTools.setState({ trackSelectionIds: ["bass"] });
    act(() => root.render(React.createElement(ProToolsTrackHeaders, { snapshot: SNAPSHOT })));

    // When Show Only Selected Tracks is picked from the Track List menu.
    const trigger = host.querySelector<HTMLButtonElement>("[data-testid=pt-track-visibility-menu]");
    if (!trigger) throw new Error("Track List visibility trigger is missing");
    await act(async () => trigger.click());
    const action = document.querySelector<HTMLButtonElement>(
      '[data-testid="pt-track-visibility-show-selected"]',
    );
    if (!action) throw new Error("Show Only Selected Tracks is missing");
    await act(async () => action.click());

    // Then only Bass remains in the Edit Window and no project command runs.
    const ids = [...host.querySelectorAll<HTMLElement>("[data-testid=pt-track-header]")]
      .map((header) => header.dataset.trackId);
    expect(ids).toEqual(["bass"]);
    expect(useProTools.getState().trackVisibility).toEqual({ vocal: false, keys: false });
    expect(exec).not.toHaveBeenCalled();
  });

  it("hides every selected Track Name as one view-state change", async () => {
    // Given Vocal and Keys are selected while every track is shown.
    useStore.setState({ selectedTrackId: "keys" });
    useProTools.setState({ trackSelectionIds: ["vocal", "keys"] });
    act(() => root.render(React.createElement(ProToolsTrackHeaders, { snapshot: SNAPSHOT })));

    // When Hide Selected Tracks is picked.
    const trigger = host.querySelector<HTMLButtonElement>("[data-testid=pt-track-visibility-menu]");
    if (!trigger) throw new Error("Track List visibility trigger is missing");
    await act(async () => trigger.click());
    const action = document.querySelector<HTMLButtonElement>(
      '[data-testid="pt-track-visibility-hide-selected"]',
    );
    if (!action) throw new Error("Hide Selected Tracks is missing");
    await act(async () => action.click());

    // Then Bass is the only shown row and the project command seam is untouched.
    const ids = [...host.querySelectorAll<HTMLElement>("[data-testid=pt-track-header]")]
      .map((header) => header.dataset.trackId);
    expect(ids).toEqual(["bass"]);
    expect(useProTools.getState().trackVisibility).toEqual({ vocal: false, keys: false });
    expect(exec).not.toHaveBeenCalled();
  });

  it("shows every track after a bulk visibility filter", async () => {
    // Given only Bass is shown.
    useProTools.setState({ trackVisibility: { vocal: false, keys: false } });
    act(() => root.render(React.createElement(ProToolsTrackHeaders, { snapshot: SNAPSHOT })));

    // When Show All Tracks is picked.
    const trigger = host.querySelector<HTMLButtonElement>("[data-testid=pt-track-visibility-menu]");
    if (!trigger) throw new Error("Track List visibility trigger is missing");
    await act(async () => trigger.click());
    const action = document.querySelector<HTMLButtonElement>(
      '[data-testid="pt-track-visibility-show-all"]',
    );
    if (!action) throw new Error("Show All Tracks is missing");
    await act(async () => action.click());

    // Then every ordered row returns and the canonical override map is empty.
    const ids = [...host.querySelectorAll<HTMLElement>("[data-testid=pt-track-header]")]
      .map((header) => header.dataset.trackId);
    expect(ids).toEqual(["vocal", "bass", "keys"]);
    expect(useProTools.getState().trackVisibility).toEqual({});
    expect(exec).not.toHaveBeenCalled();
  });

  it("hides all tracks while preserving the Track List recovery surface", async () => {
    // Given every session track is shown.
    act(() => root.render(React.createElement(ProToolsTrackHeaders, { snapshot: SNAPSHOT })));

    // When Hide All Tracks is picked.
    const trigger = host.querySelector<HTMLButtonElement>("[data-testid=pt-track-visibility-menu]");
    if (!trigger) throw new Error("Track List visibility trigger is missing");
    await act(async () => trigger.click());
    const action = document.querySelector<HTMLButtonElement>(
      '[data-testid="pt-track-visibility-hide-all"]',
    );
    if (!action) throw new Error("Hide All Tracks is missing");
    await act(async () => action.click());

    // Then the Edit bank is empty, every override is hidden, and Show All remains reachable.
    expect(host.querySelectorAll("[data-testid=pt-track-header]")).toHaveLength(0);
    expect(host.querySelector("[role=status]")?.textContent).toBe("No tracks shown");
    expect(useProTools.getState().trackVisibility)
      .toEqual({ vocal: false, bass: false, keys: false });
    expect(exec).not.toHaveBeenCalled();
  });

  it("keeps selection-dependent bulk actions inert without a Track Name selection", async () => {
    // Given the Edit Window has tracks but no selected Track Name.
    useStore.setState({ selectedTrackId: null });
    useProTools.setState({ trackSelectionIds: [] });
    act(() => root.render(React.createElement(ProToolsTrackHeaders, { snapshot: SNAPSHOT })));
    const trigger = host.querySelector<HTMLButtonElement>("[data-testid=pt-track-visibility-menu]");
    if (!trigger) throw new Error("Track List visibility trigger is missing");
    await act(async () => trigger.click());
    const action = document.querySelector<HTMLButtonElement>(
      '[data-testid="pt-track-visibility-hide-selected"]',
    );
    if (!action) throw new Error("Hide Selected Tracks is missing");

    // When the disabled action is activated programmatically.
    await act(async () => action.click());

    // Then no row or view state changes.
    expect(action.getAttribute("aria-disabled")).toBe("true");
    expect(host.querySelectorAll("[data-testid=pt-track-header]")).toHaveLength(3);
    expect(useProTools.getState().trackVisibility).toEqual({});
    expect(exec).not.toHaveBeenCalled();
  });
});
