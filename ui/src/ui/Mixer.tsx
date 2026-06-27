// The mixing surface: a channel strip per track (pan / fader / mute / solo /
// out) plus a master strip. Every control is a command on the seam. (Sends /
// groups / returns from the legacy Mixer are deferred to a later pass.)

import { useEffect } from "react";
import { useStore } from "../store";
import type { Snapshot, Track } from "../types";
import { Moshi } from "./Moshi";
import { routingOptions, routingArgs, currentRoutingValue } from "./routingUtil";

export function Mixer({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((s) => s.exec);
  const loadRouting = useStore((s) => s.loadRouting);
  const master = snapshot.master;
  const tracks = snapshot.tracks.filter((t) => !t.isReturn);
  // G8 — fetch the routing enumeration once when the mixer mounts (lazy +
  // native-guarded inside the store action; a no-op under the dev mock when
  // not native, so the out: selector only appears once trackOutputs is known).
  useEffect(() => { void loadRouting(); }, [loadRouting]);
  return (
    <div className="mixer" data-testid="mixer">
      <div className="mix-strips">
        {tracks.map((t) => <Strip key={t.id} track={t} />)}
        {tracks.length === 0 && <div className="rack-empty">no tracks</div>}
      </div>
      <div className="strip master" data-testid="master-strip">
        <div className="strip-name display">MASTER</div>
        <input className="pan" type="range" min={-1} max={1} step={0.01} value={master?.pan ?? 0}
          title="Master pan" onChange={(e) => void exec("set_master_pan", { pan: Number(e.target.value) })} />
        <input className="fader" type="range" min={-48} max={6} step={0.5} value={master?.volumeDb ?? 0}
          title="Master volume" onChange={(e) => void exec("set_master_volume", { db: Number(e.target.value) })} />
        <div className="strip-db tc">{(master?.volumeDb ?? 0).toFixed(1)} dB</div>
      </div>
      <Moshi />
    </div>
  );
}

function Strip({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const setSelectedTrack = useStore((s) => s.setSelectedTrack);
  const trackOutputs = useStore((s) => s.trackOutputs);
  const fxCount = (track.plugins ?? []).filter((p) => p.external || p.builtin).length;
  const selected = selectedTrackId === track.id;
  // G8 — the out: routing selector. Only when the routing enumeration is loaded
  // (native); under the dev mock when not native it stays hidden. Every change is
  // one mutation: exec("set_track_output", …) — the single seam command.
  const outOptions = routingOptions(track.id, trackOutputs);
  return (
    <div className={`strip${selected ? " sel" : ""}`} data-testid="channel-strip" data-track-id={track.id} data-selected={selected}
      onPointerDown={() => setSelectedTrack(track.id)}>
      <div className="strip-name" title={track.name}>{track.name}</div>
      {fxCount > 0 && <div className="strip-fx">{fxCount} fx</div>}
      <input className="pan" type="range" min={-1} max={1} step={0.01} value={track.pan ?? 0}
        title={`Pan ${(track.pan ?? 0).toFixed(2)}`} onChange={(e) => void exec("set_track_pan", { trackId: track.id, pan: Number(e.target.value) })} />
      <input className="fader" type="range" min={-48} max={6} step={0.5} value={track.volumeDb ?? 0}
        title="Volume" onChange={(e) => void exec("set_track_volume", { trackId: track.id, db: Number(e.target.value) })} />
      <div className="strip-db tc">{(track.volumeDb ?? 0).toFixed(1)} dB</div>
      <div className="strip-ms">
        <button className={`msx m${track.mute ? " on" : ""}`} data-state={track.mute ? "on" : "off"} aria-pressed={!!track.mute}
          onClick={(e) => { e.stopPropagation(); void exec("set_track_mute", { trackId: track.id, mute: !track.mute }); }}>M</button>
        <button className={`msx s${track.solo ? " on" : ""}`} data-state={track.solo ? "on" : "off"} aria-pressed={!!track.solo}
          onClick={(e) => { e.stopPropagation(); void exec("set_track_solo", { trackId: track.id, solo: !track.solo }); }}>S</button>
      </div>
      {outOptions.length > 0 && (
        <label className="strip-out" data-testid="strip-out" title="Output routing">
          <span className="strip-out-lbl">out:</span>
          <select
            aria-label={`Output for ${track.name}`}
            value={currentRoutingValue(track)}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => void exec("set_track_output", routingArgs(track.id, e.target.value))}>
            {outOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}
