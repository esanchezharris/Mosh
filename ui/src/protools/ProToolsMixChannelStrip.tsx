import { useStore } from "../store";
import type { Snapshot, Track } from "../types";
import { Meter } from "../ui/Meter";
import { ProToolsMixInserts } from "./ProToolsMixInserts";
import { ProToolsMixRouting } from "./ProToolsMixRouting";
import { ProToolsMixSends } from "./ProToolsMixSends";
import { applyProToolsTrackControl, type ProToolsTrackControl } from "./proToolsTrackControls";

const VOLUME_DEFAULT_DB = 0;
const PAN_DEFAULT = 0;

export function ProToolsMixChannelStrip({ snapshot, track }: {
  readonly snapshot: Snapshot;
  readonly track: Track;
}) {
  const exec = useStore((state) => state.exec);
  const selectedTrackId = useStore((state) => state.selectedTrackId);
  const setSelectedTrack = useStore((state) => state.setSelectedTrack);
  const clearSelection = useStore((state) => state.clearSelection);
  const closePianoRoll = useStore((state) => state.closePianoRoll);
  const selected = selectedTrackId === track.id;
  const canInputMonitor = !track.isReturn && !track.isGroup;

  const selectTrack = () => {
    clearSelection();
    closePianoRoll();
    setSelectedTrack(track.id);
  };
  const applyControl = (control: ProToolsTrackControl) => {
    selectTrack();
    void applyProToolsTrackControl(control, track.id, [track.id]);
  };

  return (
    <section className="pt-mix-strip" data-testid="pt-mix-strip" data-track-id={track.id}
      data-selected={selected} aria-label={`${track.name} channel strip`}
      style={{ "--pt-track-color": track.color ?? "var(--pt-selected)" } as React.CSSProperties}
      onPointerDownCapture={selectTrack} onFocusCapture={selectTrack}>
      <div className="pt-mix-strip-color" aria-hidden="true" />
      <ProToolsMixInserts track={track} onSelectTrack={selectTrack} />
      <ProToolsMixSends snapshot={snapshot} track={track} />
      <ProToolsMixRouting track={track} />
      <label className="pt-mix-automation">Automation
        <select data-testid="pt-mix-automation" value={track.automationMode ?? "read"}
          title="Read and Write are active; Touch and Latch are stored but currently read-like"
          onChange={(event) => void exec("set_track_automation_mode", {
            trackId: track.id,
            mode: event.currentTarget.value,
          })}>
          <option value="read">Read</option>
          <option value="touch">Touch*</option>
          <option value="latch">Latch*</option>
          <option value="write">Write</option>
        </select>
      </label>
      <label className="pt-mix-pan">Pan
        <input type="range" min={-1} max={1} step={0.01} value={track.pan ?? PAN_DEFAULT}
          data-testid="pt-mix-pan" aria-label={`Pan for ${track.name}`}
          onChange={(event) => void exec("set_track_pan", {
            trackId: track.id,
            pan: Number(event.currentTarget.value),
          })}
          onDoubleClick={() => void exec("set_track_pan", { trackId: track.id, pan: PAN_DEFAULT })} />
        <output>{(track.pan ?? PAN_DEFAULT).toFixed(2)}</output>
      </label>
      <div className="pt-mix-track-controls" role="group" aria-label={`${track.name} channel controls`}>
        <button type="button" data-testid="pt-mix-input-monitor" aria-label={`Input-monitor ${track.name}`}
          aria-pressed={track.monitor === "on"} disabled={!canInputMonitor}
          onClick={() => applyControl("input")}>I</button>
        <button type="button" data-testid="pt-mix-arm" aria-label={`Record-arm ${track.name}`}
          aria-pressed={Boolean(track.armed)} disabled={!canInputMonitor}
          onClick={() => applyControl("arm")}>R</button>
        <button type="button" data-testid="pt-mix-solo" aria-label={`Solo ${track.name}`}
          aria-pressed={Boolean(track.solo)} onClick={() => applyControl("solo")}>S</button>
        <button type="button" data-testid="pt-mix-mute" aria-label={`Mute ${track.name}`}
          aria-pressed={Boolean(track.mute)} onClick={() => applyControl("mute")}>M</button>
      </div>
      <div className="pt-mix-meter-fader">
        <div className="pt-mix-meter" role="img" aria-label={`${track.name} live stereo level`}>
          <Meter trackId={track.id} />
        </div>
        <label className="pt-mix-fader">Volume
          <input type="range" min={-70} max={6} step={0.5} value={track.volumeDb ?? VOLUME_DEFAULT_DB}
            data-testid="pt-mix-volume" aria-label={`Volume for ${track.name}`} aria-orientation="vertical"
            onChange={(event) => void exec("set_track_volume", {
              trackId: track.id,
              db: Number(event.currentTarget.value),
            })}
            onDoubleClick={() => void exec("set_track_volume", { trackId: track.id, db: VOLUME_DEFAULT_DB })} />
        </label>
      </div>
      <output className="pt-mix-volume-readout">{(track.volumeDb ?? VOLUME_DEFAULT_DB).toFixed(1)} dB</output>
      <button type="button" className="pt-mix-track-name" aria-pressed={selected} onClick={selectTrack}>
        <span>{track.name}</span><small>{track.isReturn ? "Aux" : track.isGroup ? "Routing group" : track.type}</small>
      </button>
    </section>
  );
}
