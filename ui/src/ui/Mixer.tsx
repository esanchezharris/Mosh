// The mixing surface: a channel strip per track (pan / fader / mute / solo) plus
// a master strip. Every control is a command on the seam. (Sends / groups /
// returns / routing from the legacy Mixer are deferred to a later pass.)

import { useStore } from "../store";
import type { Snapshot, Track } from "../types";

export function Mixer({ snapshot }: { snapshot: Snapshot }) {
  // Continuous faders/pans coalesce via execLatest so a fast drag delivers only its
  // final value (and never races a stale snapshot); discrete toggles use exec.
  const execLatest = useStore((s) => s.execLatest);
  const master = snapshot.master;
  const tracks = snapshot.tracks.filter((t) => !t.isReturn);
  return (
    <div className="mixer" data-testid="mixer">
      <div className="mix-strips">
        {tracks.map((t) => <Strip key={t.id} track={t} />)}
        {tracks.length === 0 && <div className="rack-empty">no tracks</div>}
      </div>
      <div className="strip master" data-testid="master-strip">
        <div className="strip-name display">MASTER</div>
        <input className="pan" type="range" min={-1} max={1} step={0.01} value={master?.pan ?? 0}
          title="Master pan" onChange={(e) => execLatest("master:pan", "set_master_pan", { pan: Number(e.target.value) })} />
        <input className="fader" type="range" min={-48} max={6} step={0.5} value={master?.volumeDb ?? 0}
          title="Master volume" onChange={(e) => execLatest("master:vol", "set_master_volume", { db: Number(e.target.value) })} />
        <div className="strip-db tc">{(master?.volumeDb ?? 0).toFixed(1)} dB</div>
      </div>
    </div>
  );
}

function Strip({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const execLatest = useStore((s) => s.execLatest);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const setSelectedTrack = useStore((s) => s.setSelectedTrack);
  const fxCount = (track.plugins ?? []).filter((p) => p.external || p.neural || p.builtin).length;
  const selected = selectedTrackId === track.id;
  return (
    <div className={`strip${selected ? " sel" : ""}`} data-testid="channel-strip" data-track-id={track.id} data-selected={selected}
      onPointerDown={() => setSelectedTrack(track.id)}>
      <div className="strip-name" title={track.name}>{track.name}</div>
      {fxCount > 0 && <div className="strip-fx">{fxCount} fx</div>}
      <input className="pan" type="range" min={-1} max={1} step={0.01} value={track.pan ?? 0}
        title={`Pan ${(track.pan ?? 0).toFixed(2)}`} onChange={(e) => execLatest("pan:" + track.id, "set_track_pan", { trackId: track.id, pan: Number(e.target.value) })} />
      <input className="fader" type="range" min={-48} max={6} step={0.5} value={track.volumeDb ?? 0}
        title="Volume" onChange={(e) => execLatest("vol:" + track.id, "set_track_volume", { trackId: track.id, db: Number(e.target.value) })} />
      <div className="strip-db tc">{(track.volumeDb ?? 0).toFixed(1)} dB</div>
      <div className="strip-ms">
        <button className={`msx m${track.mute ? " on" : ""}`} data-state={track.mute ? "on" : "off"} aria-pressed={!!track.mute}
          onClick={(e) => { e.stopPropagation(); void exec("set_track_mute", { trackId: track.id, mute: !track.mute }); }}>M</button>
        <button className={`msx s${track.solo ? " on" : ""}`} data-state={track.solo ? "on" : "off"} aria-pressed={!!track.solo}
          onClick={(e) => { e.stopPropagation(); void exec("set_track_solo", { trackId: track.id, solo: !track.solo }); }}>S</button>
      </div>
    </div>
  );
}
