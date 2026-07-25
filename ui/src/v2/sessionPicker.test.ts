import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionPicker, shouldShowSessionPicker, visibleTrackCount } from "./SessionPicker";
import { useStore } from "../store";
import { useShell } from "./shellState";
import type { Snapshot, Track } from "../types";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return {
    ...actual,
    onEvent: vi.fn(() => () => {}),
    pickFiles: vi.fn(),
    pickSaveFile: vi.fn(),
    brainChat: vi.fn(),
    // The picker is gated on being inside the real JUCE WebView. Force it on so the
    // component can be driven at all — this IS the gate, so it must be faked explicitly
    // rather than left to chance.
    isRealNative: () => true,
  };
});

const track = (id: string, extra: Partial<Track> = {}): Track => ({
  id, index: 0, name: id, volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], ...extra,
} as unknown as Track);

function snap(over: Partial<Snapshot["session"]> = {}, tracks: Track[] = [track("t1"), track("t2")]): Snapshot {
  return {
    schemaVersion: 1,
    session: {
      sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
      metronome: false, length: 16, editFile: "/mock/session.mosh",
      key: { tonic: "A", mode: "minor" },
      recentProjects: [
        { path: "/mock/session.mosh", name: "session" },   // the CURRENT project
        { path: "/mock/late-night.mosh", name: "late-night" },
        { path: "/mock/demo-2.mosh", name: "demo-2" },
      ],
      ...over,
    },
    tracks,
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    master: { volumeDb: 0, pan: 0 },
  } as unknown as Snapshot;
}

describe("shouldShowSessionPicker", () => {
  it("shows once a snapshot has arrived and nothing else owns the screen", () => {
    expect(shouldShowSessionPicker(snap(), false, true)).toBe(true);
  });

  it("stays hidden when not eligible (every test and every non-WebView run)", () => {
    expect(shouldShowSessionPicker(snap(), false, false)).toBe(false);
  });

  it("stays hidden once dismissed", () => {
    expect(shouldShowSessionPicker(snap(), true, true)).toBe(false);
  });

  it("stays hidden before the first snapshot", () => {
    expect(shouldShowSessionPicker(null, false, true)).toBe(false);
  });

  it("yields to a refused-format load error", () => {
    // Offering to "continue" into an edit the engine declined to load would be a lie.
    expect(shouldShowSessionPicker(snap({ loadError: "newer format" }), false, true)).toBe(false);
  });

  it("yields to the crash-recovery notice", () => {
    // That notice is a decision about THIS project and has to be answered first.
    expect(shouldShowSessionPicker(snap({ recoveryAvailable: true }), false, true)).toBe(false);
  });
});

describe("visibleTrackCount", () => {
  it("counts tracks the way the ARRANGEMENT does", () => {
    // The number on the Continue button is the number the user is about to see, so it
    // must use TrackLaneList's filter — buses/returns and group folders are real tracks
    // but never render as lanes.
    const tracks = [track("a"), track("bus", { isReturn: true }), track("folder", { isGroup: true }), track("b")];
    expect(visibleTrackCount(snap({}, tracks))).toBe(2);
  });
});

describe("SessionPicker", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  const mount = (s: Snapshot = snap()) => {
    useStore.setState({ snapshot: s, exec, refresh: vi.fn(async () => {}) });
    act(() => root.render(React.createElement(SessionPicker)));
  };
  const click = (testId: string) => {
    const el = host.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
    if (!el) throw new Error(`no [data-testid="${testId}"]`);
    act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async () => ({ ok: true }));
    useShell.setState({ sessionPickerDismissed: false });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("renders the track count using the arrangement's own filter", () => {
    mount(snap({}, [track("a"), track("bus", { isReturn: true }), track("b"), track("c")]));
    expect(host.textContent).toContain("3 tracks");
  });

  it("singularises a one-track session", () => {
    mount(snap({}, [track("a")]));
    expect(host.textContent).toContain("1 track");
    expect(host.textContent).not.toContain("1 tracks");
  });

  it("Continue dispatches NO command and just dismisses", () => {
    mount();
    click("v2-picker-continue");
    expect(exec, "Continue must not touch the backend — the edit is already loaded").not.toHaveBeenCalled();
    expect(useShell.getState().sessionPickerDismissed).toBe(true);
  });

  it("Start empty dispatches new_project", () => {
    mount();
    click("v2-picker-new");
    expect(exec).toHaveBeenCalledWith("new_project");
  });

  it("omits the CURRENT project from Recent (it is already Continue)", () => {
    mount();
    const rows = [...host.querySelectorAll('[data-testid="v2-picker-recent"]')].map((e) => e.textContent);
    expect(rows).toEqual(["late-night", "demo-2"]);
  });

  it("opens a recent by its ORIGINAL index, not its rendered position", () => {
    // The current project is filtered out of the rendered list, so the first ROW is the
    // second ENTRY. open_recent resolves the index against the backend's list — passing
    // the rendered position would silently reopen the wrong project.
    mount();
    click("v2-picker-recent");
    expect(exec).toHaveBeenCalledWith("open_recent", { index: 1 });
  });
});
