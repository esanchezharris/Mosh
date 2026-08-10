// AUD-017 follow-up — the DEGRADED startup (saved interface unplugged, the app
// running WITHOUT audio) must still offer the device switch from Settings: the
// engine enumerates CoreAudio regardless of an open device, so the pickers ride
// the enumeration, and picking one opens it through set_audio_device (the
// engine's adoptOpenedAudioDevice recovers the session). Component-level pins
// for exactly that state, plus the headless note and the healthy baseline.
//
// Same render harness as ui/src/ui/DrumSequencer.resetKit.test.ts.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioRouting, EngineSettings } from "./SettingsPanel";
import { useStore } from "../store";
import type { AudioDevices, Snapshot } from "../types";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}), pickFiles: vi.fn(), pickSaveFile: vi.fn() };
});

const SNAP = {
  schemaVersion: 1,
  session: {
    sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
    metronome: false, length: 16, editFile: "/tmp/d.mosh", audioEnabled: false,
    key: { tonic: "A", mode: "minor" },
  },
  tracks: [],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  master: { volumeDb: 0, pan: 0 },
} as unknown as Snapshot;

// The failed-open shape: NO device open (audioEnabled:false, empty selection)
// but the type still enumerates real hardware — the engine's fixed behavior.
const DEGRADED: AudioDevices = {
  types: [{ name: "CoreAudio", outputs: ["MacBook Pro Speakers", "BlackHole 2ch"], inputs: ["MacBook Pro Microphone"] }],
  current: { type: "CoreAudio", outputDevice: "", inputDevice: "", sampleRate: 48000, bufferSize: 512 },
  sampleRates: [44100, 48000], bufferSizes: [128, 512], defaultBufferSize: 512,
  audioEnabled: false,
};

const HEALTHY: AudioDevices = { ...DEGRADED, audioEnabled: true,
  current: { type: "CoreAudio", outputDevice: "MacBook Pro Speakers", inputDevice: "MacBook Pro Microphone", sampleRate: 48000, bufferSize: 512 } };

const HEADLESS: AudioDevices = { ...DEGRADED, types: [], audioEnabled: false };

describe("AudioRouting / EngineSettings — no-device (degraded) state", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  function renderWith(devices: AudioDevices, ui: "routing" | "engine") {
    exec = vi.fn(async () => ({ ok: true }));
    useStore.setState({
      snapshot: SNAP,
      audioDevices: devices,
      waveInputs: null,
      exec,
      loadAudioDevices: vi.fn(async () => {}),
      loadRouting: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}),
    } as never);
    act(() => root.render(React.createElement(ui === "routing" ? AudioRouting : EngineSettings, { snapshot: SNAP })));
  }

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("degraded: the output/input pickers RENDER with the enumerated devices (not the dead-session note)", () => {
    renderWith(DEGRADED, "routing");
    const out = host.querySelector('select[aria-label="Output device"]') as HTMLSelectElement;
    const inp = host.querySelector('select[aria-label="Input device"]') as HTMLSelectElement;
    expect(out).toBeTruthy();
    expect(inp).toBeTruthy();
    expect([...out.options].map((o) => o.value)).toContain("BlackHole 2ch");
    expect(host.textContent).not.toContain("No audio device in this session.");
    // …and it says why the session is silent + how to fix it, honestly
    expect(host.textContent).toContain("No device is open — pick an output to re-enable audio.");
  });

  it("degraded: picking an output opens it through set_audio_device (the recovery path)", () => {
    renderWith(DEGRADED, "routing");
    const out = host.querySelector('select[aria-label="Output device"]') as HTMLSelectElement;
    act(() => {
      out.value = "BlackHole 2ch";
      out.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(exec).toHaveBeenCalledWith("set_audio_device", { outputDevice: "BlackHole 2ch" });
  });

  it("degraded: the ENGINE Device row is a picker too (not a read-only dash)", () => {
    renderWith(DEGRADED, "engine");
    const sel = host.querySelector('select[aria-label="Engine device"]') as HTMLSelectElement;
    expect(sel).toBeTruthy();
    expect([...sel.options].map((o) => o.value)).toContain("BlackHole 2ch");
    act(() => {
      sel.value = "MacBook Pro Speakers";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(exec).toHaveBeenCalledWith("set_audio_device", { outputDevice: "MacBook Pro Speakers" });
  });

  it("healthy: no degraded note, the current device is selected", () => {
    renderWith(HEALTHY, "routing");
    const out = host.querySelector('select[aria-label="Output device"]') as HTMLSelectElement;
    expect(out.value).toBe("MacBook Pro Speakers");
    expect(host.textContent).not.toContain("No device is open");
  });

  it("headless (nothing enumerable): the honest dead-session note, no pickers", () => {
    renderWith(HEADLESS, "routing");
    expect(host.textContent).toContain("No audio device in this session.");
    expect(host.querySelector('select[aria-label="Output device"]')).toBeNull();
  });
});
