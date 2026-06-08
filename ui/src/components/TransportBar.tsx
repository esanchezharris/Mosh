/**
 * TransportBar — play/stop/record/loop, tempo edit, position readout.
 *
 * Every control emits a command (set_transport / set_tempo). Position is a pure
 * reflection of the mirrored transport (fed by decimated transport_position
 * events). Nothing here mutates state directly.
 */

import { useState } from "react";
import { executeCommand } from "../bridge";
import { useStore } from "../store";
import { formatBarBeat, formatClock } from "../timeutil";

export default function TransportBar() {
  const snapshot = useStore((s) => s.snapshot);
  const [tempoEditing, setTempoEditing] = useState(false);
  const [tempoDraft, setTempoDraft] = useState("");

  if (!snapshot) return <div className="transport" />;

  const { transport, tempo } = snapshot;
  const playing = transport.playing;
  const looping = transport.loop !== null;

  const togglePlay = () => {
    void executeCommand("set_transport", { playing: !playing });
  };
  const stop = () => {
    void executeCommand("set_transport", { playing: false, position: 0 });
  };
  const toggleRecord = () => {
    void executeCommand("set_transport", { record: true, playing: !playing });
  };
  const toggleLoop = () => {
    if (looping) {
      void executeCommand("set_transport", { looping: false });
    } else {
      // Default a sensible loop region if none exists yet.
      void executeCommand("set_transport", {
        looping: true,
        loopStart: 0,
        loopEnd: 8,
      });
    }
  };

  const commitTempo = () => {
    const bpm = Number.parseFloat(tempoDraft);
    if (Number.isFinite(bpm)) void executeCommand("set_tempo", { bpm });
    setTempoEditing(false);
  };

  return (
    <div className="transport">
      <div className="transport-buttons">
        <button
          className={`tbtn ${playing ? "active" : ""}`}
          onClick={togglePlay}
          title="Play / Pause"
          aria-label="play"
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <button className="tbtn" onClick={stop} title="Stop" aria-label="stop">
          ■
        </button>
        <button
          className="tbtn rec"
          onClick={toggleRecord}
          title="Record"
          aria-label="record"
        >
          ●
        </button>
        <button
          className={`tbtn ${looping ? "active" : ""}`}
          onClick={toggleLoop}
          title="Loop"
          aria-label="loop"
        >
          ⟳
        </button>
      </div>

      <div className="transport-readout">
        <div className="readout-block">
          <span className="readout-label">position</span>
          <span className="readout-value">
            {formatBarBeat(transport.position, tempo.bpm, tempo.sig)}
          </span>
        </div>
        <div className="readout-block">
          <span className="readout-label">time</span>
          <span className="readout-value">
            {formatClock(transport.position)}
          </span>
        </div>
        <div className="readout-block">
          <span className="readout-label">tempo</span>
          {tempoEditing ? (
            <input
              className="tempo-input"
              autoFocus
              value={tempoDraft}
              onChange={(e) => setTempoDraft(e.target.value)}
              onBlur={commitTempo}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitTempo();
                if (e.key === "Escape") setTempoEditing(false);
              }}
            />
          ) : (
            <span
              className="readout-value editable"
              title="Click to edit tempo"
              onClick={() => {
                setTempoDraft(String(tempo.bpm));
                setTempoEditing(true);
              }}
            >
              {tempo.bpm.toFixed(0)} bpm
            </span>
          )}
        </div>
        <div className="readout-block">
          <span className="readout-label">sig</span>
          <span className="readout-value">{tempo.sig}</span>
        </div>
        {looping && transport.loop && (
          <div className="readout-block">
            <span className="readout-label">loop</span>
            <span className="readout-value">
              {transport.loop[0].toFixed(1)}–{transport.loop[1].toFixed(1)}s
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
