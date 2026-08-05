// CAP-TRN-005 — pure, testable helpers for the metronome panel. No React, no bridge:
// just shapes the click block (snapshot.session.click) and the click-output enumeration
// (list_audio_devices' clickOutputs) into things a <select>/<input> can render.
//
// Same split as settings/routing.ts, and for the same reason: the interesting decisions
// here — what a missing device should look like, whether 0 on the slider means silence,
// which label a "" sound path gets — are exactly the ones a mounted-component test would
// have to reach through three layers of DOM to assert.

import type { ClickOutput, ClickSettings } from "../types";

/** The defaults MoshOps::clickSettingsToVar returns for a project that has never set
 *  anything, so a snapshot from an older backend (no `click` block) renders the same
 *  panel rather than a blank one. Level 0.6 is tracktion's own SettingID::lastClickTrackLevel
 *  default; 37/76 are its bigclick/littleclick MIDI notes. */
export const DEFAULT_CLICK: ClickSettings = {
  enabled: false, level: 0.6, levelMin: 0.2, levelMax: 1,
  emphasizeBars: false, recordingOnly: false,
  outputDevice: "", outputDeviceResolved: "(default audio output)",
  defaultOutputDevice: "(default audio output)",
  soundBig: "", soundSmall: "", midiNoteBig: 37, midiNoteSmall: 76,
};

/** dB readout for the level slider. The engine's floor (0.2) is about -14 dB, NOT
 *  silence — showing the dB number is what stops the bottom of the slider reading as a
 *  mute that never mutes. */
export function clickLevelDb(level: number): string {
  if (!(level > 0)) return "-inf dB";
  return `${(20 * Math.log10(level)).toFixed(1)} dB`;
}

/** What to call a click sample. "" is the engine's built-in click, not "no sound". */
export function clickSoundLabel(path: string): string {
  const p = path.trim();
  if (p === "") return "Built-in";
  return p.split("/").pop() || p;
}

export type ClickOutputOption = { value: string; label: string; isMidi: boolean };

/** The routing choices, with the STORED device kept in the list even when the machine
 *  no longer has it. Dropping it would silently re-point the select at the default and
 *  the next change would overwrite a route the producer set on their studio rig — the
 *  same "persisted-but-missing device" posture the track output picker already takes.
 *  `stored` is the raw snapshot intent ("" ⇒ never chosen ⇒ the default sentinel). */
export function clickOutputOptions(
  outputs: ClickOutput[] | null | undefined,
  stored: string,
  defaultOutput: string,
): ClickOutputOption[] {
  const list = outputs ?? [];
  const options: ClickOutputOption[] = list.length
    ? list.map((o) => ({ value: o.name, label: o.name, isMidi: o.isMidi }))
    : [{ value: defaultOutput, label: defaultOutput, isMidi: false }];

  const chosen = stored.trim() === "" ? defaultOutput : stored.trim();
  if (!options.some((o) => o.value === chosen))
    options.push({ value: chosen, label: `${chosen} (missing)`, isMidi: false });
  return options;
}

/** Which option the select should show. "" (never chosen) resolves to the default
 *  sentinel, because that is what the engine will actually use. */
export function selectedClickOutput(stored: string, defaultOutput: string): string {
  return stored.trim() === "" ? defaultOutput : stored.trim();
}

/** Is the click going to a MIDI destination? The MIDI click notes are inert on an audio
 *  out (ClickGenerator only reads them in its midi branch), so this gates whether the
 *  panel shows them at all rather than offering two dials that do nothing. */
export function isMidiClickOutput(outputs: ClickOutput[] | null | undefined, selected: string): boolean {
  return (outputs ?? []).some((o) => o.name === selected && o.isMidi);
}
