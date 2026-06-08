/**
 * Mixer — a thin per-track strip: gain fader, pan, live meter, mute/solo.
 *
 * Meters reflect decimated meter_update events (held in view-local store.meters).
 * Gain/mute/solo emit commands; pan emits set_track_param (mock-permissive).
 * This is a deliberately simple strip per the spec ("a simple strip is fine").
 */

import { executeCommand, type TrackState } from "../bridge";
import { useStore } from "../store";

function Meter({ trackId }: { trackId: string }) {
  const level = useStore((s) => s.meters[trackId]);
  const rms = level?.rms ?? 0;
  const peak = level?.peak ?? 0;
  return (
    <div className="meter" title={`rms ${rms.toFixed(2)} · peak ${peak.toFixed(2)}`}>
      <div className="meter-fill" style={{ height: `${Math.min(100, rms * 100)}%` }} />
      <div className="meter-peak" style={{ bottom: `${Math.min(100, peak * 100)}%` }} />
    </div>
  );
}

function Strip({ track }: { track: TrackState }) {
  const selected = useStore((s) => s.selectedTrack === track.id);
  const selectTrack = useStore((s) => s.selectTrack);

  return (
    <div
      className={`strip ${selected ? "selected" : ""}`}
      onMouseDown={() => selectTrack(track.id)}
    >
      <div className="strip-name" title={track.name}>
        {track.name}
      </div>

      <div className="strip-body">
        <Meter trackId={track.id} />
        <input
          className="strip-fader"
          type="range"
          min={0}
          max={1.5}
          step={0.01}
          value={track.gain}
          onChange={(e) =>
            void executeCommand("set_track_gain", {
              track: track.id,
              gain: Number.parseFloat(e.target.value),
            })
          }
          onMouseDown={(e) => e.stopPropagation()}
        />
      </div>

      <input
        className="strip-pan"
        type="range"
        min={-1}
        max={1}
        step={0.01}
        defaultValue={0}
        title="Pan"
        onChange={(e) =>
          void executeCommand("set_track_param", {
            track: track.id,
            param: "pan",
            value: Number.parseFloat(e.target.value),
          })
        }
        onMouseDown={(e) => e.stopPropagation()}
      />

      <div className="strip-buttons">
        <button
          className={`mini ${track.mute ? "on mute" : ""}`}
          title="Mute"
          onClick={(e) => {
            e.stopPropagation();
            void executeCommand("set_track_mute", { track: track.id });
          }}
        >
          M
        </button>
        <button
          className={`mini ${track.solo ? "on solo" : ""}`}
          title="Solo"
          onClick={(e) => {
            e.stopPropagation();
            void executeCommand("set_track_solo", { track: track.id });
          }}
        >
          S
        </button>
      </div>
    </div>
  );
}

export default function Mixer() {
  const snapshot = useStore((s) => s.snapshot);
  return (
    <div className="mixer">
      <div className="mixer-head">Mixer</div>
      <div className="mixer-strips">
        {snapshot?.tracks.map((t) => (
          <Strip key={t.id} track={t} />
        ))}
        {snapshot && snapshot.tracks.length === 0 && (
          <div className="empty-hint">No tracks.</div>
        )}
      </div>
    </div>
  );
}
