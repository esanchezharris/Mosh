// The mixing surface: a channel strip per track (pan / fader / mute / solo, plus a
// send knob per FX bus), the return strips for each bus, a "+ Bus" button to spin
// up a new aux return, and a master strip. Every control is a command on the seam
// (create_bus / add_send / set_send_level / remove_send / set_track_*). The
// gesture→command mapping lives in mixerSendUtil.ts so it can be unit-tested
// without React (mixerSendUtil.test.ts).

import { useStore } from "../store";
import type { Snapshot, Track, Bus } from "../types";
import { Moshi } from "./Moshi";
import {
  SEND_DB_MIN,
  SEND_DB_MAX,
  busesOf,
  returnStripsOf,
  channelTracksOf,
  findSend,
  addBusCommand,
  addSendCommand,
  setSendLevelCommand,
  removeSendCommand,
} from "./mixerSendUtil";

export function Mixer({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((s) => s.exec);
  const master = snapshot.master;
  const buses = busesOf(snapshot);
  const tracks = channelTracksOf(snapshot);
  const returns = returnStripsOf(snapshot);
  return (
    <div className="mixer" data-testid="mixer">
      <div className="mix-strips">
        {tracks.map((t) => <Strip key={t.id} track={t} buses={buses} />)}
        {tracks.length === 0 && <div className="rack-empty">no tracks</div>}
      </div>
      {returns.length > 0 && (
        <div className="mix-returns" data-testid="mix-returns">
          {returns.map((t) => <ReturnStrip key={t.id} track={t} />)}
        </div>
      )}
      <button className="btn ghost add-bus" data-testid="add-bus"
        title="Add an FX send bus (return track)"
        onClick={() => void exec(addBusCommand().command, addBusCommand().args)}>+ Bus</button>
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

function Strip({ track, buses }: { track: Track; buses: Bus[] }) {
  const exec = useStore((s) => s.exec);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const setSelectedTrack = useStore((s) => s.setSelectedTrack);
  const fxCount = (track.plugins ?? []).filter((p) => p.external || p.builtin).length;
  const selected = selectedTrackId === track.id;
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
      {buses.length > 0 && (
        <div className="strip-sends" data-testid="strip-sends">
          {buses.map((b) => <SendControl key={b.bus} track={track} bus={b} />)}
        </div>
      )}
    </div>
  );
}

// One send: a horizontal slider to a bus. With no send yet, moving it ADDS the send
// at that level; with a send, it sets the level. Active sends get a remove (×).
function SendControl({ track, bus }: { track: Track; bus: Bus }) {
  const exec = useStore((s) => s.exec);
  const send = findSend(track, bus.bus);
  const active = send != null;
  const db = send?.db ?? SEND_DB_MIN;
  const onLevel = (db: number) => {
    const c = active ? setSendLevelCommand(track.id, bus.bus, db) : addSendCommand(track.id, bus.bus, db);
    void exec(c.command, c.args);
  };
  return (
    <div className={`send${active ? " on" : ""}`} data-testid="send" data-bus={bus.bus} data-active={active}>
      <span className="send-name" title={`Send to ${bus.name}`}>{bus.name}</span>
      <input className="send-level" type="range" min={SEND_DB_MIN} max={SEND_DB_MAX} step={0.5}
        value={db} title={`${bus.name} send ${db.toFixed(1)} dB`}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => onLevel(Number(e.target.value))} />
      {active && (
        <button className="msx x send-rm" title={`Remove send to ${bus.name}`}
          onClick={(e) => { e.stopPropagation(); const c = removeSendCommand(track.id, bus.bus); void exec(c.command, c.args); }}>×</button>
      )}
    </div>
  );
}

// A return strip: an FX bus's return track. Level + pan + mute, and a remove that
// drops the whole bus (and sweeps its sends) via remove_bus.
function ReturnStrip({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  return (
    <div className="strip return" data-testid="return-strip" data-track-id={track.id} data-return-bus={track.returnBus}>
      <div className="strip-name" title={track.name}>{track.name}</div>
      <div className="strip-fx">RETURN</div>
      <input className="pan" type="range" min={-1} max={1} step={0.01} value={track.pan ?? 0}
        title={`Pan ${(track.pan ?? 0).toFixed(2)}`} onChange={(e) => void exec("set_track_pan", { trackId: track.id, pan: Number(e.target.value) })} />
      <input className="fader" type="range" min={-48} max={6} step={0.5} value={track.volumeDb ?? 0}
        title="Return volume" onChange={(e) => void exec("set_track_volume", { trackId: track.id, db: Number(e.target.value) })} />
      <div className="strip-db tc">{(track.volumeDb ?? 0).toFixed(1)} dB</div>
      <div className="strip-ms">
        <button className={`msx m${track.mute ? " on" : ""}`} data-state={track.mute ? "on" : "off"} aria-pressed={!!track.mute}
          onClick={() => void exec("set_track_mute", { trackId: track.id, mute: !track.mute })}>M</button>
        {track.returnBus != null && (
          <button className="msx x" title={`Remove the ${track.name} bus`}
            onClick={() => void exec("remove_bus", { bus: track.returnBus })}>×</button>
        )}
      </div>
    </div>
  );
}
