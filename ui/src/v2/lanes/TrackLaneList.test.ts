// Bug guard: aux/return (bus) tracks are instrument-free carriers for sends — they hold
// no clips and belong on the mixer (see classic ui/Mixer.tsx's `!t.isReturn` filter), not
// as an empty lane in the arrangement. TrackLaneList renders every non-group snapshot
// track as a clip lane, so an `isReturn` track was leaking in as a phantom empty lane +
// header. Same createRoot + act render pattern as the sibling ClipView.test.ts.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TrackLaneList } from "./TrackLaneList";
import { useStore } from "../../store";
import { useShell } from "../shellState";
import type { Snapshot, Track } from "../../types";

function audioTrack(): Track {
  return {
    id: "t1", index: 0, name: "Drums", type: "audio", clips: [],
  } as unknown as Track;
}
function returnTrack(): Track {
  return {
    id: "t2", index: 1, name: "Reverb Bus", type: "audio", clips: [],
    isReturn: true, returnBus: 0,
  } as unknown as Track;
}
function makeSnapshot(tracks: Track[]): Snapshot {
  return { schemaVersion: 1, session: {}, tracks } as unknown as Snapshot;
}

describe("v2 TrackLaneList — aux/return tracks excluded from the arrangement", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useStore.setState({ selectedTrackId: null });
    useShell.setState({ selectedClipId: null });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(tracks: Track[]) {
    act(() => {
      root.render(React.createElement(TrackLaneList, { snapshot: makeSnapshot(tracks) }));
    });
  }

  it("renders a lane + header for a normal audio track, but not for an isReturn bus track", () => {
    render([audioTrack(), returnTrack()]);

    const headers = host.querySelectorAll('[data-testid="v2-track-header"]');
    const lanes = host.querySelectorAll('[data-testid="v2-lane"]');

    expect(headers.length).toBe(1);
    expect(lanes.length).toBe(1);
    expect(headers[0].getAttribute("data-track-id")).toBe("t1");
    expect(lanes[0].getAttribute("data-track-id")).toBe("t1");

    // The bus track must not surface anywhere in the arrangement DOM.
    expect(host.querySelector('[data-track-id="t2"]')).toBeNull();
  });

  it("shows the empty-arrangement state when only a return track exists (no clip-lane-worthy tracks)", () => {
    render([returnTrack()]);

    expect(host.querySelector('[data-testid="v2-empty"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="v2-lane"]').length).toBe(0);
    expect(host.querySelectorAll('[data-testid="v2-track-header"]').length).toBe(0);
  });

  it("clears the selected clip when a different track header is clicked", () => {
    const first = audioTrack();
    const second = { ...audioTrack(), id: "t2", index: 1, name: "Hook" };
    useStore.setState({ selectedTrackId: first.id });
    useShell.setState({ selectedClipId: "midi-clip-1" });
    render([first, second]);

    const secondHeader = host.querySelector<HTMLElement>('[data-track-id="t2"]')!;
    act(() => secondHeader.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(useStore.getState().selectedTrackId).toBe("t2");
    expect(useShell.getState().selectedClipId).toBeNull();
  });

  it.each(["Enter", " "])("clears the selected clip when a track header receives %s", (key) => {
    const first = audioTrack();
    const second = { ...audioTrack(), id: "t2", index: 1, name: "Hook" };
    useStore.setState({ selectedTrackId: first.id });
    useShell.setState({ selectedClipId: "midi-clip-1" });
    render([first, second]);

    const secondHeader = host.querySelector<HTMLElement>('[data-track-id="t2"]')!;
    act(() => secondHeader.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));

    expect(useStore.getState().selectedTrackId).toBe("t2");
    expect(useShell.getState().selectedClipId).toBeNull();
  });

  it.each([
    ["Mute", " "],
    ["Solo", "Enter"],
    ["Delete Hook", " "],
  ])("does not select the track when %s receives %s", (label, key) => {
    const first = audioTrack();
    const second = { ...audioTrack(), id: "t2", index: 1, name: "Hook" };
    useStore.setState({ selectedTrackId: first.id });
    useShell.setState({ selectedClipId: "midi-clip-1" });
    render([first, second]);

    const nestedControl = host.querySelector<HTMLElement>(
      `[data-track-id="t2"] [aria-label="${label}"]`,
    )!;
    act(() => nestedControl.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));

    expect(useStore.getState().selectedTrackId).toBe(first.id);
    expect(useShell.getState().selectedClipId).toBe("midi-clip-1");
  });
});
