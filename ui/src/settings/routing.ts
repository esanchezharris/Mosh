// G3 — pure, testable helpers for the audio-device select + per-track input picker
// in the Settings panel. No React, no bridge: just shapes the read-only routing
// enumerations (AudioDevices from list_audio_devices, WaveInput[] from
// list_wave_inputs) into option lists, and builds the set_audio_device patch arg.
// The UI in SettingsPanel.tsx wires these into <select>s and dispatches the
// existing MoshOps commands (set_audio_device / set_track_input) — one mutation
// path, no new commands, no audio concepts leaking across the seam.

import type { AudioDevices, WaveInput, Track } from "../types";

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

// The track's currently-chosen input deviceID, or "" (None) when unset.
export function currentTrackInput(track: Track): string {
  return track.input?.deviceID ?? "";
}

// The patch arg for set_audio_device. The command is patch-style (each property is
// optional), so we only send the one field the user changed.
export function audioDevicePatch(field: "output" | "input", value: string): Record<string, string> {
  return field === "output" ? { outputDevice: value } : { inputDevice: value };
}
