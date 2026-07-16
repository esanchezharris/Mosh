import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import { Navigator, visibleNavigatorPeers } from "./Navigator";
import { useOpenLanes } from "./state";
import { visibleRange, type TimelineSnapshot } from "./timelineGeometry";

const SNAPSHOT: TimelineSnapshot = {
  session: { tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4 },
  tracks: [],
  sections: [{ id: "hook", name: "Hook", startBeat: 16, endBeat: 32, color: "#8aa6ff" }],
};

function NavigatorHarness() {
  const zoom = useOpenLanes((state) => state.zoom);
  const viewStartSec = useOpenLanes((state) => state.viewStartSec);
  return React.createElement(Navigator, { snapshot: SNAPSHOT, range: visibleRange(SNAPSHOT, zoom, viewStartSec) });
}

describe("Open Lanes navigator", () => {
  let host: HTMLDivElement;
  let root: Root;
  const execCalls: { command: string; args?: Record<string, unknown> }[] = [];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    execCalls.length = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useOpenLanes.setState({ zoom: 8, viewStartSec: 0 });
    useStore.setState({
      transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
      peers: {},
      peerPresence: {},
      exec: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        execCalls.push({ command, args });
        return { ok: true, command };
      }),
    });
    act(() => root.render(React.createElement(NavigatorHarness)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function navigator(): HTMLDivElement {
    const element = host.querySelector<HTMLDivElement>('[data-testid="v3-navigator"]');
    if (!element) throw new TypeError("navigator was not rendered");
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 24));
    return element;
  }

  function viewport(): HTMLDivElement {
    const element = host.querySelector<HTMLDivElement>('[data-testid="v3-nav-viewport"]');
    if (!element) throw new TypeError("navigator viewport was not rendered");
    return element;
  }

  it("seeks and centers the viewport when the overview background is pressed", () => {
    act(() => navigator().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 75, button: 0 })));
    expect(execCalls).toContainEqual({ command: "set_transport", args: { position: 24 } });
    expect(useOpenLanes.getState().viewStartSec).toBe(16);
  });

  it("drags the viewport without moving transport and stops after pointer release", () => {
    const track = navigator();
    const window = viewport();
    act(() => window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 25, button: 0, pointerId: 7 })));
    act(() => window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 75, pointerId: 7 })));
    expect(useOpenLanes.getState().viewStartSec).toBe(16);
    expect(execCalls).toEqual([]);

    act(() => window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 75, pointerId: 7 })));
    act(() => window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 10, pointerId: 7 })));
    expect(useOpenLanes.getState().viewStartSec).toBe(16);
    expect(track).toBeTruthy();
  });

  it("seeks on a short viewport click, including when Full covers the navigator", () => {
    act(() => useOpenLanes.getState().setZoom("full"));
    const track = navigator();
    const window = viewport();
    act(() => window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 75, button: 0, pointerId: 4 })));
    act(() => window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 75, pointerId: 4 })));
    expect(execCalls).toContainEqual({ command: "set_transport", args: { position: 24 } });
    expect(track).toBeTruthy();
  });

  it("clamps keyboard navigation at the song edges", () => {
    const window = viewport();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "End" })));
    expect(useOpenLanes.getState().viewStartSec).toBe(16);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })));
    expect(useOpenLanes.getState().viewStartSec).toBe(16);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Home" })));
    expect(useOpenLanes.getState().viewStartSec).toBe(0);
  });

  it("seeks transport with Shift plus navigation keys", () => {
    const window = viewport();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight", shiftKey: true })));
    expect(execCalls).toContainEqual({ command: "set_transport", args: { position: 1.6 } });
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "End", shiftKey: true })));
    expect(execCalls).toContainEqual({ command: "set_transport", args: { position: 32 } });
    expect(useOpenLanes.getState().viewStartSec).toBe(16);
  });

  it("renders named sections from the snapshot", () => {
    expect(host.querySelector('[title="Hook"]')?.textContent).toContain("Hook");
  });

  it("filters offline and expired peer beads", () => {
    const now = 20_000;
    const visible = visibleNavigatorPeers(
      {
        fresh: { position: 8, playing: true, recording: false, updatedAtMs: 15_000 },
        expired: { position: 4, playing: false, recording: false, updatedAtMs: 5_000 },
        offline: { position: 2, playing: false, recording: false, updatedAtMs: 19_000 },
      },
      {
        fresh: { name: "Ari", color: "#f06a8b", online: true },
        expired: { name: "Bea", color: "#8aa6ff", online: true },
        offline: { name: "Cam", color: "#66d4a3", online: false },
      },
      now,
    );
    expect(visible.map((peer) => peer.id)).toEqual(["fresh"]);
  });

  it("removes a peer bead when its eight-second presence lease expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    act(() => useStore.setState({
      peers: { fresh: { name: "Ari", color: "#f06a8b", online: true } },
      peerPresence: { fresh: { position: 8, playing: true, recording: false, updatedAtMs: 10_000 } },
    }));
    expect(host.querySelectorAll('[data-testid="v3-nav-peer"]')).toHaveLength(1);

    await act(async () => vi.advanceTimersByTimeAsync(8_001));
    expect(host.querySelectorAll('[data-testid="v3-nav-peer"]')).toHaveLength(0);
  });

  it("reschedules cleanup for staggered peer presence leases", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    act(() => useStore.setState({
      peers: {
        first: { name: "Ari", color: "#f06a8b", online: true },
        second: { name: "Bea", color: "#8aa6ff", online: true },
      },
      peerPresence: {
        first: { position: 8, playing: true, recording: false, updatedAtMs: 8_000 },
        second: { position: 16, playing: false, recording: true, updatedAtMs: 10_000 },
      },
    }));
    expect(host.querySelectorAll('[data-testid="v3-nav-peer"]')).toHaveLength(2);

    await act(async () => vi.advanceTimersByTimeAsync(6_001));
    expect(host.querySelectorAll('[data-testid="v3-nav-peer"]')).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(host.querySelectorAll('[data-testid="v3-nav-peer"]')).toHaveLength(0);
  });
});
