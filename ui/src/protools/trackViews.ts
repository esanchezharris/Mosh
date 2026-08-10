import type { Track } from "../types";

export type ProToolsTrackView = "waveform" | "volume" | "clips" | "notes";

export type ProToolsTrackViewOption = {
  readonly value: ProToolsTrackView;
  readonly label: string;
};

const AUDIO_VIEWS: readonly ProToolsTrackViewOption[] = [
  { value: "waveform", label: "Waveform" },
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
  const options = proToolsTrackViewOptions(track);
  const current = resolveProToolsTrackView(track, requested);
  return options.find((option) => option.value !== current)?.value ?? current;
}
