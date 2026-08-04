// CAP-TRK-002 (#613) — the track-icon palette, and the one place a name becomes a glyph.
//
// The persisted value is a NAME (see src/state/TrackIcons.h). This module is the UI half
// of that contract: the order icons appear in the picker, and what each name draws. Both
// are UI decisions and both can change freely — reordering TRACK_ICONS repaints no project
// file, which is the entire reason the engine stores names instead of indices.
//
// What may NOT change freely is the SET. `set_track_icon` refuses a name it cannot draw,
// so a name here that the engine doesn't know is a picker button that errors on click.
// `trackIcons.test.ts` compares both directions against the C++ header at test time.

import { IconDrum, IconMic, IconSpark } from "../ui/icons";
import { IconBass, IconGuitar, IconKeys, IconPerc, IconSample, IconStrings, IconSynth } from "../ui/icons";
import { TRACK_ICONS, type TrackIconName } from "../trackIconNames";

export { TRACK_ICONS, type TrackIconName };

type Glyph = (p: { size?: number }) => React.ReactElement;

/** name -> glyph. Keyed by the persisted name, never by position. */
export const TRACK_ICON_GLYPHS: Record<string, Glyph> = {
  drum: IconDrum,
  perc: IconPerc,
  bass: IconBass,
  guitar: IconGuitar,
  keys: IconKeys,
  synth: IconSynth,
  vocal: IconMic,
  strings: IconStrings,
  fx: IconSpark,
  sample: IconSample,
};

/** Human labels for the picker's tooltips and accessible names. */
export const TRACK_ICON_LABELS: Record<string, string> = {
  drum: "Drums",
  perc: "Percussion",
  bass: "Bass",
  guitar: "Guitar",
  keys: "Keys",
  synth: "Synth",
  vocal: "Vocal",
  strings: "Strings",
  fx: "FX",
  sample: "Sample",
};

/**
 * The chosen icon, or `null` when the track has none (or carries a name this build cannot
 * draw — a project saved by a NEWER Mosh with an icon added since). Returning null rather
 * than a placeholder is what makes that case degrade to the track-type default instead of
 * to a broken glyph, and it costs nothing: the type icon was always the fallback.
 */
export function trackIconGlyph(name: string | undefined): Glyph | null {
  if (!name) return null;
  return TRACK_ICON_GLYPHS[name] ?? null;
}
