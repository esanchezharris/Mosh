// Drum step sequencer — a grid PROJECTION of a MIDI clip's notes (see drumGrid.ts).
// Edits flow through the same add_note / remove_note / set_note commands; no own data
// model, no new seam. Phase 6 (FL feel): configurable pattern LENGTH, SWING, a
// per-step VELOCITY graph, and a Roll/Graph toggle. Hosted both as the piano-roll
// Drums tab and as the floating DrumWindow (DockShell/FloatingWindow).

import { useState } from "react";
import { useStore } from "../store";
import type { Clip } from "../types";
import { meterAt, tempoMapFrom } from "../time";
import {
  DRUM_LANES, STEPS, STEP_OPTIONS, stepBeats, stepStartBeats,
  buildGrid, cycleVelocity, velocityFromFraction,
} from "./drumGrid";

export function DrumSequencer({ clip }: { clip: Clip }) {
  const snapshot = useStore((s) => s.snapshot);
  const exec = useStore((s) => s.exec);
  const playing = useStore((s) => s.transport.playing);

  const [steps, setSteps] = useState<number>(STEPS);
  const [swing, setSwing] = useState(0);
  const [view, setView] = useState<"roll" | "graph">("roll");
  const [lane, setLane] = useState(0); // which lane the velocity graph edits

  const m = meterAt(tempoMapFrom(snapshot?.session), clip.start);
  const sb = stepBeats(m.num, steps);
  const grid = buildGrid(clip.notes ?? [], m.num, steps, swing);

  // DRM-001 — these GM-pitch notes only make sound on a drum track (sampler + kit).
  const track = snapshot?.tracks.find((t) => t.clips.some((c) => c.id === clip.id));
  const isDrumTrack = track?.type === "drum";

  const addStep = (li: number, si: number, velocity = 100) =>
    void exec("add_note", { clipId: clip.id, pitch: DRUM_LANES[li].pitch, start: stepStartBeats(si, sb, swing), length: sb, velocity });

  const onCell = (li: number, si: number, shift: boolean) => {
    const cell = grid[li][si];
    if (!cell.on) addStep(li, si);
    else if (shift) void exec("set_note", { clipId: clip.id, noteIndex: cell.noteIndex, velocity: cycleVelocity(cell.velocity) });
    else void exec("remove_note", { clipId: clip.id, noteIndex: cell.noteIndex });
  };

  // Velocity graph: a vertical bar per step for the selected lane. Pointer Y → velocity.
  const setVelAt = (si: number, clientY: number, rect: DOMRect, allowAdd: boolean) => {
    const vel = velocityFromFraction(1 - (clientY - rect.top) / rect.height);
    const cell = grid[lane][si];
    if (cell.on) void exec("set_note", { clipId: clip.id, noteIndex: cell.noteIndex, velocity: vel });
    else if (allowAdd) addStep(lane, si, vel);
  };

  // Remove every grid note. Descending noteIndex so earlier removals never invalidate
  // an index we still hold (the backend reindexes on each removal).
  const clearAll = async () => {
    const idxs = grid.flatMap((row) => row.filter((c) => c.on).map((c) => c.noteIndex)).sort((a, b) => b - a);
    for (const i of idxs) await exec("remove_note", { clipId: clip.id, noteIndex: i });
  };

  const play = () => {
    if (!playing) void exec("set_transport", { action: "stop", position: clip.start });
    void exec("set_transport", { action: "toggle" });
  };

  return (
    <div className="dr" data-testid="drum-sequencer">
      <div className="dr-toolbar">
        <button className="btn" onClick={play} aria-pressed={playing} aria-label={playing ? "Stop preview" : "Play preview"}>
          {playing ? "⏸ Stop" : "▶ Play"}
        </button>
        <button className="btn" onClick={() => void clearAll()}>Clear</button>
        {track && !isDrumTrack && (
          <button className="btn" data-testid="make-drum-track" title="Load a sampler + drum kit so these notes make sound"
            onClick={() => void exec("set_track_type", { trackId: track.id, type: "drum" })}>
            🥁 Make drum track
          </button>
        )}
        <span className="spacer" />
        <label className="dr-ctl tc">Steps
          <select aria-label="Pattern length (steps)" value={steps} onChange={(e) => setSteps(Number(e.target.value))}>
            {STEP_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="dr-ctl tc">Swing
          <input aria-label="Swing" type="range" min={0} max={1} step={0.05} value={swing}
            onChange={(e) => setSwing(Number(e.target.value))} style={{ accentColor: "var(--lime)" }} />
          <span>{Math.round(swing * 100)}%</span>
        </label>
        <div className="seg" role="group" aria-label="Sequencer view">
          <button className="btn" aria-pressed={view === "roll"} onClick={() => setView("roll")}>Roll</button>
          <button className="btn" aria-pressed={view === "graph"} onClick={() => setView("graph")}>Graph</button>
        </div>
      </div>

      {view === "roll" ? (
        <div className="dr-grid" role="grid" aria-label="Drum step sequencer">
          {DRUM_LANES.map((laneObj, li) => (
            <div className="dr-row" role="row" key={laneObj.pitch}>
              <div className="dr-label tc">{laneObj.name}</div>
              <div className="dr-steps">
                {Array.from({ length: steps }, (_, si) => {
                  const cell = grid[li][si];
                  return (
                    <button key={si} type="button" role="gridcell"
                      className={`dr-cell${cell.on ? " on" : ""}${si % 4 === 0 ? " beat" : ""}`}
                      data-testid="dr-cell" data-lane={li} data-step={si} data-on={cell.on}
                      aria-label={`${laneObj.name} step ${si + 1}${cell.on ? ` on, velocity ${cell.velocity}` : " off"}`}
                      style={cell.on ? { opacity: 0.4 + 0.6 * (cell.velocity / 127) } : undefined}
                      onClick={(e) => onCell(li, si, e.shiftKey)} />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="dr-graph" data-testid="drum-graph">
          <div className="dr-graph-lanes" role="group" aria-label="Lane for velocity graph">
            {DRUM_LANES.map((l, li) => (
              <button key={l.pitch} className={`btn${lane === li ? " on" : ""}`} onClick={() => setLane(li)}>{l.name}</button>
            ))}
          </div>
          <div className="dr-bars">
            {Array.from({ length: steps }, (_, si) => {
              const cell = grid[lane][si];
              return (
                <div key={si} className={`dr-bar-slot${si % 4 === 0 ? " beat" : ""}${cell.on ? " on" : ""}`}
                  data-testid="dr-bar" data-step={si} data-on={cell.on}
                  title={cell.on ? `velocity ${cell.velocity}` : "click to add"}
                  onPointerDown={(e) => setVelAt(si, e.clientY, e.currentTarget.getBoundingClientRect(), true)}
                  onPointerMove={(e) => { if (e.buttons) setVelAt(si, e.clientY, e.currentTarget.getBoundingClientRect(), false); }}>
                  {cell.on && <div className="dr-bar-fill" style={{ height: `${(cell.velocity / 127) * 100}%` }} />}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
