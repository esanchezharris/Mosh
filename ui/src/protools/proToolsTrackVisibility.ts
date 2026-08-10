import type { Track } from "../types";

export type ProToolsTrackVisibility = Readonly<Record<string, boolean>>;

export function proToolsEditTracks(tracks: readonly Track[]): readonly Track[] {
  return tracks.filter((track) => !track.isGroup && !track.isReturn);
}

export function proToolsShownTracks(
  tracks: readonly Track[],
  visibility: ProToolsTrackVisibility,
): readonly Track[] {
  return proToolsEditTracks(tracks).filter((track) => visibility[track.id] !== false);
}

export function proToolsVisibilityForShownTracks(
  trackIds: readonly string[],
  shownTrackIds: readonly string[],
): ProToolsTrackVisibility {
  const shown = new Set(shownTrackIds);
  return Object.fromEntries(
    trackIds.filter((trackId) => !shown.has(trackId)).map((trackId) => [trackId, false] as const),
  );
}
