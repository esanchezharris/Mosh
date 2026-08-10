import type { Track } from "../types";
import { BASE_PLAYLIST_ROW_HEIGHT, scaledTrackHeights } from "./trackHeightZoom";

export type ProToolsTrackView = "waveform" | "playlists" | "volume" | "clips" | "notes";

export const PROTOOLS_PLAYLIST_ROW_HEIGHT = BASE_PLAYLIST_ROW_HEIGHT;

export type ProToolsTrackViewOption = {
  readonly value: ProToolsTrackView;
  readonly label: string;
};

const AUDIO_VIEWS: readonly ProToolsTrackViewOption[] = [
  { value: "waveform", label: "Waveform" },
  { value: "playlists", label: "Playlists" },
  { value: "volume", label: "Volume" },
];

const MIDI_VIEWS: readonly ProToolsTrackViewOption[] = [
  { value: "clips", label: "Clips" },
  { value: "notes", label: "Notes" },
];

export function proToolsTrackIsMidi(track: Track): boolean {
  return track.type === "midi" || track.type === "drum" || track.isInstrument === true;
}

export function proToolsTrackViewOptions(track: Track): readonly ProToolsTrackViewOption[] {
  return proToolsTrackIsMidi(track) ? MIDI_VIEWS : AUDIO_VIEWS;
}

export function defaultProToolsTrackView(track: Track): ProToolsTrackView {
  return proToolsTrackIsMidi(track) ? "clips" : "waveform";
}

export function resolveProToolsTrackView(
  track: Track,
  requested: ProToolsTrackView | undefined,
): ProToolsTrackView {
  return proToolsTrackViewOptions(track).some((option) => option.value === requested)
    ? requested as ProToolsTrackView
    : defaultProToolsTrackView(track);
}

export function nextCommonProToolsTrackView(
  track: Track,
  requested: ProToolsTrackView | undefined,
): ProToolsTrackView {
  const current = resolveProToolsTrackView(track, requested);
  if (proToolsTrackIsMidi(track)) return current === "notes" ? "clips" : "notes";
  return current === "volume" ? "waveform" : "volume";
}

export function proToolsPlaylistRowCount(track: Track): number {
  return track.clips.reduce((rows, clip) => clip.type === "wave"
    ? Math.max(rows, (clip.numTakes ?? 0) > 1 ? clip.numTakes ?? 0 : 0)
    : rows, 0);
}

export function proToolsTrackRowHeight(
  track: Track,
  requested: ProToolsTrackView | undefined,
  automationLaneVisible = false,
  trackHeightScale = 1,
): number {
  const heights = scaledTrackHeights(trackHeightScale);
  if (resolveProToolsTrackView(track, requested) !== "playlists") return heights.main;
  const playlistRows = Math.max(1, proToolsPlaylistRowCount(track));
  return heights.main
    + playlistRows * heights.playlist
    + (automationLaneVisible ? heights.automation : 0);
}
