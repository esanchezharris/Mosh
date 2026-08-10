import { MoshMenu, MoshMenuItem } from "../chrome/Menu";
import { useStore } from "../store";
import type { Snapshot, Track } from "../types";
import { IconLayers, IconPlus } from "../ui/icons";
import { addTrackOfKind, TRACK_KINDS } from "../v2/lanes/TrackLaneList";
import { useProTools } from "./proToolsState";
import { proToolsEditTracks, proToolsShownTracks } from "./proToolsTrackVisibility";
import { scaledTrackHeights } from "./trackHeightZoom";
import { applyProToolsTrackControl, type ProToolsTrackControl } from "./proToolsTrackControls";
import { selectProToolsTrack } from "./proToolsTrackEditSelection";
import { ProToolsTrackListMenu } from "./ProToolsTrackListMenu";
import { ProToolsTrackGroupsPanel } from "./ProToolsTrackGroupsPanel";
import {
  proToolsPlaylistRowCount,
  proToolsTrackRowHeight,
  proToolsTrackViewOptions,
  resolveProToolsTrackView,
} from "./trackViews";

type ProToolsTrackHeadersProps = {
  readonly snapshot: Snapshot;
};

export function ProToolsTrackHeaders({ snapshot }: ProToolsTrackHeadersProps) {
  const trackVisibility = useProTools((state) => state.trackVisibility);
  const allTracks = proToolsEditTracks(snapshot.tracks);
  const tracks = proToolsShownTracks(allTracks, trackVisibility);

  return (
    <section className="pt-track-list" data-testid="pt-track-list" aria-label="Track List">
      <header className="pt-track-list-title">
        <span>Track List</span>
        <ProToolsTrackListMenu tracks={allTracks} />
      </header>
      <div className="pt-track-list-rows">
        {tracks.length === 0
          ? <p className="pt-track-list-empty" role="status">
              {allTracks.length === 0 ? "No tracks" : "No tracks shown"}
            </p>
          : tracks.map((track) => (
            <ProToolsTrackHeader key={track.id} track={track} tracks={tracks} />
          ))}
        <AddTrackMenu />
      </div>
      <ProToolsTrackGroupsPanel snapshot={snapshot} />
    </section>
  );
}

