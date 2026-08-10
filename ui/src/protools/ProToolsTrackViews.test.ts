import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { Snapshot } from "../types";
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

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      snapshot: SNAPSHOT,
      transport: SNAPSHOT.transport,
      selectedTrackId: "audio-track",
      selection: new Set<string>(),
      pxPerSec: 100,
      projectEpoch: 90,
      ensurePeaks: vi.fn(),
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
});
