import { describe, it, expect, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach } from "vitest";
import { instrumentOf, InstrumentSlot } from "./InstrumentSlot";
import { Rack } from "../../ui/Dock";
import { useStore } from "../../store";
import { useShell } from "../shellState";
import { __resetMockForTests } from "../../bridge.mock";

// The slot's whole job is answering "does this track have a synth, and which one".
// That lookup is the part worth pinning; the buttons are thin exec wrappers.
describe("instrumentOf", () => {
  const fx = { index: 0, name: "OTT", enabled: true, external: true, isInstrument: false } as never;
  const synth = { index: 1, name: "Vital", enabled: true, external: true, isInstrument: true } as never;

  it("finds the instrument among effects", () => {
    expect(instrumentOf({ plugins: [fx, synth] } as never)?.name).toBe("Vital");
  });
  it("returns null on a bare track", () => {
    expect(instrumentOf({ plugins: [fx] } as never)).toBeNull();
  });
  it("returns null when the track has no plugin array at all", () => {
    expect(instrumentOf({} as never)).toBeNull();
  });
});

describe("Rack hideInstrument", () => {
  let host: HTMLDivElement;
  let root: Root;
  const track = {
    id: "t1", name: "Inst", type: "audio", clips: [],
    plugins: [
      { index: 0, name: "OTT", enabled: true, external: true, isInstrument: false },
      { index: 1, name: "Vital", enabled: true, external: true, isInstrument: true },
    ],
  } as never;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  const cardNames = () =>
    [...host.querySelectorAll('[data-testid="plugin-card"] .pname')].map((n) => n.textContent);

  it("v2 hides the instrument — the slot above already shows it", async () => {
    await act(async () => { root.render(React.createElement(Rack, { track, hideInstrument: true })); });
    expect(cardNames()).toEqual(["OTT"]);
  });

  it("classic passes no flag and keeps the flat chain it always had", async () => {
    await act(async () => { root.render(React.createElement(Rack, { track })); });
    expect(cardNames()).toEqual(["OTT", "Vital"]);
  });
});

// Regression for the finding-3 fix: the slot can DISPLAY a track that differs from
// store.selectedTrackId (Inspector.tsx shows a selected CLIP's track, clipTrack ??
// selectedTrack). usePluginPicker.load loads onto store.selectedTrackId, so without
// selecting the displayed track first, "click to choose" would load the instrument
// onto whatever track was selected before — not the track the slot is showing.
describe("InstrumentSlot pick() selects the DISPLAYED track before opening the picker", () => {
  let host: HTMLDivElement;
  let root: Root;
  const displayedTrack = {
    id: "displayed-track", name: "Shown", type: "audio", clips: [], plugins: [],
  } as never;

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    __resetMockForTests();
    await useStore.getState().refresh();
    // A DIFFERENT track is selected than the one this slot instance displays.
    useStore.setState({ selectedTrackId: "some-other-selected-track" });
    useShell.setState({ browserOpen: false, browserTab: "sounds", pendingCollection: null });
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("calls setSelectedTrack(displayed track id) before openBrowserTab, on an empty slot", async () => {
    const calls: string[] = [];
    vi.spyOn(useStore.getState(), "setSelectedTrack").mockImplementation((id) => {
      calls.push(`setSelectedTrack:${id}`);
      useStore.setState({ selectedTrackId: id });
    });
    vi.spyOn(useShell.getState(), "openBrowserTab").mockImplementation((t, c) => {
      calls.push(`openBrowserTab:${t}:${c}`);
      useShell.setState({ browserOpen: true, browserTab: t, pendingCollection: c ?? null });
    });

    await act(async () => { root.render(React.createElement(InstrumentSlot, { track: displayedTrack })); });
    const btn = host.querySelector('[data-testid="instslot-choose"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    await act(async () => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(calls).toEqual([
      "setSelectedTrack:displayed-track",
      "openBrowserTab:plugins:inst",
    ]);
    expect(useStore.getState().selectedTrackId).toBe("displayed-track");
  });
});
