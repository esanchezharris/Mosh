import { useStore } from "../store";
import type { Snapshot, Track } from "../types";

// The mixing surface (Wave 5): a channel strip per track plus a master strip.
// Every control is a MoshOps command (set_track_volume/pan/mute/solo,
// set_master_volume/pan) — the same spine the arrangement headers use.
export function Mixer({ snapshot }: { snapshot: Snapshot }) {
  const master = snapshot.master;
  const exec = useStore((s) => s.exec);
  return (
    <div className="mixer">
      <div className="mix-strips">
        {snapshot.tracks.map((t) => (
          <ChannelStrip key={t.id} track={t} />
        ))}
        {snapshot.tracks.length === 0 && <div className="rack-empty">no tracks</div>}
      </div>
      <div className="mix-master">
        <div className="strip master">
          <div className="strip-name">MASTER</div>
          <input
            className="pan"
            type="range" min={-1} max={1} step={0.01}
            value={master?.pan ?? 0}
            onChange={(e) => exec("set_master_pan", { pan: Number(e.target.value) })}
            title="Master pan"
          />
          <div className="fader-wrap">
            <input
              className="fader"
              type="range" min={-48} max={6} step={0.5}
              value={master?.volumeDb ?? -3}
              onChange={(e) => exec("set_master_volume", { db: Number(e.target.value) })}
              title="Master volume"
            />
          </div>
          <div className="strip-db">{(master?.volumeDb ?? -3).toFixed(1)} dB</div>
        </div>
      </div>
    </div>
  );
}

function ChannelStrip({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const setSelectedTrack = useStore((s) => s.setSelectedTrack);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const fxCount = (track.plugins ?? []).filter((p) => p.external || p.neural || p.builtin).length;
  return (
    <div
      className={`strip ${selectedTrackId === track.id ? "sel" : ""}`}
      onPointerDown={() => setSelectedTrack(track.id)}
    >
      <div className="strip-name" title={track.name}>{track.name || `Track ${track.index + 1}`}</div>
      {fxCount > 0 && <div className="strip-fx">{fxCount} fx</div>}
      <input
        className="pan"
        type="range" min={-1} max={1} step={0.01}
        value={track.pan ?? 0}
        onChange={(e) => exec("set_track_pan", { trackId: track.id, pan: Number(e.target.value) })}
        title={`Pan ${(track.pan ?? 0).toFixed(2)}`}
      />
      <div className="fader-wrap">
        <input
          className="fader"
          type="range" min={-48} max={6} step={0.5}
          value={track.volumeDb ?? 0}
          onChange={(e) => exec("set_track_volume", { trackId: track.id, db: Number(e.target.value) })}
          title="Volume"
        />
      </div>
      <div className="strip-db">{(track.volumeDb ?? 0).toFixed(1)} dB</div>
      <div className="strip-ms">
        <button className={`mixbtn ${track.mute ? "mute-on" : ""}`} onClick={() => exec("set_track_mute", { trackId: track.id, mute: !track.mute })}>M</button>
        <button className={`mixbtn ${track.solo ? "solo-on" : ""}`} onClick={() => exec("set_track_solo", { trackId: track.id, solo: !track.solo })}>S</button>
      </div>
    </div>
  );
}
