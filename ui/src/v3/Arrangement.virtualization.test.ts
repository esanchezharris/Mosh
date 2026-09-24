import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Arrangement } from "./Arrangement";
import { useStore } from "../store";
import { useTaskStore } from "../agent/loop/taskStore";
import type { CommandResult, Snapshot } from "../types";

// FINDINGS.md ("New (minor)", 2026-09-23 retest, real-app-walkthrough): once the playhead ran on
// to ~bar 550 (transport left playing without Loop), the V3 timeline rendered grid/ruler marks
// for the WHOLE content width regardless of scroll position — thousands of DOM/AX nodes — and a
// macOS accessibility walk of the window timed out on the node count alone (CPU stayed idle).
// This pins the fix at the component level: a long session mounts a small, bounded node count no
// matter where the scroll sits, and scrolling to the end still reveals the last bar's label (the
// window follows scroll, it doesn't just clip the first screenful forever).

vi.mock("../bridge", async (original) => ({ ...await original<typeof import("../bridge")>(), onEvent: vi.fn(() => () => {}) }));

// 550 bars at 120 BPM, 4/4: 550 * 4 beats / 2 beats-per-sec = 1100 seconds.
const LONG_SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: { key: { tonic: "A", mode: "minor" }, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, sampleRate: 48000, length: 1100, editFile: "long.mosh", countInBars: 0 },
  tracks: [
    { id: "drums", index: 0, name: "Drums", type: "audio", clips: [] },
    { id: "keys", index: 1, name: "Keys", type: "midi", clips: [] },
  ],
  transport: { playing: false, recording: false, looping: false, position: 0, loopStart: 0, loopEnd: 4 },
};

describe("V3 Arrangement renders only the visible grid/ruler range on a long session", () => {
  let host: HTMLDivElement;
  let root: Root;
  const original = useStore.getState();
  const exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    exec.mockClear();
    useStore.setState({
      snapshot: LONG_SNAPSHOT, selection: new Set(), selectedTrackId: null, editingClipId: null,
      exec, ensurePeaks: vi.fn(), agentBusy: false, pxPerSec: 80,
    });
    useTaskStore.setState({ current: null, signal: null });
  });
  afterEach(() => {
    act(() => root.unmount()); host.remove();
    useStore.setState(original);
    useTaskStore.setState({ current: null, signal: null });
  });

  // Every rendered grid tick (one per track lane) plus every rendered ruler mark. Before the
  // fix this was `beats * (tracks + 1)` — with 2200 beats and 2 tracks, 6600 nodes just here.
  const gridAndRulerNodeCount = () =>
    host.querySelectorAll('[data-testid="v3-lane-grid"] i, [data-testid="v3-ruler"] .rmark').length;

  it("mounts a small, bounded node count at the start of a 550-bar session, not the whole width", () => {
    act(() => root.render(React.createElement(Arrangement, { snapshot: LONG_SNAPSHOT })));
    const count = gridAndRulerNodeCount();
    expect(count).toBeGreaterThan(0);     // anti-vacuity: the grid isn't just suppressed entirely
    expect(count).toBeLessThan(200);      // bounded by the viewport, not by session length
  });

  it("still shows the last bar's label after scrolling to the end of the lane", async () => {
    act(() => root.render(React.createElement(Arrangement, { snapshot: LONG_SNAPSHOT })));
    const ruler = host.querySelector<HTMLDivElement>('[data-testid="v3-ruler"]');
    if (!ruler) throw new Error("Missing v3-ruler");
    const laneWidthPx = parseFloat(ruler.style.width);
    expect(laneWidthPx).toBeGreaterThan(50000);   // sanity on the fixture: 1100s * 80 px/s = 88000

    const scroller = host.querySelector<HTMLDivElement>(".tracks");
    if (!scroller) throw new Error("Missing .tracks scroller");
    act(() => {
      scroller.scrollLeft = laneWidthPx;
      scroller.dispatchEvent(new Event("scroll"));
    });
    // The window update is throttled to one rAF (scheduleFrame in Arrangement.tsx) — wait past an
    // actual animation frame, then flush a macrotask for the resulting setState to commit, the
    // same two-step wait useAnchoredPanel.test.ts's nextFrame() uses for the same reason (a bare
    // `setTimeout(0)` alone resolves before jsdom's rAF shim fires its callback).
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const barLabels = Array.from(host.querySelectorAll('[data-testid="v3-ruler"] .rn.bar')).map((el) => el.textContent);
    expect(barLabels).toContain("550");
    expect(gridAndRulerNodeCount()).toBeLessThan(200);   // still bounded, not accumulated from scrolling
  });
});
