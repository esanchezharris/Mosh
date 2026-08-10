import type { Track } from "../types";
import type { TimeRangeSel } from "../v2/shellState";

export type ProToolsTrackFilterId =
  | "audio"
  | "midi"
  | "instrument"
  | "inactive"
  | "frozen"
  | "with-clips"
  | "with-clips-in-timeline";

export type ProToolsTrackFilter = {
  readonly id: ProToolsTrackFilterId;
  readonly label: string;
  readonly needsTimelineSelection: boolean;
};

export const PROTOOLS_TRACK_FILTERS = [
  { id: "audio", label: "Audio Tracks", needsTimelineSelection: false },
  { id: "midi", label: "MIDI Tracks", needsTimelineSelection: false },
  { id: "instrument", label: "Instrument Tracks", needsTimelineSelection: false },
  { id: "inactive", label: "Inactive Tracks", needsTimelineSelection: false },
  { id: "frozen", label: "Frozen Tracks", needsTimelineSelection: false },
  { id: "with-clips", label: "Tracks With Clips", needsTimelineSelection: false },
  {
    id: "with-clips-in-timeline",
    label: "Tracks With Clips Within Timeline Selection",
    needsTimelineSelection: true,
  },
] as const satisfies readonly ProToolsTrackFilter[];

export function proToolsTrackIdsForFilter(
  tracks: readonly Track[],
  filterId: ProToolsTrackFilterId,
  timelineSelection: TimeRangeSel | null,
): readonly string[] {
  return tracks
    .filter((track) => proToolsTrackMatchesFilter(track, filterId, timelineSelection))
    .map((track) => track.id);
}

function proToolsTrackMatchesFilter(
  track: Track,
  filterId: ProToolsTrackFilterId,
  timelineSelection: TimeRangeSel | null,
): boolean {
  switch (filterId) {
    case "audio":
      return track.type !== "midi" && track.type !== "drum" && track.isInstrument !== true;
    case "midi":
      return track.type === "midi" && track.isInstrument !== true;
    case "instrument":
      return track.isInstrument === true || track.type === "drum";
    case "inactive":
      return track.active === false;
    case "frozen":
      return track.frozen === true;
    case "with-clips":
      return track.clips.some((clip) => clip.hidden !== true);
    case "with-clips-in-timeline":
      return timelineSelection !== null && track.clips.some((clip) => (
        clip.hidden !== true
        && clip.start < timelineSelection.end
        && clip.start + clip.length > timelineSelection.start
      ));
  }
}
