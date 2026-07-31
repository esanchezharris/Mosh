// Bug guard: aux/return (bus) tracks are instrument-free carriers for sends — they hold
// no clips and belong on the mixer (see classic ui/Mixer.tsx's `!t.isReturn` filter), not
// as an empty lane in the arrangement. TrackLaneList renders every non-group snapshot
// track as a clip lane, so an `isReturn` track was leaking in as a phantom empty lane +
// header. Same createRoot + act render pattern as the sibling ClipView.test.ts.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrackLaneList } from "./TrackLaneList";
import { useStore } from "../../store";
import { useShell } from "../shellState";
import type { CommandResult, Snapshot, Track } from "../../types";

function audioTrack(): Track {
  return {
    id: "t1", logicalId: "lid-t1", index: 0, name: "Drums", type: "audio", clips: [],
  } as unknown as Track;
}
function midiTrack(): Track {
  return {
    id: "t1",
    logicalId: "lid-t1",
    index: 0,
    name: "Instrument",
    type: "instrument",
    clips: [{
      id: "midi-clip-1",
      name: "MIDI",
      type: "midi",
      start: 0,
      length: 4,
      offset: 0,
      hasRenderLayer: false,
      notes: [],
    }],
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
  const defaultExec = useStore.getState().exec;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useStore.setState({
      snapshot: null,
      selection: new Set<string>(),
      selectedTrackId: null,
      activeTrackId: null,
      mp: { active: false, roomCode: null, selfPeer: null, connected: false },
      exec: defaultExec,
    });
    useShell.setState({ selectedClipId: null });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      scale: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      globalAlpha: 1,
      fillStyle: "",
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
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

  it("clears clip context and moves the multiplayer claim when a different track header is clicked", async () => {
    await useStore.getState().syncActiveTrack();
    const first = midiTrack();
    const second = { ...audioTrack(), id: "t2", logicalId: "lid-t2", index: 1, name: "Hook" };
    const snapshot = makeSnapshot([first, second]);
    const exec = vi.fn(async (
      command: string,
      _args?: Record<string, unknown>,
    ): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({
      snapshot,
      selection: new Set(["midi-clip-1"]),
      selectedTrackId: first.id,
      activeTrackId: first.id,
      mp: { active: true, roomCode: "ROOM", selfPeer: "me", connected: true },
      exec,
    });
    useShell.setState({ selectedClipId: "midi-clip-1" });
    render([first, second]);

    const secondHeader = host.querySelector<HTMLElement>('[data-track-id="t2"]')!;
    await act(async () => {
      secondHeader.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await useStore.getState().syncActiveTrack();
    });

    expect(useStore.getState().selectedTrackId).toBe("t2");
    expect(useStore.getState().selection.size).toBe(0);
    expect(useStore.getState().activeTrackId).toBe("t2");
    expect(useShell.getState().selectedClipId).toBeNull();
    expect(exec.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ["mp_commit_track", { trackId: "t1" }],
      ["mp_claim_track", { trackId: "t2" }],
      ["mp_broadcast_selection", { trackId: "t2", clipId: null }],
    ]);
  });

  it.each(["Enter", " "])("clears the selected clip when a track header receives %s", (key) => {
    const first = audioTrack();
    const second = { ...audioTrack(), id: "t2", index: 1, name: "Hook" };
    useStore.setState({ selectedTrackId: first.id, selection: new Set(["midi-clip-1"]) });
    useShell.setState({ selectedClipId: "midi-clip-1" });
    render([first, second]);

    const secondHeader = host.querySelector<HTMLElement>('[data-track-id="t2"]')!;
    act(() => secondHeader.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));

    expect(useStore.getState().selectedTrackId).toBe("t2");
    expect(useStore.getState().selection.size).toBe(0);
    expect(useShell.getState().selectedClipId).toBeNull();
  });

  it.each([
    ["Mute", " "],
    ["Solo", "Enter"],
    ["Delete Hook", " "],
  ])("does not select the track when %s receives %s", (label, key) => {
    const first = audioTrack();
    const second = { ...audioTrack(), id: "t2", index: 1, name: "Hook" };
    useStore.setState({ selectedTrackId: first.id, selection: new Set(["midi-clip-1"]) });
    useShell.setState({ selectedClipId: "midi-clip-1" });
    render([first, second]);

    const nestedControl = host.querySelector<HTMLElement>(
      `[data-track-id="t2"] [aria-label="${label}"]`,
    )!;
    act(() => nestedControl.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));

    expect(useStore.getState().selectedTrackId).toBe(first.id);
    expect([...useStore.getState().selection]).toEqual(["midi-clip-1"]);
    expect(useShell.getState().selectedClipId).toBe("midi-clip-1");
  });
});
