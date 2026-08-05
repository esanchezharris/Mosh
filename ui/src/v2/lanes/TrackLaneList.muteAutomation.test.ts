// CAP-AUT-006 — the v2 track header's mute button follows its automation curve.
//
// muteState.test.ts pins the RULE; this pins that the shipped button is actually wired to
// the 30 Hz rail rather than to `track.mute` alone. Those are different failures: the
// helper can be perfect and the button still read the snapshot, which is exactly the state
// this button was in before — a curve could silence the track while the button sat open.
//
// Note what is deliberately NOT asserted here: that the rail carries the right values.
// That is the backend's job (MoshOps::muteAutomationAtPlayhead, pinned by --selftest
// seeking the transport across a real curve). Here the store is set directly, so this test
// cannot pass on a broken curve evaluation — it would just be testing nothing about it.

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

describe("v2 TrackLaneHeader — mute follows automation (CAP-AUT-006)", () => {
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
      muteAutomation: {},
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        execCalls.push({ command, args });
        return { ok: true, command };
      }),
    } as never);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ muteAutomation: {} } as never);
    vi.restoreAllMocks();
  });

  const render = (tracks: Track[]) =>
    act(() => { root.render(React.createElement(TrackLaneList, { snapshot: snap(tracks) })); });
  const muteBtn = () => host.querySelector<HTMLButtonElement>('button[aria-label^="Mute"]')!;
  const setRail = (m: Record<string, boolean>) =>
    act(() => { useStore.setState({ muteAutomation: m } as never); });

  it("an un-automated track's button is unchanged", () => {
    render([track()]);
    expect(muteBtn().className).toBe("m");
    expect(muteBtn().getAttribute("aria-pressed")).toBe("false");
    expect(muteBtn().getAttribute("aria-label")).toBe("Mute");
  });

  it("lights when the curve closes, and goes out again when it opens — without any snapshot change", () => {
    render([track()]);
    expect(muteBtn().className).not.toContain("on");

    setRail({ t1: true });
    expect(muteBtn().className, "a curve-muted track must not show an open button").toContain("on");

    setRail({ t1: false });
    expect(muteBtn().className, "the button has to come back when the curve reopens").not.toContain("on");
  });

  it("marks the button automated even while the curve is open", () => {
    render([track()]);
    setRail({ t1: false });
    expect(muteBtn().className).toContain("automated");
    expect(muteBtn().getAttribute("data-automated")).toBe("true");
    expect(muteBtn().getAttribute("aria-label")).toBe("Mute — automated");
  });

  it("says WHY it is lit when a curve is what lit it", () => {
    render([track()]);
    setRail({ t1: true });
    expect(muteBtn().getAttribute("aria-label")).toBe("Mute — muted by automation");
    expect(muteBtn().getAttribute("title")).toBe("Mute — muted by automation");
  });

  it("aria-pressed keeps describing the routing mute the click toggles", () => {
    render([track()]);
    setRail({ t1: true });
    expect(muteBtn().getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking still toggles the ROUTING mute, whatever the curve is doing", () => {
    render([track()]);
    setRail({ t1: true });
    act(() => { muteBtn().dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(execCalls).toEqual([{ command: "set_track_mute", args: { trackId: "t1", mute: true } }]);
  });

  it("a curve on another track does not touch this one", () => {
    render([track()]);
    setRail({ someoneElse: true });
    expect(muteBtn().className).toBe("m");
  });

  it("the rail emptying (curve deleted) releases the button", () => {
    render([track()]);
    setRail({ t1: true });
    expect(muteBtn().className).toContain("on");
    setRail({});
    expect(muteBtn().className).toBe("m");
  });
});
