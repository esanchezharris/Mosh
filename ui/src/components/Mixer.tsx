import { useEffect } from "react";
import { useStore } from "../store";
import type { Snapshot, Track, Bus } from "../types";
import { Meter } from "./Meter";

// The mixing surface (Wave 5 + 8 + 9): a channel strip per track with a live
// level meter, aux sends to shared return buses, plus a master strip. Every
// control is a MoshOps command.
export function Mixer({ snapshot }: { snapshot: Snapshot }) {
  const master = snapshot.master;
  const exec = useStore((s) => s.exec);

  // Opening the mixer turns metering on for every track (opt-in keeps the
  // command surface / headless runs clean) and loads the routing enumerations
  // (RTG-001/002 input + output choices, lazy like the device lists).
  const loadRouting = useStore((s) => s.loadRouting);
  useEffect(() => { void exec("enable_all_meters", {}); void loadRouting(); }, [exec, loadRouting]);
  const buses = snapshot.buses ?? [];
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const sources = snapshot.tracks.filter((t) => !t.isReturn && !t.isGroup);
  const returns = snapshot.tracks.filter((t) => t.isReturn);
  const groups = snapshot.tracks.filter((t) => t.isGroup);

  return (
    <div className="mixer">
      <div className="mix-strips">
        <div className="mix-toolbar">
          <button onClick={() => exec("create_bus", { name: `Bus ${buses.length + 1}` })} title="Add a return bus">+ Bus</button>
          <button
            title={selectedTrackId ? "Group the selected track (submix)" : "Select a track first"}
            disabled={!selectedTrackId}
            onClick={() =>
              exec("create_group_track", {
                name: `Group ${groups.length + 1}`,
                trackIds: selectedTrackId ? [selectedTrackId] : [],
              })
            }
          >
            + Group
          </button>
        </div>
        {sources.map((t) => (
          <ChannelStrip key={t.id} track={t} buses={buses} />
        ))}
        {sources.length === 0 && <div className="rack-empty">no tracks</div>}
        {(returns.length > 0 || groups.length > 0) && <div className="mix-divider" />}
        {groups.map((t) => (
          <GroupStrip key={t.id} track={t} />
        ))}
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
            <Meter master />
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
        <Meter trackId={track.id} />
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

  // RTG-001/002 — routing selectors (enumerations are lazy-loaded by the Mixer).
  const waveInputs = useStore((s) => s.waveInputs) ?? [];
  const trackOutputs = useStore((s) => s.trackOutputs);
  const outputValue = track.output ? (track.output.isTrack ? `t:${track.output.destId}` : `d:${track.output.deviceID ?? ""}`) : "default";

  return (
    <div className={`strip ${selectedTrackId === track.id ? "sel" : ""}`} onPointerDown={() => setSelectedTrack(track.id)}>
      <div className="strip-name" title={track.name}>{track.name || `Track ${track.index + 1}`}</div>
      {fxCount > 0 && <div className="strip-fx">{fxCount} fx</div>}
      <div className="strip-route">
        <select
          className="route-sel"
          title={track.input?.name ? `Input: ${track.input.name}` : "Input (choose a device pair)"}
          value={track.input?.deviceID ?? ""}
          onChange={(e) => { if (e.target.value) void exec("set_track_input", { trackId: track.id, deviceID: e.target.value }); }}
        >
          <option value="">{track.input && waveInputs.length === 0 ? `in: ${track.input.name ?? track.input.deviceID}` : "in: auto"}</option>
          {waveInputs.map((wi) => (
            <option key={wi.deviceID} value={wi.deviceID}>in: {wi.name}</option>
          ))}
        </select>
        <select
          className="route-sel"
          title={track.output ? `Output: ${track.output.name}` : "Output (default)"}
          value={outputValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "default") void exec("set_track_output", { trackId: track.id, output: "default" });
            else if (v.startsWith("t:")) void exec("set_track_output", { trackId: track.id, destTrackId: v.slice(2) });
            else if (v.startsWith("d:")) void exec("set_track_output", { trackId: track.id, deviceID: v.slice(2) });
          }}
        >
          <option value="default">out: default</option>
          {(trackOutputs?.outputs ?? []).map((o) => (
            <option key={o.deviceID} value={`d:${o.deviceID}`}>out: {o.name}</option>
          ))}
          {(trackOutputs?.tracks ?? []).filter((t2) => t2.id !== track.id).map((t2) => (
            <option key={t2.id} value={`t:${t2.id}`}>→ {t2.name}</option>
          ))}
          {track.output && !track.output.isTrack && !(trackOutputs?.outputs ?? []).some((o) => o.deviceID === track.output?.deviceID) && (
            <option value={outputValue}>out: {track.output.name} (missing)</option>
          )}
        </select>
      </div>
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

// MIX-008 — a group (submix) strip. The fader is the FolderTrack's real
// VolumeAndPan (the engine sums the children through it); set_track_volume /
// rename_track resolve group ids, so the existing commands drive it.
function GroupStrip({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const setSelectedTrack = useStore((s) => s.setSelectedTrack);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  return (
    <div className={`strip group ${selectedTrackId === track.id ? "sel" : ""}`} onPointerDown={() => setSelectedTrack(track.id)}>
      <div className="strip-name" title={track.name}><span className="gbadge">G</span> {track.name}</div>
      <div className="fader-wrap">
        <input className="fader" type="range" min={-48} max={6} step={0.5} value={track.volumeDb ?? 0}
          onChange={(e) => exec("set_track_volume", { trackId: track.id, db: Number(e.target.value) })} title="Group volume" />
      </div>
      <div className="strip-db">{(track.volumeDb ?? 0).toFixed(1)} dB</div>
      <button className="send-x bus-x" title="Ungroup (hoist members, remove the group)"
        onClick={() => exec("ungroup_track", { trackId: track.id })}>× Group</button>
    </div>
  );
}
