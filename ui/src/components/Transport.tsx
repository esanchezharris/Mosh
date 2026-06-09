import { useStore } from "../store";
import { meterFrom, secondsToBBS } from "../time";

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
  const t = snapshot?.transport;
  const session = snapshot?.session;

  const playing = t?.playing ?? false;
  const recording = t?.recording ?? false;
  const looping = t?.looping ?? false;
  // Audio-engine gate (MON-007 / FLY-004): no device → play/record disabled. Pure
  // view logic, no command.
  const audioEnabled = session?.audioEnabled ?? false;
  const metronome = session?.metronome ?? false;
  const tempo = session?.tempo ?? 120;
  const num = session?.timeSigNumerator ?? 4;
  const den = session?.timeSigDenominator ?? 4;

  return (
    <div className="transport">
      <button
        className={`tbtn ${playing ? "stop" : "play"}`}
        onClick={() => exec("set_transport", { action: "toggle" })}
        disabled={!audioEnabled && !playing}
        title={audioEnabled ? (playing ? "Stop" : "Play") : "No audio device — playback disabled"}
      >
        {playing ? "■" : "▶"}
      </button>
      <button
        className={`tbtn rec ${recording ? "on" : ""}`}
        onClick={() => exec("set_transport", { action: recording ? "stop" : "record" })}
        disabled={!audioEnabled && !recording}
        title={audioEnabled ? (recording ? "Stop recording" : "Record") : "No audio device — record disabled"}
      >
        ●
      </button>
      <button
        className="tbtn"
        onClick={() => exec("set_transport", { action: "stop", position: 0 })}
        title="Return to start"
      >
        ⏮
      </button>
      <button
        className="tbtn"
        onClick={() => exec("set_transport", { action: "to_end" })}
        title="Go to end"
      >
        ⏭
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
        onClick={() => exec("set_metronome", { enabled: !metronome })}
        title="Metronome / click"
      >
        ♩
      </button>

      <span className="pos" title="Position (min:sec)">{fmt(t?.position ?? 0)}</span>
      <span className="pos bbs" title="Position (bars.beats.sixteenths)">
        {secondsToBBS(t?.position ?? 0, meterFrom(session))}
      </span>

      {/* Plugin delay compensation readout (MON-004). The whole-edit reported latency
          Tracktion compensates across the neural insert + all hosted plugins. Non-
          interactive — pure backend state, never a command. "PDC —" when the playback
          graph isn't prepared (no audio device / idle), honest vs a false 0.0 ms. */}
      {session?.latencyContextReady ? (
        <span className="pos pdc" title="Plugin delay compensation — total reported latency of the active signal chain">
          PDC {(session.totalLatencyMs ?? 0).toFixed(1)} ms
        </span>
      ) : (
        <span className="pos pdc dim" title="Audio engine idle — latency reported once the playback graph is prepared">
          PDC —
        </span>
      )}

      <label className="tempo" title="Tempo (BPM)">
        <input
          type="number"
          min={20}
          max={999}
          step={1}
          value={Math.round(tempo)}
          onChange={(e) => exec("set_tempo", { bpm: Number(e.target.value) })}
        />
        <span className="unit">BPM</span>
      </label>

      <label className="timesig" title="Time signature">
        <input
          type="number"
          min={1}
          max={32}
          step={1}
          value={num}
          onChange={(e) => exec("set_time_signature", { numerator: Number(e.target.value), denominator: den })}
        />
        <span className="slash">/</span>
        <select
          value={den}
          onChange={(e) => exec("set_time_signature", { numerator: num, denominator: Number(e.target.value) })}
        >
          {[1, 2, 4, 8, 16, 32].map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
