import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store";
import type { Snapshot } from "../types";
import { useShell } from "../v2/shellState";
import { ProToolsEditSelectionOverlay } from "./ProToolsEditSelectionOverlay";
import { useProTools } from "./proToolsState";

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-track-edit-link.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [{
    id: "drums",
    index: 0,
    name: "Drums",
    type: "drum",
    clips: [],
  }, {
    id: "vocal",
    index: 1,
    name: "Vocal",
    type: "audio",
    clips: [],
  }],
  transport: {
    playing: false,
    recording: false,
    position: 0,
    looping: false,
    loopStart: 0,
    loopEnd: 0,
  },
};

describe("Pro Tools Edit selection track scope", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({ selectedTrackId: "vocal", pxPerSec: 80 });
    useShell.setState({ timeRange: { start: 2, end: 6 }, timeRangeDragging: false });
    useProTools.getState().resetForProject(useProTools.getState().projectEpoch + 1);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ selectedTrackId: null });
    useShell.setState({ timeRange: null, timeRangeDragging: false });
  });

  it("bounds a linked Edit range to the selected track row", () => {
    // Given the Vocal track is active in the default linked state.
    act(() => root.render(React.createElement(ProToolsEditSelectionOverlay, { snapshot: SNAPSHOT })));

    // When the shared Edit range is rendered.
    const overlay = host.querySelector<HTMLElement>("[data-testid=pt-edit-selection]");
    if (!overlay) throw new Error("Edit selection overlay is missing");

    // Then it starts after the Drums row and covers only the Vocal row.
    expect(overlay.dataset.trackId).toBe("vocal");
    expect(overlay.style.top).toBe("calc(var(--pt-track-title-h) + 92px)");
    expect(overlay.style.height).toBe("92px");
    expect(overlay.style.bottom).toBe("auto");
  });

  it("spans every contiguous track associated with a vertical Edit range", () => {
    // Given both visible tracks own the linked Edit range.
    useProTools.setState({
      editSelectionTrackId: "vocal",
      editSelectionTrackIds: ["drums", "vocal"],
      trackSelectionIds: ["drums", "vocal"],
    });

    // When the shared Edit range is rendered.
    act(() => root.render(React.createElement(ProToolsEditSelectionOverlay, { snapshot: SNAPSHOT })));
    const overlay = host.querySelector<HTMLElement>("[data-testid=pt-edit-selection]");
    if (!overlay) throw new Error("Edit selection overlay is missing");

    // Then one band covers the complete contiguous lane set, in visible order.
    expect(overlay.dataset.trackIds).toBe("drums vocal");
    expect(overlay.style.top).toBe("calc(var(--pt-track-title-h) + 0px)");
    expect(overlay.style.height).toBe("184px");
  });

  it("retains its Edit track while header selection is independently unlinked", () => {
    // Given Vocal owns the Edit range when Track/Edit is disabled.
    act(() => {
      useProTools.getState().setEditSelectionTrackId("vocal");
      useProTools.getState().setTrackEditLinked(false);
      useStore.setState({ selectedTrackId: "drums" });
      root.render(React.createElement(ProToolsEditSelectionOverlay, { snapshot: SNAPSHOT }));
    });

    // When the overlay resolves its associated row.
    const overlay = host.querySelector<HTMLElement>("[data-testid=pt-edit-selection]");

    // Then the selected Drums header does not move the Vocal Edit range.
    expect(overlay?.dataset.trackId).toBe("vocal");
    expect(overlay?.style.top).toBe("calc(var(--pt-track-title-h) + 92px)");
  });
});
