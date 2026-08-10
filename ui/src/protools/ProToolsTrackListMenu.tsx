import { MoshMenu, MoshMenuItem } from "../chrome/Menu";
import { useStore } from "../store";
import type { Track } from "../types";
import { IconCheck, IconLayers } from "../ui/icons";
import { useProTools } from "./proToolsState";

export function ProToolsTrackListMenu({ tracks }: { readonly tracks: readonly Track[] }) {
  const trackVisibility = useProTools((state) => state.trackVisibility);
  const trackSelectionIds = useProTools((state) => state.trackSelectionIds);
  const previousTrackVisibility = useProTools((state) => state.previousTrackVisibility);
  const setTrackShown = useProTools((state) => state.setTrackShown);
  const setShownTrackIds = useProTools((state) => state.setShownTrackIds);
  const showOnlyTrackIds = useProTools((state) => state.showOnlyTrackIds);
  const restorePreviouslyShownTracks = useProTools(
    (state) => state.restorePreviouslyShownTracks,
  );
  const selectedTrackId = useStore((state) => state.selectedTrackId);
  const selectedIds = trackSelectionIds.length > 0
    ? trackSelectionIds
    : selectedTrackId ? [selectedTrackId] : [];
  const selected = new Set(selectedIds);
  const trackIds = tracks.map((track) => track.id);
  const shownTrackIds = trackIds.filter((trackId) => trackVisibility[trackId] !== false);
  const shownSelectedIds = shownTrackIds.filter((trackId) => selected.has(trackId));
  const eligibleSelectedIds = trackIds.filter((trackId) => selected.has(trackId));

  return (
    <MoshMenu label="Track visibility" align="start" trigger={
      <button type="button" className="pt-track-list-menu-trigger"
        data-testid="pt-track-visibility-menu" aria-label="Track visibility"
        disabled={tracks.length === 0}>
        <IconLayers size={12} />
      </button>}>
      <div className="pt-menu pt-track-visibility-menu" data-testid="pt-track-visibility-options">
        <div className="pt-track-visibility-actions">
          <MoshMenuItem testId="pt-track-visibility-show-all" ariaLabel="Show All Tracks"
            disabled={shownTrackIds.length === trackIds.length}
            onPick={() => setShownTrackIds(trackIds, trackIds)}>
            <span className="pt-track-visibility-name">Show All Tracks</span>
          </MoshMenuItem>
          <MoshMenuItem testId="pt-track-visibility-show-selected"
            ariaLabel="Show Only Selected Tracks" disabled={eligibleSelectedIds.length === 0}
            onPick={() => showOnlyTrackIds(trackIds, eligibleSelectedIds)}>
            <span className="pt-track-visibility-name">Show Only Selected Tracks</span>
          </MoshMenuItem>
          <MoshMenuItem testId="pt-track-visibility-hide-all" ariaLabel="Hide All Tracks"
            disabled={shownTrackIds.length === 0}
            onPick={() => setShownTrackIds(trackIds, [])}>
            <span className="pt-track-visibility-name">Hide All Tracks</span>
          </MoshMenuItem>
          <MoshMenuItem testId="pt-track-visibility-hide-selected"
            ariaLabel="Hide Selected Tracks" disabled={shownSelectedIds.length === 0}
            onPick={() => setShownTrackIds(
              trackIds,
              shownTrackIds.filter((trackId) => !selected.has(trackId)),
            )}>
            <span className="pt-track-visibility-name">Hide Selected Tracks</span>
          </MoshMenuItem>
          <MoshMenuItem testId="pt-track-visibility-restore"
            ariaLabel="Restore Previously Shown Tracks" disabled={previousTrackVisibility === null}
            onPick={restorePreviouslyShownTracks}>
            <span className="pt-track-visibility-name">Restore Previously Shown Tracks</span>
          </MoshMenuItem>
        </div>
        {tracks.map((track) => {
          const shown = trackVisibility[track.id] !== false;
          return (
            <MoshMenuItem key={track.id} testId={`pt-track-visibility-${track.id}`}
              ariaLabel={`${shown ? "Hide" : "Show"} ${track.name} track`}
              onPick={() => setTrackShown(track.id, !shown)}>
              <span className="pt-track-visibility-state" data-shown={shown} aria-hidden="true">
                {shown ? <IconCheck size={12} /> : null}
              </span>
              <span className="pt-track-visibility-name">{track.name}</span>
            </MoshMenuItem>
          );
        })}
      </div>
    </MoshMenu>
  );
}
