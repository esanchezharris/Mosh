// Inspector right-rail (redesign shell). Shows the selected track's mix controls —
// name + meter + mute/solo + volume + pan — reusing the same command seam the track
// headers use. Per-track FX live in the inline FX drawer; deep plugin params live in
// the plugin's own window. (Sends + selected-item params land in a later pass.)
import type { Snapshot } from "../types";
import { useStore } from "../store";
import { Meter } from "./Meter";
import { GenDrawer } from "./Dock";

export function Inspector({ snapshot }: { snapshot: Snapshot }) {
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const exec = useStore((s) => s.exec);
  const track = snapshot.tracks.find((t) => t.id === selectedTrackId);

  if (!track) {
    return (
      <div className="inspector" data-testid="inspector">
        <div className="inspector-head">Inspector</div>
        <div className="inspector-body">Select a track to see its controls.</div>
      </div>
    );
  }

  const vol = track.volumeDb ?? 0;
  const pan = track.pan ?? 0;
  const panLabel = pan === 0 ? "C" : pan < 0 ? `L${Math.round(-pan * 100)}` : `R${Math.round(pan * 100)}`;

  return (
    <div className="inspector" data-testid="inspector" data-track-id={track.id}>
      <div className="inspector-head">Inspector</div>
      <div className="insp-track">
        <span className="insp-name" title={track.name}>{track.name}</span>
        <Meter trackId={track.id} />
      </div>
      <div className="insp-row">
        <button className={`msx m${track.mute ? " on" : ""}`} aria-pressed={!!track.mute} title="Mute"
          onClick={() => void exec("set_track_mute", { trackId: track.id, mute: !track.mute })}>M</button>
        <button className={`msx s${track.solo ? " on" : ""}`} aria-pressed={!!track.solo} title="Solo"
          onClick={() => void exec("set_track_solo", { trackId: track.id, solo: !track.solo })}>S</button>
      </div>
      <label className="insp-field">
        <span>Volume</span>
        <input type="range" min={-60} max={6} step={0.5} value={vol}
          onChange={(e) => void exec("set_track_volume", { trackId: track.id, db: Number(e.target.value) })} />
        <span className="insp-val tc">{vol.toFixed(1)} dB</span>
      </label>
      <label className="insp-field">
        <span>Pan</span>
        <input type="range" min={-1} max={1} step={0.02} value={pan}
          onChange={(e) => void exec("set_track_pan", { trackId: track.id, pan: Number(e.target.value) })} />
        <span className="insp-val tc">{panLabel}</span>
      </label>
      <GenDrawer track={track} />
    </div>
  );
}
