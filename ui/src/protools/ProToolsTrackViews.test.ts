import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { ProToolsTimeline } from "./ProToolsTimeline";
import { ProToolsTrackHeaders } from "./ProToolsTrackHeaders";
import { useProTools } from "./proToolsState";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}), pickFiles: vi.fn(), pickSaveFile: vi.fn() };
});

vi.mock("../ui/clipRenderers", async () => {
  const actual = await vi.importActual<typeof import("../ui/clipRenderers")>("../ui/clipRenderers");
  return {
    ...actual,
    ClipWave: () => React.createElement("span", { "data-testid": "wave-ink" }),
    ClipMidi: () => React.createElement("span", { "data-testid": "midi-ink" }),
    ClipDrumGrid: () => React.createElement("span", { "data-testid": "drum-ink" }),
  };
});

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-track-views.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [{
    id: "audio-track",
    index: 0,
    name: "Lead Vocal",
    type: "audio",
    clips: [{
      id: "audio-clip",
      name: "Vocal Take",
      type: "wave",
      start: 0,
      length: 4,
      offset: 0,
      sourceFile: "/tmp/vocal.wav",
      hasRenderLayer: false,
    }],
    mixerPlugins: [{
      index: 7,
      name: "Track Fader",
      type: "moshTrackFader",
      enabled: true,
      external: false,
      isInstrument: false,
      params: [
        { index: 0, name: "Volume", value: 0.8, points: [] },
        { index: 1, name: "Pan", value: 0.5, points: [] },
      ],
    }],
  }, {
    id: "midi-track",
    index: 1,
    name: "Keys",
    type: "midi",
    isInstrument: true,
    clips: [{
      id: "midi-clip",
      name: "Chords",
      type: "midi",
      start: 0,
      length: 4,
      offset: 0,
      hasRenderLayer: false,
      notes: [{ i: 0, pitch: 60, start: 0, length: 1, velocity: 96 }],
    }],
  }, {
    id: "double-track",
    index: 2,
    name: "Double Vocal",
    type: "audio",
    clips: [],
  }],
  transport: {
    playing: false,
    recording: false,
    position: 0,
    looping: false,
    loopStart: 0,
    loopEnd: 0,
  },
};

