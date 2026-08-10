import { useStore } from "../store";
import { IconClose } from "../ui/icons";
import { PianoRoll } from "../ui/PianoRoll";
import { ProToolsDeviceRack } from "./ProToolsDeviceRack";
import { ProToolsTrackInspector } from "./ProToolsTrackInspector";

function formatSeconds(seconds: number): string {
  return `${Math.max(0, seconds).toFixed(3)} s`;
}

export function ProToolsDetailDock() {
  const snapshot = useStore((state) => state.snapshot);
  const editingClipId = useStore((state) => state.editingClipId);
  const selectedTrackId = useStore((state) => state.selectedTrackId);
  const closePianoRoll = useStore((state) => state.closePianoRoll);
  const selectedTrack = snapshot?.tracks.find((track) => track.id === selectedTrackId) ?? null;
  const match = editingClipId
    ? snapshot?.tracks
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
          <PianoRoll docked />
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
          <header className="pt-detail-head">
            <span className="pt-detail-title">Clip — {clip.name}</span>
            <button
              type="button"
              className="pt-detail-close"
              data-testid="pt-detail-close"
              aria-label="Close clip editor"
              title="Close clip editor"
              onClick={closePianoRoll}
            ><IconClose size={13} /></button>
          </header>
          <div className="pt-wave-inspector" data-testid="pt-wave-inspector">
            <div className="pt-wave-preview" aria-hidden="true">
              <span style={{ backgroundColor: track.color ?? "var(--pt-selected)" }} />
              <i /><i /><i /><i /><i /><i /><i />
            </div>
            <dl className="pt-clip-fields">
              <div><dt>Name</dt><dd>{clip.name}</dd></div>
              <div><dt>Track</dt><dd>{track.name}</dd></div>
              <div><dt>Start</dt><dd>{formatSeconds(clip.start)}</dd></div>
              <div><dt>Length</dt><dd>{formatSeconds(clip.length)}</dd></div>
              <div><dt>Fade In</dt><dd>{formatSeconds(clip.fadeInSec ?? 0)}</dd></div>
              <div><dt>Fade Out</dt><dd>{formatSeconds(clip.fadeOutSec ?? 0)}</dd></div>
            </dl>
          </div>
        </section>
      );
    }
    default: {
      const unreachable: never = match.clip.type;
      return unreachable;
    }
  }
}
