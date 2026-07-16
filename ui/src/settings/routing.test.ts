import { describe, it, expect } from "vitest";
import {
  outputDeviceOptions,
  inputDeviceOptions,
  waveInputOptions,
  currentTrackInput,
  audioDevicePatch,
  trackOutputOptions,
  currentTrackOutput,
  trackOutputPatch,
} from "./routing";
import type { AudioDevices, WaveInput, Track, TrackOutputs } from "../types";

const devices = (over: Partial<AudioDevices> = {}): AudioDevices => ({
  types: [
    { name: "CoreAudio", outputs: ["MacBook Pro Speakers", "External Headphones"], inputs: ["MacBook Pro Microphone", "Scarlett 2i2"] },
    { name: "Aggregate", outputs: ["Big Rig"], inputs: ["Big Rig In"] },
  ],
  current: { type: "CoreAudio", outputDevice: "MacBook Pro Speakers", inputDevice: "MacBook Pro Microphone", sampleRate: 48000, bufferSize: 512 },
  sampleRates: [44100, 48000, 96000],
  bufferSizes: [128, 256, 512, 1024],
  defaultBufferSize: 512,
  audioEnabled: true,
  ...over,
});

describe("outputDeviceOptions / inputDeviceOptions", () => {
  it("returns the outputs/inputs for the CURRENT device type only", () => {
    expect(outputDeviceOptions(devices())).toEqual(["MacBook Pro Speakers", "External Headphones"]);
    expect(inputDeviceOptions(devices())).toEqual(["MacBook Pro Microphone", "Scarlett 2i2"]);
  });

  it("follows the current type when it is not the first entry", () => {
    const d = devices({ current: { type: "Aggregate", outputDevice: "Big Rig", inputDevice: "Big Rig In", sampleRate: 48000, bufferSize: 512 } });
    expect(outputDeviceOptions(d)).toEqual(["Big Rig"]);
    expect(inputDeviceOptions(d)).toEqual(["Big Rig In"]);
  });

  it("returns [] when devices is null or the type is unknown (graceful headless)", () => {
    expect(outputDeviceOptions(null)).toEqual([]);
    expect(inputDeviceOptions(null)).toEqual([]);
    const d = devices({ current: { type: "Nope", outputDevice: "", inputDevice: "", sampleRate: 0, bufferSize: 0 } });
    expect(outputDeviceOptions(d)).toEqual([]);
    expect(inputDeviceOptions(d)).toEqual([]);
  });
});

describe("waveInputOptions", () => {
  const inputs: WaveInput[] = [
    { deviceID: "in-1-2", name: "Input 1-2", enabled: true, isStereoPair: true },
    { deviceID: "in-3", name: "Input 3", enabled: false, isStereoPair: false },
  ];

  it("always leads with a 'None' option (empty value) so a track can clear its input", () => {
    const opts = waveInputOptions(inputs);
    expect(opts[0]).toEqual({ value: "", label: "None" });
  });

  it("maps each wave input to deviceID/name and marks disabled ones", () => {
    const opts = waveInputOptions(inputs);
    expect(opts[1]).toEqual({ value: "in-1-2", label: "Input 1-2" });
    expect(opts[2]).toEqual({ value: "in-3", label: "Input 3 (disabled)" });
  });

  it("returns just 'None' when there are no inputs (or the list is null)", () => {
    expect(waveInputOptions([])).toEqual([{ value: "", label: "None" }]);
    expect(waveInputOptions(null)).toEqual([{ value: "", label: "None" }]);
  });
});

describe("currentTrackInput", () => {
  it("returns the track's chosen input deviceID", () => {
    const t = { id: "t1", input: { deviceID: "in-3-4", name: "Input 3-4" } } as Track;
    expect(currentTrackInput(t)).toBe("in-3-4");
  });

  it("returns '' (None) when the track has no chosen input", () => {
    expect(currentTrackInput({ id: "t1" } as Track)).toBe("");
  });
});

describe("audioDevicePatch", () => {
  it("builds an output-device patch", () => {
    expect(audioDevicePatch("output", "External Headphones")).toEqual({ outputDevice: "External Headphones" });
  });
  it("builds an input-device patch", () => {
    expect(audioDevicePatch("input", "Scarlett 2i2")).toEqual({ inputDevice: "Scarlett 2i2" });
  });
});

// ── RTG-002 — per-track OUTPUT routing (the orphaned trackOutputs half) ───────
const outputs = (over: Partial<TrackOutputs> = {}): TrackOutputs => ({
  outputs: [
    { deviceID: "out-1-2", name: "Main Out 1-2", enabled: true },
    { deviceID: "out-3-4", name: "Cue 3-4", enabled: false },
  ],
  tracks: [
    { id: "t1", name: "Drums" },
    { id: "t2", name: "Bass" },
    { id: "t3", name: "Keys" },
  ],
  audioEnabled: true,
  ...over,
});

describe("trackOutputOptions", () => {
  it("always leads with a 'Default output' option", () => {
    expect(trackOutputOptions(outputs(), "t3")[0]).toEqual({ value: "default", label: "Default output" });
  });

  it("maps hardware outputs (dev: prefix) and flags disabled ones", () => {
    const opts = trackOutputOptions(outputs(), "t3");
    expect(opts).toContainEqual({ value: "dev:out-1-2", label: "Main Out 1-2" });
    expect(opts).toContainEqual({ value: "dev:out-3-4", label: "Cue 3-4 (disabled)" });
  });

  it("maps candidate tracks (track: prefix) but EXCLUDES the current track (no self-route)", () => {
    const opts = trackOutputOptions(outputs(), "t3");
    expect(opts).toContainEqual({ value: "track:t1", label: "→ Drums" });
    expect(opts).toContainEqual({ value: "track:t2", label: "→ Bass" });
    expect(opts.some((o) => o.value === "track:t3")).toBe(false);
  });

  it("returns just 'Default output' when the enumeration is null (graceful headless)", () => {
    expect(trackOutputOptions(null, "t3")).toEqual([{ value: "default", label: "Default output" }]);
  });
});

describe("currentTrackOutput", () => {
  it("returns 'default' when the track has no explicit output", () => {
    expect(currentTrackOutput({ id: "t1" } as Track)).toBe("default");
  });

  it("encodes a route-into-track destination as track:<destId>", () => {
    const t = { id: "t1", output: { isTrack: true, destId: "t2", name: "Bass" } } as Track;
    expect(currentTrackOutput(t)).toBe("track:t2");
  });

  it("encodes a hardware-device destination as dev:<deviceID>", () => {
    const t = { id: "t1", output: { isTrack: false, name: "Cue 3-4", deviceID: "out-3-4" } } as Track;
    expect(currentTrackOutput(t)).toBe("dev:out-3-4");
  });
});

describe("trackOutputPatch", () => {
  it("decodes 'default' into a reset patch", () => {
    expect(trackOutputPatch("default", "t1")).toEqual({ trackId: "t1", output: "default" });
  });
  it("decodes track:<id> into a destTrackId patch", () => {
    expect(trackOutputPatch("track:t2", "t1")).toEqual({ trackId: "t1", destTrackId: "t2" });
  });
  it("decodes dev:<deviceID> into a deviceID patch (preserving colons in the id)", () => {
    expect(trackOutputPatch("dev:out-3-4", "t1")).toEqual({ trackId: "t1", deviceID: "out-3-4" });
  });
});
