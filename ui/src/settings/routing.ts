// G3 — pure, testable helpers for the audio-device select + per-track input picker
// in the Settings panel. No React, no bridge: just shapes the read-only routing
// enumerations (AudioDevices from list_audio_devices, WaveInput[] from
// list_wave_inputs) into option lists, and builds the set_audio_device patch arg.
// The UI in SettingsPanel.tsx wires these into <select>s and dispatches the
// existing MoshOps commands (set_audio_device / set_track_input) — one mutation
// path, no new commands, no audio concepts leaking across the seam.

import type { AudioDevices, AudioSelection, WaveInput, MidiInput, TrackOutputs, Track } from "../types";

export type DeviceOption = { value: string; label: string };

// The hardware-output / -input names for the CURRENTLY selected device type. A
// device type (e.g. CoreAudio) owns its own output/input device lists, so the
// picker must scope to current.type. Null devices / unknown type -> [] (headless).
export function outputDeviceOptions(devices: AudioDevices | null): string[] {
  return currentType(devices)?.outputs ?? [];
}

export function inputDeviceOptions(devices: AudioDevices | null): string[] {
  return currentType(devices)?.inputs ?? [];
}

// The buffer sizes the Settings picker offers. The open device knows what it can run, so
// its own list wins: CoreAudio reports many in-between sizes (48, 96, 192…), and a picker
// of fourteen entries helps nobody, so only powers of two from 32 up are offered. With no
// device report (headless, or a device that lists nothing) a standard ladder stands in.
// The size in use is always present, so the select never shows a value it cannot display.
export const STANDARD_BUFFER_SIZES = [64, 128, 256, 512, 1024];
const MIN_BUFFER_SIZE = 32;
const MAX_BUFFER_SIZE = 2048;

export function bufferSizeOptions(devices: AudioDevices | null, current?: number | null): number[] {
  const isPowerOfTwo = (n: number) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
  const reported = (devices?.bufferSizes ?? [])
    .filter((n) => isPowerOfTwo(n) && n >= MIN_BUFFER_SIZE && n <= MAX_BUFFER_SIZE);
  const sizes = new Set<number>(reported.length > 0 ? reported : STANDARD_BUFFER_SIZES);
  if (typeof current === "number" && current > 0) sizes.add(current);
  return [...sizes].sort((a, b) => a - b);
}

function currentType(devices: AudioDevices | null) {
  if (!devices) return undefined;
  return devices.types.find((t) => t.name === devices.current.type);
}

// Per-track input choices. Always leads with a "None" option (empty deviceID) so a
// track can clear its input; disabled inputs are still selectable but flagged.
export function waveInputOptions(inputs: WaveInput[] | null): DeviceOption[] {
  const none: DeviceOption = { value: "", label: "None" };
  if (!inputs || inputs.length === 0) return [none];
  return [
    none,
    ...inputs.map((wi) => ({
      value: wi.deviceID,
      label: wi.enabled ? wi.name : `${wi.name} (disabled)`,
    })),
  ];
}

// CTL-001 — per-instrument-track MIDI-input choices (v2 inspector). Same shape as
// waveInputOptions: leads with "None" (empty deviceID) so a track can clear its MIDI
// input, disabled devices stay selectable but flagged. Choosing rides the same
// set_track_input command (the deviceID-keyed "explicitly-chosen input", RTG-001).
export function midiInputOptions(inputs: MidiInput[] | null): DeviceOption[] {
  const none: DeviceOption = { value: "", label: "None" };
  if (!inputs || inputs.length === 0) return [none];
  return [
    none,
    ...inputs.map((mi) => ({
      value: mi.deviceID,
      label: mi.enabled ? mi.name : `${mi.name} (disabled)`,
    })),
  ];
}

// The track's currently-chosen input deviceID, or "" (None) when unset.
export function currentTrackInput(track: Track): string {
  return track.input?.deviceID ?? "";
}

// The patch arg for set_audio_device. The command is patch-style (each property is
// optional), so we only send the one field the user changed.
export function audioDevicePatch(field: "output" | "input", value: string): Record<string, string> {
  return field === "output" ? { outputDevice: value } : { inputDevice: value };
}

// ── RTG-002 — per-track OUTPUT routing ───────────────────────────────────────
// The output destinations from list_track_outputs (TrackOutputs): the hardware
// wave outs + every audio track as a candidate route-to-track destination (an
// implicit submix). A single <select> shows all three destination forms; the
// value is a discriminated string ("default" | "dev:<id>" | "track:<id>") that
// trackOutputPatch decodes into the existing set_track_output command args. The
// current track is excluded (a track can't output to itself).
export function trackOutputOptions(outputs: TrackOutputs | null, currentTrackId: string): DeviceOption[] {
  const opts: DeviceOption[] = [{ value: "default", label: "Default output" }];
  if (!outputs) return opts;
  for (const o of outputs.outputs)
    opts.push({ value: `dev:${o.deviceID}`, label: o.enabled ? o.name : `${o.name} (disabled)` });
  for (const t of outputs.tracks)
    if (t.id !== currentTrackId) opts.push({ value: `track:${t.id}`, label: `→ ${t.name}` });
  return opts;
}

// The track's current output as an option value: "default" (no explicit output),
// "track:<destId>" (routed into a track), or "dev:<deviceID>" (hardware out).
export function currentTrackOutput(track: Track): string {
  const out = track.output;
  if (!out) return "default";
  return out.isTrack ? `track:${out.destId ?? ""}` : `dev:${out.deviceID ?? ""}`;
}

// Decode an option value into set_track_output args. The command accepts exactly
// one destination form: { output: "default" } | { destTrackId } | { deviceID }.
export function trackOutputPatch(value: string, trackId: string): Record<string, string> {
  if (value.startsWith("track:")) return { trackId, destTrackId: value.slice("track:".length) };
  if (value.startsWith("dev:")) return { trackId, deviceID: value.slice("dev:".length) };
  return { trackId, output: "default" };
}

// The Settings read-out of how long a sound takes from the microphone to the headphones
// (snapshot.audio.monitorLatencyMs, the engine's estimate from what the open device
// reports). "fifo" means the two devices could not be opened as one, which roughly
// doubles the delay; the read-out says so rather than showing a bare number.
export function monitoringDelayLabel(audio: AudioSelection | null | undefined): string | null {
  const ms = audio?.monitorLatencyMs;
  if (typeof ms !== "number" || !(ms > 0)) return null;
  const text = `about ${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
  return audio?.combining === "fifo" ? `${text} (devices not combined)` : text;
}
