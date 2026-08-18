// UI-REACH — "Set up iPhone controller". The only route to phone pairing used to be
// the topbar "iPhone" popover, which is nowhere near the track you are about to sing
// on. Right-clicking a track header now opens a context menu that starts pairing and
// shows the scannable QR.
//
// Same createRoot + act pattern as the sibling removeTrack test. The store's
// startRemotePairing is faked so the test asserts the dialog actually drives the real
// store action (not just that a dialog appeared), and remoteStatus is fed the shape
// the native bridge returns.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrackLaneList } from "./TrackLaneList";
import { useStore } from "../../store";
import type { Snapshot, Track } from "../../types";

function track(over: Partial<Track> = {}): Track {
  return {
    id: "t1", index: 0, name: "VOX", type: "audio",
    volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], ...over,
  } as unknown as Track;
}
function makeSnapshot(tracks: Track[]): Snapshot {
  return { schemaVersion: 1, session: {}, tracks } as unknown as Snapshot;
}

describe("v2 TrackLaneHeader — Set up iPhone controller", () => {
  let host: HTMLDivElement;
  let root: Root;
  let startCalls = 0;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    startCalls = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      remoteStatus: null,
      startRemotePairing: vi.fn(async () => { startCalls += 1; }),
      stopRemote: vi.fn(async () => {}),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.querySelectorAll('[data-testid="v2-track-ctx-scrim"], [data-testid="v2-iphone-scrim"]').forEach((n) => n.remove());
  });

  function render(tracks: Track[]) {
    act(() => { root.render(React.createElement(TrackLaneList, { snapshot: makeSnapshot(tracks) })); });
  }

  function openMenu() {
    const header = host.querySelector<HTMLElement>('[data-testid="v2-track-header"]')!;
    act(() => header.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 80 })));
  }

  it("right-clicking a track header opens a context menu with the iPhone item", () => {
    render([track()]);
    expect(document.querySelector('[data-testid="v2-track-ctx"]'), "menu must not exist before right-click").toBeNull();
    openMenu();
    const menu = document.querySelector('[data-testid="v2-track-ctx"]');
    expect(menu).not.toBeNull();
    expect(menu!.textContent).toContain("Set up iPhone controller");
  });

  it("picking it starts pairing and opens the dialog", () => {
    render([track()]);
    openMenu();
    const item = document.querySelector<HTMLButtonElement>('[data-testid="v2-track-ctx-iphone"]')!;
    act(() => item.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(startCalls, "the dialog must drive the real store action").toBe(1);
    expect(document.querySelector('[data-testid="v2-iphone-dialog"]')).not.toBeNull();
    // No pairing yet — the dialog reports it is waiting rather than showing a blank QR.
    expect(document.querySelector('[data-testid="v2-iphone-status"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="v2-track-ctx"]'), "menu closes behind the dialog").toBeNull();
  });

  it("renders the SAFARI url once pairing lands, never the mosh:// deep link", () => {
    render([track()]);
    openMenu();
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="v2-track-ctx-iphone"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })));

    act(() => {
      useStore.setState({
        remoteStatus: {
          running: true,
          port: 47873,
          pairing: {
            host: "192.168.1.80", port: 47873, token: "tok123456", expiresAtMs: 1,
            pairingUrl: "mosh://pair?payload=AAA",
            webUrl: "http://192.168.1.80:47873/web?payload=AAA",
          },
        },
      });
    });

    const url = document.querySelector('[data-testid="v2-iphone-url"]')!;
    // A mosh:// QR is unopenable on a phone without the native companion app — the
    // whole point of this surface is the no-install Safari pad.
    expect(url.textContent).toBe("http://192.168.1.80:47873/web?payload=AAA");
    expect(document.querySelector('[data-testid="v2-iphone-dialog"]')!.textContent).not.toContain("mosh://");
  });
});