function ProToolsTrackHeader({ track, tracks }: {
  readonly track: Track;
  readonly tracks: readonly Track[];
}) {
  const selectedTrackId = useStore((state) => state.selectedTrackId);
  const clearSelection = useStore((state) => state.clearSelection);
  const closePianoRoll = useStore((state) => state.closePianoRoll);
  const requestedTrackView = useProTools((state) => state.trackViews[track.id]);
  const automationLaneVisible = useProTools((state) => Boolean(state.automationLanesVisible[track.id]));
  const trackHeightScale = useProTools((state) => state.trackHeightScale);
  const trackSelectionIds = useProTools((state) => state.trackSelectionIds);
  const setTrackView = useProTools((state) => state.setTrackView);
  const toggleAutomationLane = useProTools((state) => state.toggleAutomationLane);
  const selectedTrackIds = trackSelectionIds.length > 0
    ? trackSelectionIds
    : selectedTrackId ? [selectedTrackId] : [];
  const selected = selectedTrackIds.includes(track.id);
  const trackViewOptions = proToolsTrackViewOptions(track);
  const trackView = resolveProToolsTrackView(track, requestedTrackView);
  const playlistRows = proToolsPlaylistRowCount(track);
  const heights = scaledTrackHeights(trackHeightScale);
  const rowHeight = proToolsTrackRowHeight(track, trackView, automationLaneVisible, trackHeightScale);
  const active = track.active !== false;

  const selectTrack = (event: React.MouseEvent<HTMLButtonElement>) => {
    clearSelection();
    selectProToolsTrack(track.id, {
      additive: (event.metaKey || event.ctrlKey) && !event.shiftKey,
      range: event.shiftKey && !event.metaKey && !event.ctrlKey,
      visibleTrackIds: tracks.map((candidate) => candidate.id),
    });
    closePianoRoll();
  };
  const applyControl = (
    control: ProToolsTrackControl,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    const targetIds = event.altKey && event.shiftKey && selected
      ? selectedTrackIds
      : [track.id];
    void applyProToolsTrackControl(control, track.id, targetIds);
  };

  return (
    <div
      className="pt-track-header"
      data-testid="pt-track-header"
      data-track-id={track.id}
      data-selected={selected}
      data-track-active={active}
      data-track-view={trackView}
      data-track-height-compact={trackHeightScale < 1}
      style={{
        height: rowHeight,
        "--pt-main-lane-h": `${heights.main}px`,
        "--pt-playlist-row-h": `${heights.playlist}px`,
        "--pt-automation-h": `${heights.automation}px`,
      } as React.CSSProperties}
    >
      <span
        className="pt-track-color"
        style={{ backgroundColor: track.color ?? "var(--pt-selected)" }}
        aria-hidden="true"
      />
      <button
        type="button"
        className="pt-track-select"
        data-testid="pt-track-select"
        aria-label={`Select track ${track.name}${active ? "" : ", inactive"}`}
        aria-pressed={selected}
        onClick={selectTrack}
      >
        <span className="pt-track-index" aria-hidden="true">{track.index + 1}</span>
        <span className="pt-track-name" title={track.name}>{track.name}</span>
        <span className="pt-track-type">{active ? track.type : `${track.type} · Inactive`}</span>
      </button>
      <div className="pt-track-controls" role="group" aria-label={`${track.name} track controls`}>
        <button
          type="button"
          className="pt-track-arm"
          data-testid="pt-track-arm"
          aria-label={`Record-arm ${track.name}`}
          aria-pressed={Boolean(track.armed)}
          aria-keyshortcuts="Shift+R"
          onClick={(event) => applyControl("arm", event)}
        >R</button>
        <button
          type="button"
          className="pt-track-solo"
          data-testid="pt-track-solo"
          aria-label={`Solo ${track.name}`}
          aria-pressed={Boolean(track.solo)}
          aria-keyshortcuts="Shift+S"
          onClick={(event) => applyControl("solo", event)}
        >S</button>
        <button
          type="button"
          className="pt-track-mute"
          data-testid="pt-track-mute"
          aria-label={`Mute ${track.name}`}
          aria-pressed={Boolean(track.mute)}
          aria-keyshortcuts="Shift+M"
          onClick={(event) => applyControl("mute", event)}
        >M</button>
        <button
          type="button"
          className="pt-track-input"
          data-testid="pt-track-input-monitor"
          aria-label={`Input-monitor ${track.name}`}
          aria-pressed={track.monitor === "on"}
          aria-keyshortcuts="Shift+I"
          onClick={(event) => applyControl("input", event)}
        >I</button>
      </div>
      <span className="pt-track-route" title={track.output?.name ?? "Default output"}>
        {track.output?.name ?? "Default output"}
      </span>
      <div className="pt-track-view-controls">
        <label>
          <select data-testid="pt-track-view" aria-label={`${track.name} Track View`}
            value={trackView}
            onChange={(event) => {
              const option = trackViewOptions.find((candidate) => candidate.value === event.target.value);
              if (!option) return;
              const targets = selected
                ? tracks.filter((candidate) => selectedTrackIds.includes(candidate.id)
                  && proToolsTrackViewOptions(candidate).some((view) => view.value === option.value))
                : [track];
              targets.forEach((target) => setTrackView(target.id, option.value));
            }}>
            {trackViewOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <button type="button" className="pt-automation-lanes-toggle"
          data-testid="pt-automation-lanes"
          aria-label={`${automationLaneVisible ? "Hide" : "Show"} ${track.name} automation lane`}
          aria-pressed={automationLaneVisible}
          onClick={() => toggleAutomationLane(track.id)}>
          <IconLayers size={12} />
        </button>
      </div>
      {trackView === "playlists" && (
        <div className="pt-playlist-header-rows" data-testid="pt-playlist-header-rows">
          {playlistRows === 0 ? (
            <span data-testid="pt-playlist-header-row"
              style={{ height: heights.playlist }}>No alternate playlists</span>
          ) : Array.from({ length: playlistRows }, (_, takeIndex) => {
            const current = track.clips.some((clip) => clip.type === "wave"
              && (clip.numTakes ?? 0) > takeIndex
              && (clip.currentTakeIndex ?? 0) === takeIndex);
            return (
              <span key={takeIndex} data-testid="pt-playlist-header-row" data-current={current}
                style={{ height: heights.playlist }}>
                Playlist {takeIndex + 1}
              </span>
            );
          })}
          {automationLaneVisible && (
            <span className="pt-playlist-automation-label">Volume automation</span>
          )}
        </div>
      )}
    </div>
  );
}

function AddTrackMenu() {
  const exec = useStore((state) => state.exec);

  return (
    <MoshMenu
      label="Add track"
      align="start"
      trigger={
        <button type="button" className="pt-add-track" data-testid="pt-add-track">
          <IconPlus size={14} />
          <span>Add Track</span>
        </button>
      }
    >
      <div className="pt-menu" data-testid="pt-add-track-menu">
        {TRACK_KINDS.map(({ kind, label, hint }) => (
          <MoshMenuItem
            key={kind}
            testId={`pt-add-track-${kind}`}
            ariaLabel={`${label} track — ${hint}`}
            onPick={() => void addTrackOfKind(kind, exec)}
          >
            <span className="pt-menu-label">{label}</span>
            <span className="pt-menu-hint">{hint}</span>
          </MoshMenuItem>
        ))}
      </div>
    </MoshMenu>
  );
}
