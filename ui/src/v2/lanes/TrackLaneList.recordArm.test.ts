// REC-002 — record-arm on the track header.
//
// This is not a convenience duplicate of the transport's auto-arm. Arming is what makes a
// note played on the computer keyboard RECORDABLE at all (audition_note only takes the
// engine's input path on an armed track), and before this button the only way to arm was
// to press Record — which made Capture MIDI, whose entire premise is that you were NOT
// recording, unreachable for the QWERTY keyboard.
//
// Same createRoot + act pattern as the sibling TrackLaneList tests, with a recording fake
// exec so the dispatched args are checked rather than just DOM presence.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrackLaneList } from "./TrackLaneList";
import { useStore } from "../../store";
import type { CommandResult, Snapshot, Track } from "../../types";

function track(over: Partial<Track> = {}): Track {
  return {
    id: "t1", index: 0, name: "Keys", type: "audio",
    volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], ...over,
  } as unknown as Track;
}
const snap = (tracks: Track[]) => ({ schemaVersion: 1, session: {}, tracks } as unknown as Snapshot);

describe("v2 TrackLaneHeader — record-arm (REC-002)", () => {
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
    vi.restoreAllMocks();
  });

  const render = (tracks: Track[]) =>
    act(() => { root.render(React.createElement(TrackLaneList, { snapshot: snap(tracks) })); });
  // Deliberately NOT scoped to .v2-ms: the "sits outside the select button" test below
  // asserts WHERE this button lives, and a selector that already assumed the answer
  // would make that check circular (it was, at first — a sabotage that moved the button
  // into the select button passed, because the scoped selector simply never found it).
  const armBtn = (i = 0) =>
    host.querySelectorAll<HTMLButtonElement>('button[aria-label="Record-arm"]')[i];

  it("every track header offers record-arm", () => {
    render([track({ id: "t1" }), track({ id: "t2", name: "Bass" })]);
    expect(host.querySelectorAll('.v2-ms button[aria-label="Record-arm"]').length).toBe(2);
  });

  it("arms the track it belongs to — not the selected one", () => {
    render([track({ id: "t1" }), track({ id: "t2", name: "Bass" })]);
    act(() => armBtn(1).dispatchEvent(new MouseEvent("click", { bubbles: true })));
    // t2, because the button's own track decides. Asserting the full call list, not a
    // subset: a stray set_track_solo or a second arm would slip past toContainEqual.
    expect(execCalls).toEqual([{ command: "arm_track", args: { trackId: "t2", armed: true } }]);
  });

  it("an armed track offers to DISarm rather than arming again", () => {
    render([track({ id: "t1", armed: true } as Partial<Track>)]);
    expect(armBtn().getAttribute("aria-pressed")).toBe("true");
    act(() => armBtn().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(execCalls).toEqual([{ command: "arm_track", args: { trackId: "t1", armed: false } }]);
  });

  it("shows armed state, and says why arming matters", () => {
    render([track({ id: "t1", armed: true } as Partial<Track>)]);
    expect(armBtn().className).toContain("on");
    // The tooltip is the only place a producer learns that arming is what makes the
    // computer keyboard recordable — without it the button reads as record-only.
    expect(armBtn().getAttribute("title")).toMatch(/recorded or captured/i);
  });

  it("sits OUTSIDE the select button, so arming cannot also re-select the track", () => {
    render([track({ id: "t1" })]);
    // Structural, not behavioural, and deliberately so: a first version of this test
    // clicked the button and asserted no extra exec call, which could not fail —
    // selection is UI-local state (a prime directive), so it dispatches no command and
    // there was nothing to observe. It survived a sabotage that deleted stopPropagation
    // outright. What actually keeps the two apart is that they are SIBLINGS; nesting the
    // arm button inside .v2-lhead-select is the change that would break it, and this
    // catches exactly that.
    const select = host.querySelector<HTMLElement>(".v2-lhead-select")!;
    expect(select.contains(armBtn())).toBe(false);
  });
});
