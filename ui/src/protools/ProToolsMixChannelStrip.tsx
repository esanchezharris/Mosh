import { useStore } from "../store";
import type { Snapshot, Track } from "../types";
import { Meter } from "../ui/Meter";
import { ProToolsMixInserts } from "./ProToolsMixInserts";
import { ProToolsMixRouting } from "./ProToolsMixRouting";
import { ProToolsMixSends } from "./ProToolsMixSends";
import { useProTools } from "./proToolsState";
import {
  executeProToolsMixFanout,
  proToolsMixActionTrackIds,
  type ProToolsMixModifiers,
} from "./proToolsMixFanout";
import { applyProToolsTrackControl, type ProToolsTrackControl } from "./proToolsTrackControls";
import { selectProToolsTrack } from "./proToolsTrackEditSelection";

const VOLUME_DEFAULT_DB = 0;
const PAN_DEFAULT = 0;

export function ProToolsMixChannelStrip({ snapshot, track, shownTrackIds, selectedTrackIds, modifiers }: {
  readonly snapshot: Snapshot;
  readonly track: Track;
  readonly shownTrackIds: readonly string[];
  readonly selectedTrackIds: readonly string[];
  readonly modifiers: ProToolsMixModifiers;
}) {
  const selectedTrackId = useStore((state) => state.selectedTrackId);
  const setSelectedTrack = useStore((state) => state.setSelectedTrack);
  const clearSelection = useStore((state) => state.clearSelection);
  const closePianoRoll = useStore((state) => state.closePianoRoll);
  const selected = selectedTrackIds.length > 0
    ? selectedTrackIds.includes(track.id)
    : selectedTrackId === track.id;
  const canInputMonitor = !track.isReturn && !track.isGroup;
  const actionTrackIds = (supports?: (candidate: Track) => boolean) => proToolsMixActionTrackIds({
    snapshot,
    sourceTrackId: track.id,
    shownTrackIds,
    selectedTrackIds,
    modifiers,
    supports,
  });

  const selectTrack = () => {
    clearSelection();
    closePianoRoll();
    setSelectedTrack(track.id);
  };
  const selectTrackName = (event: React.MouseEvent<HTMLButtonElement>) => {
    clearSelection();
    closePianoRoll();
    if (track.isGroup || track.isReturn) {
      useProTools.getState().setTrackSelectionIds([track.id]);
      setSelectedTrack(track.id);
      return;
    }
    selectProToolsTrack(track.id, {
      additive: (event.metaKey || event.ctrlKey) && !event.shiftKey,
      range: event.shiftKey && !event.metaKey && !event.ctrlKey,
      visibleTrackIds: shownTrackIds.filter((trackId) => {
        const candidate = snapshot.tracks.find((item) => item.id === trackId);
        return candidate && !candidate.isGroup && !candidate.isReturn;
      }),
    });
  };
  const selectInteractiveStrip = (event: React.SyntheticEvent<HTMLElement>) => {
    if (event.target instanceof Element && event.target.closest(".pt-mix-track-name")) return;
    selectTrack();
  };
  const applyControl = (control: ProToolsTrackControl) => {
    selectTrack();
    const supports = control === "arm" || control === "input"
      ? (candidate: Track) => !candidate.isGroup && !candidate.isReturn
      : (candidate: Track) => !candidate.isGroup;
    void applyProToolsTrackControl(control, track.id, actionTrackIds(supports));
  };
  const applyMixValue = (
    command: "set_track_volume" | "set_track_pan" | "set_track_automation_mode",
    value: number | string,
  ) => {
    const isVolume = command === "set_track_volume";
    const targetTrackIds = actionTrackIds(isVolume ? undefined : (candidate) => !candidate.isGroup);
    void executeProToolsMixFanout({
      snapshot,
      targetTrackIds,
      mixAttribute: command === "set_track_volume" ? "main_volume"
        : command === "set_track_pan" ? "main_pan" : undefined,
      commandForTrack: (trackId) => ({
        command,
        args: command === "set_track_volume" ? { trackId, db: value }
          : command === "set_track_pan" ? { trackId, pan: value }
            : { trackId, mode: value },
      }),
    });
  };

  return (
    <section className="pt-mix-strip" data-testid="pt-mix-strip" data-track-id={track.id}
      data-selected={selected} aria-label={`${track.name} channel strip`}
      style={{ "--pt-track-color": track.color ?? "var(--pt-selected)" } as React.CSSProperties}
      onPointerDownCapture={selectInteractiveStrip} onFocusCapture={selectInteractiveStrip}>
      <div className="pt-mix-strip-color" aria-hidden="true" />
      <ProToolsMixInserts track={track} onSelectTrack={selectTrack}
        targetTrackIds={actionTrackIds((candidate) => !candidate.isGroup && !candidate.frozen)} />
      <ProToolsMixSends snapshot={snapshot} track={track}
        targetTrackIds={actionTrackIds((candidate) => !candidate.isGroup)} />
      <ProToolsMixRouting snapshot={snapshot} track={track}
        inputTargetTrackIds={actionTrackIds((candidate) => !candidate.isGroup && !candidate.isReturn)}
        outputTargetTrackIds={actionTrackIds((candidate) => !candidate.isGroup)} />
      <label className="pt-mix-automation">Automation
        <select data-testid="pt-mix-automation" value={track.automationMode ?? "read"}
          disabled={Boolean(track.isGroup)}
          title="Read and Write are active; Touch and Latch are stored but currently read-like"
          onChange={(event) => applyMixValue("set_track_automation_mode", event.currentTarget.value)}>
          <option value="read">Read</option>
          <option value="touch">Touch*</option>
          <option value="latch">Latch*</option>
          <option value="write">Write</option>
        </select>
      </label>
      <label className="pt-mix-pan">Pan
        <input type="range" min={-1} max={1} step={0.01} value={track.pan ?? PAN_DEFAULT}
          data-testid="pt-mix-pan" aria-label={`Pan for ${track.name}`}
          disabled={Boolean(track.isGroup)}
          onChange={(event) => applyMixValue("set_track_pan", Number(event.currentTarget.value))}
          onDoubleClick={() => applyMixValue("set_track_pan", PAN_DEFAULT)} />
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
          aria-pressed={Boolean(track.solo)} disabled={Boolean(track.isGroup)}
          onClick={() => applyControl("solo")}>S</button>
        <button type="button" data-testid="pt-mix-mute" aria-label={`Mute ${track.name}`}
          aria-pressed={Boolean(track.mute)} disabled={Boolean(track.isGroup)}
          onClick={() => applyControl("mute")}>M</button>
      </div>
      <div className="pt-mix-meter-fader">
        <div className="pt-mix-meter" role="img" aria-label={`${track.name} live stereo level`}>
          <Meter trackId={track.id} />
        </div>
        <label className="pt-mix-fader">Volume
          <input type="range" min={-70} max={6} step={0.5} value={track.volumeDb ?? VOLUME_DEFAULT_DB}
            data-testid="pt-mix-volume" aria-label={`Volume for ${track.name}`} aria-orientation="vertical"
            onChange={(event) => applyMixValue("set_track_volume", Number(event.currentTarget.value))}
            onDoubleClick={() => applyMixValue("set_track_volume", VOLUME_DEFAULT_DB)} />
        </label>
      </div>
      <output className="pt-mix-volume-readout">{(track.volumeDb ?? VOLUME_DEFAULT_DB).toFixed(1)} dB</output>
      <button type="button" className="pt-mix-track-name" aria-pressed={selected} onClick={selectTrackName}>
        <span>{track.name}</span><small>{track.isReturn ? "Aux" : track.isGroup ? "Routing group" : track.type}</small>
      </button>
    </section>
  );
}
