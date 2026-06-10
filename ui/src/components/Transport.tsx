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

// Click-to-edit numeric chip (Stage 15) — the tempo/time-sig pattern: a value
// that LOOKS like a label until you click it, then commits via a command.
function EditableValue({
  value,
  title,
  suffix,
  width = 56,
  onCommit,
}: {
  value: string;
  title: string;
  suffix?: string;
  width?: number;
  onCommit: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (!editing)
    return (
      <button className="chip-edit" title={`${title} — click to edit`} onClick={() => setEditing(true)}>
        {value}
        {suffix && <span className="chip-suffix">{suffix}</span>}
      </button>
    );
  return (
    <input
      className="chip-input"
      style={{ width }}
      autoFocus
      defaultValue={value}
      onFocus={(e) => e.target.select()}
      onBlur={(e) => {
        setEditing(false);
        onCommit(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}

export function Transport() {
  const snapshot = useStore((s) => s.snapshot);
  const exec = useStore((s) => s.exec);
  const secsPerBeat = useStore((s) => s.secsPerBeat);
  const beatsPerBar = useStore((s) => s.beatsPerBar);
  const t = snapshot?.transport;
  const session = snapshot?.session;

  const playing = t?.playing ?? false;
  const looping = t?.looping ?? false;
  const metronome = session?.metronome ?? false;

  // Musical position (Stage 14): bars.beats next to wall time.
  const pos = t?.position ?? 0;
  const barSec = secsPerBeat() * beatsPerBar();
  const bar = Math.floor(pos / barSec) + 1;
  const beat = Math.floor((pos % barSec) / secsPerBeat()) + 1;

  // Master engine-output meter, fed by the 30 Hz transport event.
  const master = t?.levels?.master;
  const db = master ? Math.max(master[0], master[1]) : -100;
  const meterPct = Math.max(0, Math.min(1, (db + 60) / 60)) * 100;

  const tempo = Math.round((session?.tempo ?? 120) * 10) / 10;
  const tsNum = session?.timeSigNumerator ?? 4;
  const tsDen = session?.timeSigDenominator ?? 4;

  return (
    <div className="transport">
      <button
        className={`tbtn ${playing ? "stop" : "play"}`}
        onClick={() => exec("set_transport", { action: "toggle" })}
        title={playing ? "Stop (Space)" : "Play (Space)"}
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
      <button
        className={`tbtn toggle ${metronome ? "on" : ""}`}
        onClick={() => exec("set_metronome", { on: !metronome, gain: 0.7 })}
        title="Metronome"
      >
        ◭
      </button>
      <button
        className={`tbtn rec ${t?.recording ? "rec-on" : ""}`}
        onClick={() => exec("set_transport", { action: t?.recording ? "stop" : "record" })}
        title={t?.recording ? "Stop recording" : "Record onto armed tracks (● in a track header)"}
      >
        ⏺
      </button>

      <EditableValue
        value={String(tempo)}
        suffix=" bpm"
        title="Tempo"
        onCommit={(text) => {
          const bpm = Number(text);
          if (Number.isFinite(bpm) && bpm >= 20 && bpm <= 400 && bpm !== tempo)
            void exec("set_tempo", { bpm });
        }}
      />
      <EditableValue
        value={`${tsNum}/${tsDen}`}
        title="Time signature"
        width={44}
        onCommit={(text) => {
          const m = text.match(/^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/);
          if (m) void exec("set_time_sig", { numerator: Number(m[1]), denominator: Number(m[2]) });
        }}
      />

      <span className="pos-bars" title="bar.beat">{bar}.{beat}</span>
      <span className="pos">{fmt(pos)}</span>

      <span className="mmeter" title={`master ${db <= -99 ? "−∞" : db.toFixed(1)} dB`}>
        <span
          className={db > -1 ? "hot" : db > -9 ? "warm" : ""}
          style={{ width: `${meterPct}%` }}
        />
      </span>
      <input
        className="master-fader"
        type="range"
        min={-48}
        max={6}
        step={0.5}
        value={session?.masterVolumeDb ?? 0}
        title={`Master ${(session?.masterVolumeDb ?? 0).toFixed(1)} dB`}
        onChange={(e) => exec("set_master_volume", { db: Number(e.target.value) })}
      />
    </div>
  );
}

// Audio INPUT picker (Stage 19): pick the recording source. Machine-local.
export function AudioIn() {
  const snapshot = useStore((s) => s.snapshot);
  const exec = useStore((s) => s.exec);
  const [devices, setDevices] = useState<string[] | null>(null);

  const session = snapshot?.session;
  if (!session || session.hasAudio === false) return null;
  const current = session.audioInputDevice ?? "";

  const load = async () => {
    const res = (await exec("list_audio_inputs", {})) as CommandResult<{ devices: string[] }>;
    if (res.ok && res.data) setDevices(res.data.devices);
  };

  return (
    <span className="audio-out" title={`Recording input: ${current || "none"}`}>
      <span className="ao-mic">🎙</span>
      <select
        className="ao-select"
        value={current}
        onPointerDown={() => devices == null && void load()}
        onChange={(e) => e.target.value && void exec("set_audio_input", { device: e.target.value })}
      >
        {current === "" && <option value="">none</option>}
        {(devices ?? (current ? [current] : [])).map((d) => (
          <option key={d} value={d}>{d}</option>
        ))}
      </select>
    </span>
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
