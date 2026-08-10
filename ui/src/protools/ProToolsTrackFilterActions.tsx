import { MoshMenuItem } from "../chrome/Menu";
import type { Track } from "../types";
import type { TimeRangeSel } from "../v2/shellState";
import { useProToolsTimelineRange } from "./proToolsTimelineSelection";
import {
  PROTOOLS_TRACK_FILTERS,
  proToolsTrackIdsForFilter,
} from "./proToolsTrackFilters";

type ProToolsTrackFilterActionsProps = {
  readonly tracks: readonly Track[];
  readonly trackIds: readonly string[];
  readonly shownTrackIds: readonly string[];
  readonly showOnlyTrackIds: (
    trackIds: readonly string[],
    shownTrackIds: readonly string[],
  ) => void;
  readonly setShownTrackIds: (
    trackIds: readonly string[],
    shownTrackIds: readonly string[],
  ) => void;
};

export function ProToolsTrackFilterActions({
  tracks,
  trackIds,
  shownTrackIds,
  showOnlyTrackIds,
  setShownTrackIds,
}: ProToolsTrackFilterActionsProps) {
  const timelineSelection = useProToolsTimelineRange();

  return (
    <div className="pt-track-filter-actions">
      <TrackFilterGroup title="Show Only" action={(matchingIds) => {
        showOnlyTrackIds(trackIds, matchingIds);
      }} tracks={tracks} timelineSelection={timelineSelection} />
      <TrackFilterGroup title="Hide" action={(matchingIds) => {
        const hiddenIds = new Set(matchingIds);
        setShownTrackIds(
          trackIds,
          shownTrackIds.filter((trackId) => !hiddenIds.has(trackId)),
        );
      }} tracks={tracks} timelineSelection={timelineSelection} />
    </div>
  );
}

type TrackFilterGroupProps = {
  readonly title: "Show Only" | "Hide";
  readonly tracks: readonly Track[];
  readonly timelineSelection: TimeRangeSel | null;
  readonly action: (matchingIds: readonly string[]) => void;
};

function TrackFilterGroup({ title, tracks, timelineSelection, action }: TrackFilterGroupProps) {
  return (
    <div className="pt-track-filter-group" role="group" aria-label={`${title} track filters`}>
      <div className="pt-track-filter-title" aria-hidden="true">{title}</div>
      {PROTOOLS_TRACK_FILTERS.map((filter) => {
        const disabled = filter.needsTimelineSelection === true && timelineSelection === null;
        const matchingIds = proToolsTrackIdsForFilter(tracks, filter.id, timelineSelection);
        return (
          <MoshMenuItem
            key={filter.id}
            testId={`pt-track-filter-${title === "Show Only" ? "show" : "hide"}-${filter.id}`}
            ariaLabel={`${title} ${filter.label}`}
            disabled={disabled}
            onPick={() => action(matchingIds)}
          >
            <span className="pt-track-visibility-name">{filter.label}</span>
          </MoshMenuItem>
        );
      })}
    </div>
  );
}
