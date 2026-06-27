// Audio warp / time-stretch — the pure UI core (G9).
//
// The backend command `set_clip_warp` and the snapshot fields (`autoTempo`,
// `stretchMode`) already exist; this module is the thin, testable logic the clip
// menu uses to (a) decide whether a clip can warp, (b) build the command args to
// toggle / re-mode it, and (c) label the active stretch mode for display. The React
// menu stays a dumb caller — it only ever invokes exec("set_clip_warp", args), so
// the swappable seam holds.

import type { Clip } from "../types";

// A curated stretch-mode option. `id` is the ENGINE mode name the command sends
// ("" = the engine default; "soundtouch" = the mode this build vendors via
// TRACKTION_ENABLE_TIMESTRETCH_SOUNDTOUCH). The backend's checkModeIsAvailable
// validates the name and falls back to a usable mode, so the list is forgiving.
export type WarpMode = { id: string; label: string };

export const DEFAULT_WARP_MODE = ""; // omit `mode` ⇒ engine default

export const WARP_MODES: WarpMode[] = [
  { id: DEFAULT_WARP_MODE, label: "Default" },
  { id: "soundtouch", label: "SoundTouch" },
];

// The args for the `set_clip_warp` command. `mode` is present only when enabling.
export type WarpArgs = { clipId: string; autoTempo: boolean; mode?: string };

/** Warp is an audio-only operation — only wave clips time-stretch. */
export function clipIsWarpable(clip: Clip): boolean {
  return clip.type === "wave";
}

/**
 * Args that FLIP the clip's current warp state. Enabling carries a stretch mode
 * (the explicit one, else the engine default); disabling omits it (no mode needed
 * to turn warp off).
 */
export function warpToggleArgs(clip: Clip, mode: string = DEFAULT_WARP_MODE): WarpArgs {
  const on = !clip.autoTempo;
  return on ? { clipId: clip.id, autoTempo: true, mode } : { clipId: clip.id, autoTempo: false };
}

/** Args to keep warp ON but switch to a specific stretch mode (the mode <select>). */
export function warpModeArgs(clip: Clip, modeId: string): WarpArgs {
  return { clipId: clip.id, autoTempo: true, mode: modeId };
}

/**
 * Human label for a snapshot `stretchMode` string. An empty/undefined mode maps to
 * the engine-default label; an unknown engine mode name falls back to the raw name
 * (so the UI never blanks out or throws on a mode this build named differently).
 */
export function warpModeLabel(stretchMode?: string): string {
  if (!stretchMode) return WARP_MODES.find((m) => m.id === DEFAULT_WARP_MODE)!.label;
  const hit = WARP_MODES.find((m) => m.id.toLowerCase() === stretchMode.toLowerCase());
  return hit ? hit.label : stretchMode;
}
