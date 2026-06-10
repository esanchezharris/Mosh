import { useState } from "react";
import { useStore } from "../store";
import type { AudioOutputDevice, CommandResult } from "../types";

function fmt(t: number): string {
  const s = Math.max(0, t);
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.floor((s * 100) % 100);
  return `${mm}:${ss.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
}

export function Transport() {
  const snapshot = useStore((s) => s.snapshot);
  const exec = useStore((s) => s.exec);
  const secsPerBeat = useStore((s) => s.secsPerBeat);
  const beatsPerBar = useStore((s) => s.beatsPerBar);
  const t = snapshot?.transport;

  const playing = t?.playing ?? false;
  const looping = t?.looping ?? false;

  // Musical position (Stage 14): bars.beats next to wall time.
  const pos = t?.position ?? 0;
  const barSec = secsPerBeat() * beatsPerBar();
  const bar = Math.floor(pos / barSec) + 1;
  const beat = Math.floor((pos % barSec) / secsPerBeat()) + 1;

  // Master engine-output meter, fed by the 30 Hz transport event.
  const master = t?.levels?.master;
  const db = master ? Math.max(master[0], master[1]) : -100;
  const meterPct = Math.max(0, Math.min(1, (db + 60) / 60)) * 100;

  return (
    <div className="transport">
      <button
        className={`tbtn ${playing ? "stop" : "play"}`}
        onClick={() => exec("set_transport", { action: "toggle" })}
        title={playing ? "Stop" : "Play"}
      >
        {playing ? "■" : "▶"}
      </button>
      <button
        className="tbtn"
        onClick={() => exec("set_transport", { action: "stop", position: 0 })}
        title="Return to start"
      >
        ⏮
      </button>
      <button
        className={`tbtn toggle ${looping ? "on" : ""}`}
        onClick={() => exec("set_transport", { loop: !looping })}
        title="Loop"
      >
        ⟳
      </button>
      <span className="pos-bars" title="bar.beat">{bar}.{beat}</span>
      <span className="pos">{fmt(pos)}</span>
      <span className="mmeter" title={`master ${db <= -99 ? "−∞" : db.toFixed(1)} dB`}>
        <span
          className={db > -1 ? "hot" : db > -9 ? "warm" : ""}
          style={{ width: `${meterPct}%` }}
        />
      </span>
      <span className="bpm" title="Session tempo">{Math.round(snapshot?.session.tempo ?? 120)} bpm</span>
    </div>
  );
}

// Audio-output device truth (Stage 14): rung 1's silence was a BlackHole
// default output nobody could see. Shows the device; click to switch — the
// choice persists machine-locally (never session state, never synced).
export function AudioOut() {
  const snapshot = useStore((s) => s.snapshot);
  const exec = useStore((s) => s.exec);
  const [devices, setDevices] = useState<AudioOutputDevice[] | null>(null);

  const session = snapshot?.session;
  if (!session || session.hasAudio === false) return null;
  const current = session.audioOutputDevice ?? "";
  const warning = session.audioWarning;

  const load = async () => {
    const res = (await exec("list_audio_outputs", {})) as CommandResult<{
      devices: AudioOutputDevice[];
    }>;
    if (res.ok && res.data) setDevices(res.data.devices);
  };

  return (
    <span className={`audio-out ${warning ? "warned" : ""}`} title={warning ?? `Audio output: ${current}`}>
      {warning && <span className="ao-warn">⚠</span>}
      <select
        className="ao-select"
        value={current}
        onPointerDown={() => devices == null && void load()}
        onChange={(e) => void exec("set_audio_output", { device: e.target.value })}
      >
        {(devices ?? [{ name: current, virtualSink: false }]).map((d) => (
          <option key={d.name} value={d.name}>
            {d.virtualSink ? `${d.name} (virtual)` : d.name}
          </option>
        ))}
      </select>
    </span>
  );
}
