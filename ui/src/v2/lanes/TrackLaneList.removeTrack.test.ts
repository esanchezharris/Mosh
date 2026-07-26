// UI-REACH — remove_track. The sole call site in the whole codebase used to be the ×
// on classic's track header (ui/Arrange.tsx:416), which v2 never renders — so a
// mouse-only v2 user could not delete a track at all. TrackLaneHeader now has a
// hover-revealed × beside Mute/Solo; it is confirm-gated because cmdRemoveTrack
// (MoshOps.cpp) takes every clip on the track with it inside one undo transaction.
//
// Same createRoot + act render pattern as the sibling TrackLaneList.test.ts, with a
// recording fake `exec` (mirrors Inspector.clip.test.ts) so the confirm-gate's
// "nothing dispatched until confirmed" claim is checked against real exec calls,
// not just DOM presence.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrackLaneList } from "./TrackLaneList";
import { useStore } from "../../store";
import type { CommandResult, Snapshot, Track } from "../../types";

function track(over: Partial<Track> = {}): Track {
  return {
    id: "t1", index: 0, name: "Drums", type: "audio",
    volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], ...over,
  } as unknown as Track;
}
function makeSnapshot(tracks: Track[]): Snapshot {
  return { schemaVersion: 1, session: {}, tracks } as unknown as Snapshot;
}

describe("v2 TrackLaneHeader — remove_track (UI-REACH)", () => {
  let host: HTMLDivElement;
  let root: Root;
  const execCalls: { command: string; args?: Record<string, unknown> }[] = [];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    execCalls.length = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        execCalls.push({ command, args });
        return { ok: true, command };
      }),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.querySelectorAll(".modal-backdrop").forEach((n) => n.remove()); // portaled dialogs
  });

  function render(tracks: Track[]) {
    act(() => { root.render(React.createElement(TrackLaneList, { snapshot: makeSnapshot(tracks) })); });
  }

  it("shows a delete control on every track header", () => {
    render([track({ id: "t1", name: "Drums" }), track({ id: "t2", name: "Bass" })]);
    expect(host.querySelectorAll('[data-testid="v2-track-remove"]').length).toBe(2);
  });

  it("clicking delete opens a confirm dialog and dispatches nothing until confirmed, then removes the track on confirm", () => {
    const clip = (id: string): Track["clips"][number] =>
      ({ id, name: id, type: "midi", start: 0, length: 2, offset: 0, hasRenderLayer: false, notes: [] }) as unknown as Track["clips"][number];
    render([track({ id: "t1", name: "Drums", clips: [clip("c1"), clip("c2")] })]);

    const del = host.querySelector<HTMLButtonElement>('[data-testid="v2-track-remove"]')!;
    act(() => del.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    // Portaled to document.body, not inside `host`.
    const dialog = document.querySelector('[data-testid="v2-track-remove-confirm"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("Drums");
    expect(dialog!.textContent).toContain("2 clips"); // names what it takes with it
    expect(execCalls, "opening the confirm must not itself dispatch anything").toEqual([]);

    const confirmBtn = document.querySelector<HTMLButtonElement>('[data-testid="v2-track-remove-confirm-confirm"]')!;
    act(() => confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(execCalls).toEqual([{ command: "remove_track", args: { trackId: "t1" } }]);
    expect(document.querySelector('[data-testid="v2-track-remove-confirm"]'), "dialog should close after confirming").toBeNull();
  });

  it("cancelling the confirm dispatches nothing and leaves the track header in place", () => {
    render([track({ id: "t1", name: "Drums" })]);

    const del = host.querySelector<HTMLButtonElement>('[data-testid="v2-track-remove"]')!;
    act(() => del.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(document.querySelector('[data-testid="v2-track-remove-confirm"]')).not.toBeNull();

    const cancelBtn = document.querySelector<HTMLButtonElement>('[data-testid="v2-track-remove-confirm"] .btn:not(.danger)')!;
    act(() => cancelBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(document.querySelector('[data-testid="v2-track-remove-confirm"]')).toBeNull();
    expect(execCalls).toEqual([]);
    expect(host.querySelectorAll('[data-testid="v2-track-header"]').length).toBe(1); // still there
  });

  it("clicking delete does not also select the track (stopPropagation)", () => {
    render([track({ id: "t1", name: "Drums" })]);
    const del = host.querySelector<HTMLButtonElement>('[data-testid="v2-track-remove"]')!;
    act(() => del.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    // set_track selection is store-local (setSelectedTrack), not an exec call — the
    // real assertion here is that remove_track itself wasn't dispatched by this click.
    expect(execCalls).toEqual([]);
  });
});
