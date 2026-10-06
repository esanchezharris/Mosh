import type { ComponentType } from "react";
import type { CommandResult, Plugin, Track } from "../../types";

/** The sampler commands a panel may send through `run` (they are not plugin params or
 *  state). Argument names are the engine's own (src/moshops/MoshOps.Plugins.cpp,
 *  MoshOps.Live.cpp, MoshOps.Mixer.cpp). `trackId` is never passed by the panel: the row
 *  adds it for the commands that take one. */
export type SamplerCommandArgs = {
  /** Edits the NARROWEST sound covering `note` (use the sound's `addressNote`). Every write
   *  rebuilds the sampler and cuts ringing voices: send it on release, never per drag frame. */
  set_drum_pad: { note: number; gainDb?: number; pan?: number; name?: string; chokeGroup?: number };
  /** Removes the narrowest sound covering `note`. */
  clear_drum_pad: { note: number };
  /** REPLACES every sound covering `note` (a melodic sound spanning it too) and resets its
   *  level, pan and choke. `mode` "melodic" plays the file across the keyboard rooted at
   *  `note`; anything else is a one-shot pad. `file` must be an absolute path. */
  assign_sample: { note: number; file: string; mode?: "drum" | "melodic"; name?: string; gainDb?: number };
  /** Replaces ALL of the sampler's sounds with a kit (omit `kit` for the bundled default). */
  load_drum_kit: { kit?: string };
  /** Read-only: the kit library. Call it lazily (when the kit menu opens). */
  list_drum_kits: Record<string, never>;
  /** Mute/solo the lane at `note` (pads keyed by their root note). */
  set_drum_lane: { note: number; mute?: boolean; solo?: boolean };
  /** Sound a note through the track's instrument ("blip" = a short tap). */
  audition_note: { pitch: number; velocity?: number; action?: "on" | "off" | "blip"; durationMs?: number; channel?: number };
  /** Read-only: waveform peaks of an absolute file path (a sound's `path`). */
  file_peaks: { path: string; buckets?: number };
};
export type SamplerCommand = keyof SamplerCommandArgs;

/** What each command's result `data` carries (the engine's result shapes). */
export type SamplerCommandData = {
  set_drum_pad: { trackId: string; note: number; padIndex: number };
  clear_drum_pad: { trackId: string; note: number; removed: number };
  assign_sample: { trackId: string; index: number; note: number; name: string; mode: string; file: string; sounds: number };
  load_drum_kit: { trackId: string; index: number; pads: number; kit: string };
  list_drum_kits: {
    kits: { id: string; name: string; pads: number; path: string; available: boolean; source?: string }[];
    defaultKit: string;
  };
  set_drum_lane: { trackId: string; note: number; muted: boolean; solo: boolean };
  audition_note: {
    trackId: string; pitch: number; action: string; audible: boolean;
    path: "input" | "inject" | "sampler" | "none"; held: number; recordable: boolean; reason?: string;
  };
  file_peaks: { path: string; buckets: number; peaks: [number, number][] };
};

/** The commands that act on the panel's track: the row fills in `trackId` for these. */
export const TRACK_SCOPED_COMMANDS: ReadonlySet<SamplerCommand> = new Set<SamplerCommand>([
  "set_drum_pad", "clear_drum_pad", "assign_sample", "load_drum_kit", "set_drum_lane", "audition_note",
]);

/** Send one of the sampler commands for this panel's track (the row adds `trackId`). */
export type RunCommand = <C extends SamplerCommand>(
  command: C, args: SamplerCommandArgs[C],
) => Promise<CommandResult<SamplerCommandData[C]>>;

/** What every native plugin panel is given. Panels never call `exec` themselves: every
 *  change goes through setParam / setState (or `run` for the sampler's own commands), so
 *  the row decides how commands are sent. */
export type PanelProps = {
  plugin: Plugin;
  trackId: string;
  /** The track the plugin is on (its pads' mute/solo pitches, its kit), when the row has it. */
  track?: Track;
  /** The session's sample rate (the rate the plugin runs at during playback); 48000 when
   *  there is no audio device. Curves that depend on it (filters near Nyquist) use it. */
  sampleRate: number;
  /** set_plugin_param with a normalised 0-1 value. Pass the same `gesture` for every step
   *  of one drag so the whole drag is one undo step. */
  setParam: (paramIndex: number, norm: number, opts?: { gesture?: string }) => void;
  /** set_plugin_state for a setting in `plugin.state`. */
  setState: (key: string, value: number | string, opts?: { gesture?: string }) => void;
  /** The sampler's commands (pads, kits, lanes, auditions, file peaks), for this track. */
  run?: RunCommand;
};

/** What a summary may read besides the plugin itself. */
export type SummaryContext = { track?: Track };

export type PanelDef = {
  /** The header title, when the engine's name is unhelpful ("LPF/HPF") or repeats the
   *  MOSH chip ("Mosh Soft Clipper"). */
  title?: string;
  /** A shorter title for the minimized row (its name column is about 76 px). */
  shortTitle?: string;
  Panel: ComponentType<PanelProps>;
  /** One line of text for the minimized row, e.g. "Lo +3.0 dB · 3.0k -2.0 dB". */
  summary: (plugin: Plugin, ctx?: SummaryContext) => string;
  /** An optional tiny element for the minimized row (at most about 72×16 px), e.g. a live
   *  gain-reduction bar or a curve thumbnail. */
  Mini?: ComponentType<PanelProps>;
  /** The panel draws the instrument's preset menu itself (in its own top row), so the row
   *  does not render its PresetPicker above it. */
  ownsPresets?: boolean;
};
