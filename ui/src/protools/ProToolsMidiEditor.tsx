import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { Snapshot } from "../types";
import { PianoRoll } from "../ui/PianoRoll";
import {
  listMidiEditorTracks,
  projectMidiEditorContextNotes,
  type ProToolsMidiEditorTrack,
} from "./proToolsMidiEditorModel";

export function ProToolsMidiEditor({
  snapshot,
  targetClipId,
}: {
  readonly snapshot: Snapshot;
  readonly targetClipId: string;
}) {
  const projectEpoch = useStore((state) => state.projectEpoch);
  const openPianoRoll = useStore((state) => state.openPianoRoll);
  const setSelectedTrack = useStore((state) => state.setSelectedTrack);
  const tracks = listMidiEditorTracks(snapshot, targetClipId);
  const targetTrackId = tracks.find((track) => track.isTarget)?.trackId ?? null;
  const [visibleTrackIds, setVisibleTrackIds] = useState<readonly string[]>(
    () => targetTrackId ? [targetTrackId] : [],
  );
  const epochRef = useRef(projectEpoch);

  useEffect(() => {
    if (epochRef.current !== projectEpoch) {
      epochRef.current = projectEpoch;
      setVisibleTrackIds(targetTrackId ? [targetTrackId] : []);
      return;
    }
    if (!targetTrackId) return;
    setVisibleTrackIds((current) => (
      current.includes(targetTrackId) ? current : [...current, targetTrackId]
    ));
  }, [projectEpoch, targetTrackId]);

  const effectiveVisibleTrackIds = targetTrackId
    ? [...new Set([...visibleTrackIds, targetTrackId])]
    : [...visibleTrackIds];
  const contextNotes = projectMidiEditorContextNotes(
    snapshot,
    targetClipId,
    effectiveVisibleTrackIds,
  );
  const allVisible = tracks.length > 0
    && tracks.every((track) => effectiveVisibleTrackIds.includes(track.trackId));

  const toggleVisible = (track: ProToolsMidiEditorTrack): void => {
    if (track.isTarget) return;
    setVisibleTrackIds((current) => current.includes(track.trackId)
      ? current.filter((id) => id !== track.trackId)
      : [...current, track.trackId]);
  };

  const targetTrack = (track: ProToolsMidiEditorTrack): void => {
    setVisibleTrackIds((current) => current.includes(track.trackId)
      ? current
      : [...current, track.trackId]);
    setSelectedTrack(track.trackId);
    openPianoRoll(track.targetClipId);
  };

  return (
    <div className="pt-midi-editor" data-testid="pt-midi-editor">
      <aside className="pt-midi-track-list" data-testid="pt-midi-track-list"
        aria-label="MIDI Editor Track List">
        <div className="pt-midi-track-list-head">
          <strong>Tracks</strong>
          <button type="button" className="pt-midi-track-all"
            aria-label="Show all MIDI tracks" aria-pressed={allVisible}
            onClick={() => setVisibleTrackIds(allVisible && targetTrackId
              ? [targetTrackId]
              : tracks.map((track) => track.trackId))}>
            All
          </button>
        </div>
        <ul className="pt-midi-track-list-items">
          {tracks.map((track) => {
            const visible = effectiveVisibleTrackIds.includes(track.trackId);
            return (
              <li key={track.trackId} className="pt-midi-track-row"
                data-testid="pt-midi-track-row" data-track-id={track.trackId}
                data-target={track.isTarget}>
                <span className="pt-midi-track-color" aria-hidden="true"
                  style={track.color ? { backgroundColor: track.color } : undefined} />
                <span className="pt-midi-track-copy">
                  <strong>{track.trackName}</strong>
                  <small>{track.clipCount} {track.clipCount === 1 ? "clip" : "clips"}</small>
                </span>
                <button type="button" className="pt-midi-track-visible"
                  aria-label={`Show ${track.trackName}`} aria-pressed={visible}
                  disabled={track.isTarget} onClick={() => toggleVisible(track)}>
                  V
                </button>
                <button type="button" className="pt-midi-track-target"
                  aria-label={`Edit ${track.trackName}`} aria-pressed={track.isTarget}
                  onClick={() => targetTrack(track)}>
                  E
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
      <div className="pt-midi-editor-main">
        <PianoRoll docked contextNotes={contextNotes} />
      </div>
    </div>
  );
}
