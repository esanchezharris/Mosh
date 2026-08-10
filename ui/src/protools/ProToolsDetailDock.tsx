import { useStore } from "../store";
import { ProToolsAudioClipInspector } from "./ProToolsAudioClipInspector";
import { ProToolsDeviceRack } from "./ProToolsDeviceRack";
import { ProToolsMidiEditor } from "./ProToolsMidiEditor";
import { ProToolsTrackInspector } from "./ProToolsTrackInspector";

export function ProToolsDetailDock({ onOpenFades }: { readonly onOpenFades: () => void }) {
  const snapshot = useStore((state) => state.snapshot);
  const editingClipId = useStore((state) => state.editingClipId);
  const selectedTrackId = useStore((state) => state.selectedTrackId);
  const closePianoRoll = useStore((state) => state.closePianoRoll);
  if (!snapshot) return null;
  const selectedTrack = snapshot.tracks.find((track) => track.id === selectedTrackId) ?? null;
  const match = editingClipId
    ? snapshot.tracks
      .flatMap((track) => track.clips.map((clip) => ({ clip, track })))
      .find(({ clip }) => clip.id === editingClipId) ?? null
    : null;

  if (!match) return selectedTrack ? (
    <section className="pt-detail-dock pt-detail-devices" data-testid="pt-detail-dock"
      aria-label={`${selectedTrack.name} track inspector`}>
      <ProToolsTrackInspector track={selectedTrack} />
    </section>
  ) : null;

  switch (match.clip.type) {
    case "midi":
      return (
        <section className="pt-detail-dock pt-detail-midi" data-testid="pt-detail-dock" aria-label="MIDI clip editor">
          <ProToolsMidiEditor snapshot={snapshot} targetClipId={match.clip.id} />
        </section>
      );
    case "clip":
      return selectedTrack ? (
        <section className="pt-detail-dock pt-detail-devices" data-testid="pt-detail-dock"
          aria-label={`${selectedTrack.name} inserts`}>
          <ProToolsDeviceRack track={selectedTrack} />
        </section>
      ) : null;
    case "wave": {
      const { clip, track } = match;
      return (
        <section className="pt-detail-dock pt-detail-wave" data-testid="pt-detail-dock" aria-label="Audio clip editor">
          <ProToolsAudioClipInspector clip={clip} track={track} onClose={closePianoRoll}
            onOpenFades={onOpenFades} />
        </section>
      );
    }
    default: {
      const unreachable: never = match.clip.type;
      return unreachable;
    }
  }
}
