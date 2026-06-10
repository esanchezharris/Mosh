import { useState } from "react";
import { useStore } from "../store";
import { tempoMapFrom, secondsToBBSMap } from "../time";

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
  const select = useStore((s) => s.select);
  const t = snapshot?.transport;
  const session = snapshot?.session;

  const playing = t?.playing ?? false;
  const recording = t?.recording ?? false;
  const looping = t?.looping ?? false;

  // Wave B — record-to-take. While recording, the record button stops via the
  // record-lifecycle command (stop_recording KEEPS the take); on resolve it returns the
  // landed clip id(s), which we auto-select so the take is immediately editable. Starting
  // a recording stays a plain transport action (set_transport record).
  const onRecordToggle = async () => {
    if (recording) {
      const res = await exec("stop_recording");
      const clips = (res.data as { clips?: { id: string }[] } | undefined)?.clips ?? [];
      const ids = clips.map((c) => c.id).filter((id): id is string => !!id);
      if (ids.length > 0) select(ids);
    } else {
      void exec("set_transport", { action: "record" });
    }
  };
  // Audio-engine gate (MON-007 / FLY-004): no device → play/record disabled. Pure
  // view logic, no command.
  const audioEnabled = session?.audioEnabled ?? false;
  const metronome = session?.metronome ?? false;
  const tempo = session?.tempo ?? 120;
  const num = session?.timeSigNumerator ?? 4;
  const den = session?.timeSigDenominator ?? 4;
  // SES-001 — the tempo-map popover (list points, add at the playhead, remove).
  const [mapOpen, setMapOpen] = useState(false);
  const tempoMap = session?.tempoMap ?? [];
  const timeSigMap = session?.timeSigMap ?? [];

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
        className={`tbtn rec ${recording ? "on recording-pulse" : ""}`}
        onClick={onRecordToggle}
        disabled={!audioEnabled && !recording}
        title={audioEnabled ? (recording ? "Stop recording (lands the take)" : "Record") : "No audio device — record disabled"}
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
        {secondsToBBSMap(tempoMapFrom(session), t?.position ?? 0)}
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

      {/* SES-001 — the tempo map: tempo / meter changes over time (step changes;
          the engine's TempoSequence does the math + playback natively). */}
      <div className="remote-companion">
        <button className={`tbtn toggle ${mapOpen || tempoMap.length > 1 || timeSigMap.length > 1 ? "on" : ""}`}
          onClick={() => setMapOpen((v) => !v)} title="Tempo map (tempo/meter changes over time)">
          ↗♩
        </button>
        {mapOpen && (
          <div className="remote-pop tempomap-pop">
            <div className="remote-head"><strong>Tempo map</strong>
              <button className="mini" onClick={() => setMapOpen(false)}>x</button></div>
            {tempoMap.map((p, i) => (
              <div className="tm-row" key={`t-${i}`}>
                <span>{fmt(p.time)}</span><span>{Math.round(p.bpm)} BPM</span>
                {i > 0 ? (
                  <button className="mini" title="Remove this tempo change"
                    onClick={() => exec("remove_tempo_change", { index: i })}>x</button>
                ) : <span className="tm-base">base</span>}
              </div>
            ))}
            {timeSigMap.map((p, i) => (
              <div className="tm-row" key={`s-${i}`}>
                <span>{fmt(p.time)}</span><span>{p.numerator}/{p.denominator}</span>
                {i > 0 ? (
                  <button className="mini" title="Remove this meter change"
                    onClick={() => exec("remove_time_sig_change", { index: i })}>x</button>
                ) : <span className="tm-base">base</span>}
              </div>
            ))}
            <div className="tm-actions">
              <button className="mini-action" title="Insert a tempo change at the playhead (edit the BPM after)"
                onClick={() => exec("insert_tempo_change", { time: t?.position ?? 0, bpm: Math.round(tempo) })}>
                + tempo @ playhead
              </button>
              <button className="mini-action" title="Insert a meter change at the playhead"
                onClick={() => exec("insert_time_sig_change", { time: t?.position ?? 0, numerator: num, denominator: den })}>
                + meter @ playhead
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
