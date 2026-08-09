import { useStore } from "../store";
import { secondsToBBSMap, tempoMapFrom } from "../time";
import type { Snapshot } from "../types";
import { useProTools } from "./proToolsState";

type ProToolsStatusBarProps = {
  readonly snapshot: Snapshot | null;
};

function formatNudge(seconds: number): string {
  return seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(3)} s`;
}

export function ProToolsStatusBar({ snapshot }: ProToolsStatusBarProps) {
  const selection = useStore((state) => state.selection);
  const transport = useStore((state) => state.transport);
  const selectedTrackId = useStore((state) => state.selectedTrackId);
  const editMode = useProTools((state) => state.editMode);
  const activeTool = useProTools((state) => state.activeTool);
  const smartToolEnabled = useProTools((state) => state.smartToolEnabled);
  const nudgeValue = useProTools((state) => state.nudgeValue);
  const hoveredIntent = useProTools((state) => state.hoveredIntent);
  const selectedTrack = snapshot?.tracks.find((track) => track.id === selectedTrackId) ?? null;
  const selectedClips = snapshot?.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => selection.has(clip.id)) ?? [];
  const selectedClip = selectedClips.length === 1 ? selectedClips[0] : undefined;
  const map = tempoMapFrom(snapshot?.session);
  const readout = selectedClip
    ? `${selectedClip.name} · ${secondsToBBSMap(map, selectedClip.start)} · ${selectedClip.length.toFixed(2)} s`
    : selectedClips.length > 1
      ? `${selectedClips.length} clips selected`
      : `Position ${secondsToBBSMap(map, transport.position)}`;

  return (
    <footer className="pt-status-bar" data-testid="pt-status-bar" aria-label="Edit status">
      <span className="pt-status-readout" data-testid="pt-status-readout">{readout}</span>
      <span className="pt-status-field"><b>Mode</b> {editMode}</span>
      <span className="pt-status-field"><b>Tool</b> {activeTool}</span>
      <span className="pt-status-field"><b>Smart</b> {smartToolEnabled ? "on" : "off"}</span>
      <span className="pt-status-field"><b>Nudge</b> {formatNudge(nudgeValue)}</span>
      <span className="pt-status-field" aria-live="polite"><b>Intent</b> {hoveredIntent ?? "ready"}</span>
      {selectedTrack && (
        <span className="pt-status-track" data-testid="pt-status-track" title="Selected track">
          <span
            className="pt-status-track-dot"
            style={{ backgroundColor: selectedTrack.color ?? "var(--pt-selected)" }}
            aria-hidden="true"
          />
          {selectedTrack.name}
        </span>
      )}
    </footer>
  );
}
