import { MoshMenu, MoshMenuItem } from "../chrome/Menu";
import { useStore } from "../store";
import type { Snapshot, Track } from "../types";
import { IconLayers, IconPlus } from "../ui/icons";
import { addTrackOfKind, TRACK_KINDS } from "../v2/lanes/TrackLaneList";
import { appliedFailure } from "./commandFeedback";
import { useProTools } from "./proToolsState";
import { scaledTrackHeights } from "./trackHeightZoom";
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
  const tracks = snapshot.tracks.filter((track) => !track.isGroup && !track.isReturn);

  return (
    <section className="pt-track-list" data-testid="pt-track-list" aria-label="Track List">
      <header className="pt-track-list-title">Track List</header>
      <div className="pt-track-list-rows">
        {tracks.length === 0
          ? <p className="pt-track-list-empty" role="status">No tracks</p>
          : tracks.map((track) => <ProToolsTrackHeader key={track.id} track={track} />)}
        <AddTrackMenu />
      </div>
    </section>
  );
}

function ProToolsTrackHeader({ track }: { readonly track: Track }) {
  const exec = useStore((state) => state.exec);
  const selectedTrackId = useStore((state) => state.selectedTrackId);
  const clearSelection = useStore((state) => state.clearSelection);
  const setSelectedTrack = useStore((state) => state.setSelectedTrack);
  const closePianoRoll = useStore((state) => state.closePianoRoll);
  const setLastError = useStore((state) => state.setLastError);
  const requestedTrackView = useProTools((state) => state.trackViews[track.id]);
  const automationLaneVisible = useProTools((state) => Boolean(state.automationLanesVisible[track.id]));
  const trackHeightScale = useProTools((state) => state.trackHeightScale);
  const setTrackView = useProTools((state) => state.setTrackView);
  const toggleAutomationLane = useProTools((state) => state.toggleAutomationLane);
  const selected = selectedTrackId === track.id;
  const trackViewOptions = proToolsTrackViewOptions(track);
  const trackView = resolveProToolsTrackView(track, requestedTrackView);
  const playlistRows = proToolsPlaylistRowCount(track);
  const heights = scaledTrackHeights(trackHeightScale);
  const rowHeight = proToolsTrackRowHeight(track, trackView, automationLaneVisible, trackHeightScale);

  const selectTrack = () => {
    clearSelection();
    setSelectedTrack(track.id);
    closePianoRoll();
  };
  const toggleArm = async () => {
    const result = await exec("arm_track", { trackId: track.id, armed: !track.armed });
    const failure = appliedFailure(result, "Record arm could not be applied.");
    if (failure) setLastError(failure);
  };

  return (
    <div
      className="pt-track-header"
      data-testid="pt-track-header"
      data-track-id={track.id}
      data-selected={selected}
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
        aria-label={`Select track ${track.name}`}
        aria-pressed={selected}
        onClick={selectTrack}
      >
        <span className="pt-track-index" aria-hidden="true">{track.index + 1}</span>
        <span className="pt-track-name" title={track.name}>{track.name}</span>
        <span className="pt-track-type">{track.type}</span>
      </button>
      <div className="pt-track-controls" role="group" aria-label={`${track.name} track controls`}>
        <button
          type="button"
          className="pt-track-arm"
          data-testid="pt-track-arm"
          aria-label={`Record-arm ${track.name}`}
          aria-pressed={Boolean(track.armed)}
          onClick={() => void toggleArm()}
        >R</button>
        <button
          type="button"
          className="pt-track-solo"
          data-testid="pt-track-solo"
          aria-label={`Solo ${track.name}`}
          aria-pressed={Boolean(track.solo)}
          onClick={() => void exec("set_track_solo", { trackId: track.id, solo: !track.solo })}
        >S</button>
        <button
          type="button"
          className="pt-track-mute"
          data-testid="pt-track-mute"
          aria-label={`Mute ${track.name}`}
          aria-pressed={Boolean(track.mute)}
          onClick={() => void exec("set_track_mute", { trackId: track.id, mute: !track.mute })}
        >M</button>
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
              if (option) setTrackView(track.id, option.value);
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
