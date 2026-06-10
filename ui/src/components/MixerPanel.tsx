import { useStore } from "../store";
import type { Snapshot, Track, Plugin } from "../types";

// The mixer (Stage 17): channel strips over the existing commands — fader,
// pan, M/S, meter, output routing (route_track), sends (add_send /
// set_send_gain / remove_plugin) and bus creation (create_track + add_return).
// This closes the audit's biggest parity gap: sends/returns/routing were
// agent-only since Stage 7.

const isReturnTrack = (t: Track) => (t.plugins ?? []).some((p) => p.type === "auxreturn");
const busOf = (t: Track) => (t.plugins ?? []).find((p) => p.type === "auxreturn")?.busNumber;

export function MixerPanel({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((s) => s.exec);
  const setMixerOpen = useStore((s) => s.setMixerOpen);
  const session = snapshot.session;

  const buses = snapshot.tracks.filter(isReturnTrack);
  const nextBus = buses.length ? Math.max(...buses.map((b) => busOf(b) ?? 0)) + 1 : 1;

  const master = snapshot.transport.levels?.master;
  const mdb = master ? Math.max(master[0], master[1]) : -100;

  return (
    <div className="mixer">
      <div className="mx-head">
        <span className="mx-title">mixer</span>
        <span className="pr-hint">out: routing · sends ride the bus tracks</span>
        <button className="mini" onClick={() => setMixerOpen(false)}>✕</button>
      </div>
      <div className="mx-strips">
        {snapshot.tracks.map((t) => (
          <Strip key={t.id} track={t} snapshot={snapshot} nextBus={nextBus} />
        ))}
        {/* master strip */}
        <div className="mx-strip master">
          <div className="mx-name">master</div>
          <div className="mx-spacer" />
          <Meter db={mdb} />
          <input
            className="mx-fader"
            type="range"
            min={-48}
            max={6}
            step={0.5}
            value={session.masterVolumeDb ?? 0}
            title={`Master ${(session.masterVolumeDb ?? 0).toFixed(1)} dB`}
            onChange={(e) => exec("set_master_volume", { db: Number(e.target.value) })}
          />
        </div>
      </div>
    </div>
  );
}

function Meter({ db }: { db: number }) {
  const pct = Math.max(0, Math.min(1, (db + 60) / 60)) * 100;
  return (
    <div className="mx-meter">
      <span className={db > -1 ? "hot" : db > -9 ? "warm" : ""} style={{ height: `${pct}%` }} />
    </div>
  );
}

function Strip({ track, snapshot, nextBus }: { track: Track; snapshot: Snapshot; nextBus: number }) {
  const exec = useStore((s) => s.exec);
  const level = useStore((s) => s.snapshot?.transport.levels?.tracks?.[track.id]);
  const db = level ? Math.max(level[0], level[1]) : -100;

  const sends = (track.plugins ?? []).filter((p) => p.type === "auxsend");
  const buses = snapshot.tracks.filter((t) => isReturnTrack(t) && t.id !== track.id);
  const isBus = isReturnTrack(track);

  // Add a send to an existing bus, or create a fresh bus track + return first.
  const addSend = async (value: string) => {
    if (value === "new") {
      const res = await exec("create_track", { name: `Bus ${nextBus}` });
      const busTrackId = (res.data as { trackId?: string } | undefined)?.trackId;
      if (!busTrackId) return;
      await exec("add_return", { trackId: busTrackId, busNumber: nextBus });
      await exec("add_send", { trackId: track.id, busNumber: nextBus, gainDb: -6 });
    } else if (value) {
      await exec("add_send", { trackId: track.id, busNumber: Number(value), gainDb: -6 });
    }
  };

  return (
    <div className={`mx-strip ${isBus ? "bus" : ""}`}>
      <div className="mx-name" title={track.name}>
        {isBus ? `🚌 ${track.name}` : track.name || `Track ${track.index + 1}`}
      </div>

      {/* output routing */}
      <select
        className="mx-out"
        value={track.routeTo ?? ""}
        title="Output routing"
        onChange={(e) => exec("route_track", { trackId: track.id, destTrackId: e.target.value })}
      >
        <option value="">→ master</option>
        {snapshot.tracks
          .filter((t) => t.id !== track.id)
          .map((t) => (
            <option key={t.id} value={t.id}>→ {t.name || `Track ${t.index + 1}`}</option>
          ))}
      </select>

      {/* sends */}
      <div className="mx-sends">
        {sends.map((s) => (
          <SendRow key={s.index} send={s} trackId={track.id} />
        ))}
        {!isBus && (
          <select className="mx-addsend" value="" onChange={(e) => void addSend(e.target.value)}>
            <option value="" disabled>+ send</option>
            {buses.map((b) => (
              <option key={b.id} value={busOf(b)}>→ {b.name}</option>
            ))}
            <option value="new">new bus…</option>
          </select>
        )}
      </div>

      <div className="mx-spacer" />
      <div className="mx-bottom">
        <Meter db={db} />
        <input
          className="mx-fader"
          type="range"
          min={-48}
          max={6}
          step={0.5}
          value={track.volumeDb ?? 0}
          title={`${(track.volumeDb ?? 0).toFixed(1)} dB`}
          onChange={(e) => exec("set_track_volume", { trackId: track.id, db: Number(e.target.value) })}
        />
      </div>
      <input
        className="pan mx-pan"
        type="range"
        min={-1}
        max={1}
        step={0.05}
        value={track.pan ?? 0}
        title={`Pan ${((track.pan ?? 0) * 100).toFixed(0)}`}
        onDoubleClick={() => exec("set_track_pan", { trackId: track.id, pan: 0 })}
        onChange={(e) => exec("set_track_pan", { trackId: track.id, pan: Number(e.target.value) })}
      />
      <div className="mx-ms">
        <button
          className={`mixbtn ${track.mute ? "mute-on" : ""}`}
          onClick={() => exec("set_track_mute", { trackId: track.id, mute: !track.mute })}
        >M</button>
        <button
          className={`mixbtn ${track.solo ? "solo-on" : ""}`}
          onClick={() => exec("set_track_solo", { trackId: track.id, solo: !track.solo })}
        >S</button>
      </div>
    </div>
  );
}

function SendRow({ send, trackId }: { send: Plugin; trackId: string }) {
  const exec = useStore((s) => s.exec);
  return (
    <div className="mx-send" title={`Send → bus ${send.busNumber}`}>
      <span className="mx-send-bus">B{send.busNumber}</span>
      <input
        type="range"
        min={-48}
        max={6}
        step={0.5}
        value={send.gainDb ?? 0}
        title={`${(send.gainDb ?? 0).toFixed(1)} dB`}
        onChange={(e) => exec("set_send_gain", { trackId, index: send.index, gainDb: Number(e.target.value) })}
      />
      <button
        className="mini"
        title="Remove send"
        onClick={() => exec("remove_plugin", { trackId, index: send.index })}
      >✕</button>
    </div>
  );
}
