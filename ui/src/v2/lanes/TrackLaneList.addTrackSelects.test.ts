// Final-review finding 2: Add track → <kind> used to discard create_track's result and
// never select the new track, so the Inspector kept pointing at whatever track was
// selected before. Consequences this pins:
//   - the Instrument kind's whole justification for landing bare ("the Inspector's
//     instrument slot now asks instead") never fired on the primary path, because the
//     slot was showing the WRONG track;
//   - the add-track menu previews the "keys" glyph for Instrument (iconArgsForKind) but
//     the bare track that lands is unselected, so nothing on screen confirms it landed
//     at all, let alone with the right glyph.
//
// addTrackOfKind itself stays React-free (trackKinds.test.ts drives it directly with a
// bare recording exec) — the selection/tab-switch behaviour lives in AddTrackMenu.pick,
// the calling component, and is covered here at that level.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrackLaneList } from "./TrackLaneList";
import { useStore } from "../../store";
import { useShell } from "../shellState";
import type { CommandResult, Snapshot, Track } from "../../types";

function track(over: Partial<Track> = {}): Track {
  return {
    id: "t1", index: 0, name: "Existing", type: "audio",
    volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], ...over,
  } as unknown as Track;
}
function makeSnapshot(tracks: Track[]): Snapshot {
  return { schemaVersion: 1, session: {}, tracks } as unknown as Snapshot;
}

describe("v2 add-track menu — selects the track it creates (finding 2)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let execCalls: { command: string; args?: Record<string, unknown> }[];
  let nextTrackId: string;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    execCalls = [];
    nextTrackId = "new-track-id";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      selectedTrackId: "t1", // an EXISTING, different track is selected beforehand
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        execCalls.push({ command, args });
        if (command === "create_track") return { ok: true, command, data: { trackId: nextTrackId } };
        return { ok: true, command };
      }),
    });
    useShell.setState({ inspectorTab: "mix" });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render() {
    act(() => { root.render(React.createElement(TrackLaneList, { snapshot: makeSnapshot([track()]) })); });
  }

  // Drives the "row" trailing add-track trigger (v2-track-add), opens the menu, and
  // clicks the given kind's row — same DOM path a mouse-only producer uses.
  async function addTrack(kind: string) {
    const addBtn = host.querySelector<HTMLButtonElement>('[data-testid="v2-track-add"]')!;
    await act(async () => { addBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const kindBtn = document.querySelector<HTMLButtonElement>(`[data-testid="v2-track-add-${kind}"]`)!;
    await act(async () => { kindBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  }

  it("Add track → Audio selects the newly created track", async () => {
    render();
    await addTrack("audio");
    expect(execCalls).toEqual([{ command: "create_track", args: { name: "Audio" } }]);
    expect(useStore.getState().selectedTrackId).toBe("new-track-id");
  });

  it("Add track → Drums selects the newly created track", async () => {
    render();
    await addTrack("drum");
    expect(useStore.getState().selectedTrackId).toBe("new-track-id");
  });

  it("Add track → Test tone selects the newly created track (not left on the previous one)", async () => {
    render();
    await addTrack("tone");
    expect(execCalls.map((c) => c.command)).toEqual(["create_track", "add_test_tone_clip"]);
    expect(useStore.getState().selectedTrackId).toBe("new-track-id");
  });

  it("Add track → Instrument selects the new track AND flips the Inspector to FX, so the empty slot is on screen", async () => {
    render();
    expect(useShell.getState().inspectorTab).toBe("mix"); // sanity: not already fx
    await addTrack("midi");
    expect(execCalls).toEqual([{ command: "create_track", args: { name: "Instrument" } }]);
    expect(useStore.getState().selectedTrackId).toBe("new-track-id");
    expect(useShell.getState().inspectorTab).toBe("fx");
  });

  it("a non-Instrument kind does NOT force the Inspector tab (only midi does)", async () => {
    render();
    useShell.setState({ inspectorTab: "gen" });
    await addTrack("audio");
    expect(useShell.getState().inspectorTab).toBe("gen");
  });

  it("a failed create_track selects nothing (no trackId to select)", async () => {
    useStore.setState({
      exec: vi.fn(async (command: string): Promise<CommandResult> => {
        execCalls.push({ command });
        return { ok: false, command, error: "boom" };
      }),
    });
    render();
    await addTrack("audio");
    expect(useStore.getState().selectedTrackId).toBe("t1"); // unchanged
  });
});
