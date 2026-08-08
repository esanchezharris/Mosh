// Pure helpers for the live track header's I/O grid (TrackIoSection.tsx). The
// option builders themselves are settings/routing.ts's (already unit-covered in
// routing.test.ts); these are the live-shell shapes on top — grouped input options
// and closed-popup labels.

import { midiInputOptions, waveInputOptions, type DeviceOption } from "../settings/routing";
import type { MidiInput, WaveInput } from "../types";

/** The track's input-source options: wave inputs for every track; MIDI inputs only
 *  when the track hosts an instrument (CTL-001 — a MIDI input only plays into one).
 *  "None" (empty deviceID) leads, exactly once, matching Live's "No Input". */
export function inputOptionsFor(
  waveInputs: WaveInput[] | null,
  midiInputs: MidiInput[] | null,
  isInstrument: boolean,
): DeviceOption[] {
  const wave = waveInputOptions(waveInputs);
  if (!isInstrument) return wave;
  const midi = (midiInputOptions(midiInputs) ?? []).filter((o) => o.value !== "");
  return [...wave, ...midi];
}

/** The label the closed popup shows for the current value ("" = the empty label). */
export function optionLabel(
  options: readonly { value: string; label: string }[],
  value: string,
  emptyLabel: string,
): string {
  if (value === "") return emptyLabel;
  return options.find((o) => o.value === value)?.label ?? value;
}

/** The closed input popup's label. Resolution order: the routing CATALOG first
 *  (friendly name, and the "(disabled)" flag), then the SNAPSHOT's own resolved
 *  `input.name` — which is what a restored session carries while the lazy catalog
 *  hasn't loaded yet (without it the popup showed the raw deviceID after every
 *  restore) — and only then the raw ID, for a device that's genuinely gone. */
export function inputDisplayLabel(
  track: { input?: { deviceID: string; name?: string } },
  options: readonly DeviceOption[],
): string {
  const value = track.input?.deviceID ?? "";
  if (value === "") return "No Input";
  return options.find((o) => o.value === value)?.label ?? track.input?.name ?? value;
}

/** Volume/pan slider defaults for double-click reset (Live's reset gesture). */
export const VOLUME_DEFAULT_DB = 0;
export const PAN_DEFAULT = 0;