function TimelineHarness() {
  const scrollRef = useRef<HTMLDivElement>(null);
  return React.createElement(ProToolsTimeline, {
    snapshot: SNAPSHOT,
    contentWidth: 800,
    scrollRef,
    onScroll: () => {},
    onSpotClip: () => {},
  });
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Pro Tools Track Views", () => {
  let host: HTMLDivElement;
  let root: Root;
  const originalEnsurePeaks = useStore.getState().ensurePeaks;
  const originalExec = useStore.getState().exec;
  let execCalls: { readonly command: string; readonly args?: Record<string, unknown> }[];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    execCalls = [];
    useStore.setState({
      snapshot: SNAPSHOT,
      transport: SNAPSHOT.transport,
      selectedTrackId: "audio-track",
      selection: new Set<string>(),
      pxPerSec: 100,
      projectEpoch: 90,
      ensurePeaks: vi.fn(),
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        execCalls.push({ command, args });
        return { ok: true, command, data: command === "arm_track" ? { applied: true } : undefined };
      }),
    });
    useProTools.getState().resetForProject();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      snapshot: null,
      selectedTrackId: null,
      selection: new Set<string>(),
      ensurePeaks: originalEnsurePeaks,
      exec: originalExec,
    });
    vi.restoreAllMocks();
  });

  it("offers the two documented common views for audio and instrument tracks", () => {
    act(() => root.render(React.createElement(ProToolsTrackHeaders, { snapshot: SNAPSHOT })));

    const audioHeader = host.querySelector<HTMLElement>('[data-track-id="audio-track"]');
    const midiHeader = host.querySelector<HTMLElement>('[data-track-id="midi-track"]');
    const audioSelect = audioHeader?.querySelector<HTMLSelectElement>("[data-testid=pt-track-view]");
    const midiSelect = midiHeader?.querySelector<HTMLSelectElement>("[data-testid=pt-track-view]");

    expect(audioSelect?.value).toBe("waveform");
    expect(Array.from(audioSelect?.options ?? []).map((option) => option.text))
      .toEqual(["Waveform", "Playlists", "Volume"]);
    expect(midiSelect?.value).toBe("clips");
    expect(Array.from(midiSelect?.options ?? []).map((option) => option.text)).toEqual(["Clips", "Notes"]);

    if (!audioSelect) throw new Error("audio Track View selector is missing");
    act(() => setSelectValue(audioSelect, "volume"));
    expect(useProTools.getState().trackViews["audio-track"]).toBe("volume");
  });

  it("applies Track View changes to every compatible selected track", () => {
    // Given two audio tracks own the linked Track selection.
    useProTools.setState({
      editSelectionTrackId: "double-track",
      editSelectionTrackIds: ["audio-track", "double-track"],
      trackSelectionIds: ["audio-track", "double-track"],
    });
    act(() => root.render(React.createElement(ProToolsTrackHeaders, { snapshot: SNAPSHOT })));
    const leadHeader = host.querySelector<HTMLElement>('[data-track-id="audio-track"]');
    const doubleHeader = host.querySelector<HTMLElement>('[data-track-id="double-track"]');
    const leadView = leadHeader?.querySelector<HTMLSelectElement>("[data-testid=pt-track-view]");
    const doubleView = doubleHeader?.querySelector<HTMLSelectElement>("[data-testid=pt-track-view]");
    if (!leadView || !doubleView) throw new Error("selected audio Track View controls are missing");

    // When Volume is chosen from either selected audio header.
    act(() => setSelectValue(leadView, "volume"));

    // Then both selected compatible tracks change view and remain visibly selected.
    expect(useProTools.getState().trackViews["audio-track"]).toBe("volume");
    expect(useProTools.getState().trackViews["double-track"]).toBe("volume");
    expect(leadHeader?.dataset.selected).toBe("true");
    expect(doubleHeader?.dataset.selected).toBe("true");
    expect(doubleView.value).toBe("volume");
  });

  it("uses Command-click for noncontiguous Track Names and Shift-click for a range", () => {
    act(() => root.render(React.createElement(ProToolsTrackHeaders, { snapshot: SNAPSHOT })));
    const lead = host.querySelector<HTMLElement>('[data-track-id="audio-track"]');
    const keys = host.querySelector<HTMLElement>('[data-track-id="midi-track"]');
    const double = host.querySelector<HTMLElement>('[data-track-id="double-track"]');
    const leadSelect = lead?.querySelector<HTMLButtonElement>("[data-testid=pt-track-select]");
    const doubleSelect = double?.querySelector<HTMLButtonElement>("[data-testid=pt-track-select]");
    if (!leadSelect || !doubleSelect) throw new Error("Track Name buttons are missing");

    // Command-click adds the nonadjacent Double without selecting Keys.
    act(() => doubleSelect.dispatchEvent(new MouseEvent("click", {
      bubbles: true, cancelable: true, metaKey: true,
    })));
    expect(lead?.dataset.selected).toBe("true");
    expect(keys?.dataset.selected).toBe("false");
    expect(double?.dataset.selected).toBe("true");
    expect(useProTools.getState().editSelectionTrackIds).toEqual(["audio-track", "double-track"]);

    // A plain click establishes Lead as the anchor, then Shift-click selects through Double.
    act(() => leadSelect.click());
    act(() => doubleSelect.dispatchEvent(new MouseEvent("click", {
      bubbles: true, cancelable: true, shiftKey: true,
    })));
    expect(useProTools.getState().trackSelectionIds)
      .toEqual(["audio-track", "midi-track", "double-track"]);
    expect(keys?.dataset.selected).toBe("true");
    expect(execCalls).toEqual([]);
  });

  it("Option-Shift-click applies a header control to every selected Track Name", async () => {
    // Given two nonadjacent Track Names are selected.
    useProTools.setState({
      editSelectionTrackId: "double-track",
      editSelectionTrackIds: ["audio-track", "double-track"],
      trackSelectionIds: ["audio-track", "double-track"],
    });
    act(() => root.render(React.createElement(ProToolsTrackHeaders, { snapshot: SNAPSHOT })));
    const lead = host.querySelector<HTMLElement>('[data-track-id="audio-track"]');
    const mute = lead?.querySelector<HTMLButtonElement>("[data-testid=pt-track-mute]");
    if (!mute) throw new Error("Lead Vocal mute control is missing");

    // When the source Mute button is Option-Shift-clicked.
    act(() => mute.dispatchEvent(new MouseEvent("click", {
      bubbles: true, cancelable: true, altKey: true, shiftKey: true,
    })));

    // Then the selected Track Names receive the same next state in visible order.
    await vi.waitFor(() => expect(execCalls.filter((call) => call.command === "set_track_mute"))
      .toEqual([
        { command: "set_track_mute", args: { trackId: "audio-track", mute: true } },
        { command: "set_track_mute", args: { trackId: "double-track", mute: true } },
      ]));
  });

  it("discloses a secondary automation lane without mutating the project", () => {
    act(() => root.render(React.createElement(ProToolsTrackHeaders, { snapshot: SNAPSHOT })));
    const audioHeader = host.querySelector<HTMLElement>('[data-track-id="audio-track"]');
    const toggle = audioHeader?.querySelector<HTMLButtonElement>("[data-testid=pt-automation-lanes]");
    if (!toggle) throw new Error("automation-lanes toggle is missing");

    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    act(() => toggle.click());

    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(useProTools.getState().automationLanesVisible["audio-track"]).toBe(true);
  });

  it("switches between a full-height clip view, primary Volume, and a secondary Volume lane", () => {
    act(() => root.render(React.createElement(TimelineHarness)));
    const audioLane = () => host.querySelector<HTMLElement>('[data-testid="pt-lane"][data-track-id="audio-track"]');

    expect(audioLane()?.dataset.trackView).toBe("waveform");
    expect(audioLane()?.dataset.secondaryAutomation).toBe("false");
    expect(audioLane()?.querySelector('[data-clip-id="audio-clip"]')).not.toBeNull();
    expect(audioLane()?.querySelector("[data-testid=protools-automation-lane]")).toBeNull();

    act(() => useProTools.getState().setTrackView("audio-track", "volume"));
    expect(audioLane()?.dataset.trackView).toBe("volume");
    expect(audioLane()?.querySelector('[data-clip-id="audio-clip"]')).toBeNull();
    const primary = audioLane()?.querySelector<HTMLElement>("[data-testid=pt-automation-lane-frame]");
    expect(primary?.dataset.primary).toBe("true");
    expect(primary?.querySelector("[aria-label^='Lead Vocal automation, Volume.']")).not.toBeNull();
    expect(primary?.querySelector(".pt-automation-path")?.getAttribute("d"))
      .toBe("M 0.0 22.0 L 800.0 22.0");

    act(() => {
      useProTools.getState().setTrackView("audio-track", "waveform");
      useProTools.getState().toggleAutomationLane("audio-track");
    });
    expect(audioLane()?.dataset.secondaryAutomation).toBe("true");
    expect(audioLane()?.querySelector('[data-clip-id="audio-clip"]')).not.toBeNull();
    expect(audioLane()?.querySelector<HTMLElement>("[data-testid=pt-automation-lane-frame]")?.dataset.primary)
      .toBe("false");
  });

  it("marks the instrument Notes view while preserving the editable MIDI surface", () => {
    act(() => root.render(React.createElement(TimelineHarness)));
    act(() => useProTools.getState().setTrackView("midi-track", "notes"));

    const midiLane = host.querySelector<HTMLElement>('[data-testid="pt-lane"][data-track-id="midi-track"]');
    expect(midiLane?.dataset.trackView).toBe("notes");
    expect(midiLane?.querySelector('[data-clip-id="midi-clip"]')).not.toBeNull();
    expect(midiLane?.querySelector("[data-testid=midi-ink]")).not.toBeNull();
  });

  it("keeps headers, lanes, playlists, and automation on one proportional height scale", () => {
    act(() => root.render(React.createElement(React.Fragment, null,
      React.createElement(ProToolsTrackHeaders, { snapshot: SNAPSHOT }),
      React.createElement(TimelineHarness),
    )));
    act(() => useProTools.getState().setTrackHeightScale(1.25));

    const header = host.querySelector<HTMLElement>('.pt-track-header[data-track-id="audio-track"]');
    const lane = host.querySelector<HTMLElement>('.pt-lane[data-track-id="audio-track"]');
    expect(header?.style.height).toBe("115px");
    expect(lane?.style.height).toBe("115px");
    expect(header?.style.getPropertyValue("--pt-playlist-row-h")).toBe("33px");
    expect(lane?.style.getPropertyValue("--pt-main-lane-h")).toBe("115px");
    expect(lane?.style.getPropertyValue("--pt-automation-h")).toBe("35px");

    act(() => {
      useProTools.getState().setTrackView("audio-track", "playlists");
      useProTools.getState().toggleAutomationLane("audio-track");
    });
    expect(header?.style.height).toBe("183px");
    expect(lane?.style.height).toBe("183px");
    expect(header?.querySelector<HTMLElement>("[data-testid=pt-playlist-header-row]")?.style.height)
      .toBe("33px");
    expect(lane?.querySelector("[data-testid=pt-playlists]")).not.toBeNull();
    expect(lane?.querySelector("[data-testid=pt-automation-lane-frame]")).not.toBeNull();
  });
});
