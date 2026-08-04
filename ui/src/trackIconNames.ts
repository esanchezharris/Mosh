// CAP-TRK-002 (#613) — the track-icon NAMES, with no glyphs attached.
//
// Split out of v2/trackIcons.tsx so the dev/e2e mock backend can mirror the engine's
// validation without importing React components: bridge.mock.ts stands in for MoshOps,
// and a backend that reached into the view layer to find out what it accepts would be
// the wrong shape even where it happens to work.
//
// The names are the persisted values (src/state/TrackIcons.h). Order is picker order and
// is a pure UI choice — reordering this array repaints no project file, which is the
// reason the engine stores names rather than indices into it.

export const TRACK_ICONS = [
  "drum", "perc", "bass", "guitar", "keys",
  "synth", "vocal", "strings", "fx", "sample",
] as const;

export type TrackIconName = (typeof TRACK_ICONS)[number];

/** Mirrors `mosh::trackIcons::isKnown` — callers normalize (trim + lowercase) first. */
export function isTrackIconName(name: string): name is TrackIconName {
  return (TRACK_ICONS as readonly string[]).includes(name);
}
