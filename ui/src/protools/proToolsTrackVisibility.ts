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
