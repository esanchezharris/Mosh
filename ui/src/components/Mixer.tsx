import { useStore } from "../store";
import type { Snapshot, Track, Bus } from "../types";

// The mixing surface (Wave 5 + 8): a channel strip per track, aux sends to
// shared return buses, plus a master strip. Every control is a MoshOps command.
export function Mixer({ snapshot }: { snapshot: Snapshot }) {
  const master = snapshot.master;
  const exec = useStore((s) => s.exec);
  const buses = snapshot.buses ?? [];
  const sources = snapshot.tracks.filter((t) => !t.isReturn);
  const returns = snapshot.tracks.filter((t) => t.isReturn);

  return (
    <div className="mixer">
      <div className="mix-strips">
        <div className="mix-toolbar">
          <button onClick={() => exec("create_bus", { name: `Bus ${buses.length + 1}` })} title="Add a return bus">+ Bus</button>
        </div>
        {sources.map((t) => (
          <ChannelStrip key={t.id} track={t} buses={buses} />
        ))}
        {sources.length === 0 && <div className="rack-empty">no tracks</div>}
        {returns.length > 0 && <div className="mix-divider" />}
        {returns.map((t) => (
          <ReturnStrip key={t.id} track={t} />
        ))}
      </div>
      <div className="mix-master">
        <div className="strip master">
          <div className="strip-name">MASTER</div>
          <input className="pan" type="range" min={-1} max={1} step={0.01} value={master?.pan ?? 0}
            onChange={(e) => exec("set_master_pan", { pan: Number(e.target.value) })} title="Master pan" />
          <div className="fader-wrap">
            <input className="fader" type="range" min={-48} max={6} step={0.5} value={master?.volumeDb ?? -3}
              onChange={(e) => exec("set_master_volume", { db: Number(e.target.value) })} title="Master volume" />
          </div>
          <div className="strip-db">{(master?.volumeDb ?? -3).toFixed(1)} dB</div>
        </div>
      </div>
    </div>
  );
}

function StripCore({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  return (
    <>
      <input className="pan" type="range" min={-1} max={1} step={0.01} value={track.pan ?? 0}
        onChange={(e) => exec("set_track_pan", { trackId: track.id, pan: Number(e.target.value) })} title={`Pan ${(track.pan ?? 0).toFixed(2)}`} />
      <div className="fader-wrap">
        <input className="fader" type="range" min={-48} max={6} step={0.5} value={track.volumeDb ?? 0}
          onChange={(e) => exec("set_track_volume", { trackId: track.id, db: Number(e.target.value) })} title="Volume" />
      </div>
      <div className="strip-db">{(track.volumeDb ?? 0).toFixed(1)} dB</div>
      <div className="strip-ms">
        <button className={`mixbtn ${track.mute ? "mute-on" : ""}`} onClick={() => exec("set_track_mute", { trackId: track.id, mute: !track.mute })}>M</button>
        <button className={`mixbtn ${track.solo ? "solo-on" : ""}`} onClick={() => exec("set_track_solo", { trackId: track.id, solo: !track.solo })}>S</button>
      </div>
    </>
  );
}

function ChannelStrip({ track, buses }: { track: Track; buses: Bus[] }) {
  const exec = useStore((s) => s.exec);
  const setSelectedTrack = useStore((s) => s.setSelectedTrack);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const fxCount = (track.plugins ?? []).filter((p) => p.external || p.neural || p.builtin).length;
  const sends = track.sends ?? [];
  // Buses this track can still send to (not itself, not already sent).
  const addable = buses.filter((b) => b.trackId !== track.id && !sends.some((s) => s.bus === b.bus));

  return (
    <div className={`strip ${selectedTrackId === track.id ? "sel" : ""}`} onPointerDown={() => setSelectedTrack(track.id)}>
      <div className="strip-name" title={track.name}>{track.name || `Track ${track.index + 1}`}</div>
      {fxCount > 0 && <div className="strip-fx">{fxCount} fx</div>}
      <StripCore track={track} />
      {(sends.length > 0 || addable.length > 0) && (
        <div className="strip-sends">
          {sends.map((s) => {
            const b = buses.find((x) => x.bus === s.bus);
            return (
              <div className="send-row" key={s.bus} title={`Send to ${b?.name ?? `Bus ${s.bus + 1}`}`}>
                <span className="send-name">{(b?.name ?? `B${s.bus + 1}`).slice(0, 5)}</span>
                <input type="range" min={-60} max={6} step={0.5} value={s.db <= -60 ? -60 : s.db}
                  onChange={(e) => exec("set_send_level", { trackId: track.id, bus: s.bus, db: Number(e.target.value) })} />
                <button className="send-x" title="Remove send" onClick={() => exec("remove_send", { trackId: track.id, bus: s.bus })}>×</button>
              </div>
            );
          })}
          {addable.map((b) => (
            <button key={b.bus} className="send-add" title={`Send to ${b.name}`}
              onClick={() => exec("add_send", { trackId: track.id, bus: b.bus, db: 0 })}>
              + {b.name.slice(0, 6)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ReturnStrip({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const setSelectedTrack = useStore((s) => s.setSelectedTrack);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  return (
    <div className={`strip return ${selectedTrackId === track.id ? "sel" : ""}`} onPointerDown={() => setSelectedTrack(track.id)}>
      <div className="strip-name" title={track.name}><span className="rbadge">R</span> {track.name}</div>
      <StripCore track={track} />
      <button className="send-x bus-x" title="Remove bus" onClick={() => exec("remove_bus", { bus: track.returnBus })}>× Bus</button>
    </div>
  );
}
