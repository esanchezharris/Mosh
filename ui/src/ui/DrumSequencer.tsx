// Drum step sequencer — a grid PROJECTION of a MIDI clip's notes (see drumGrid.ts).
// Lives inside the piano-roll modal (toggled from its header); edits go through the
// same add_note / remove_note / set_note commands. No own data model, no new seam.

import { useStore } from "../store";
import type { Clip } from "../types";
import { meterAt, tempoMapFrom } from "../time";
import { DRUM_LANES, STEPS, stepBeats, noteStart, buildGrid, cycleVelocity } from "./drumGrid";

export function DrumSequencer({ clip }: { clip: Clip }) {
  const snapshot = useStore((s) => s.snapshot);
  const exec = useStore((s) => s.exec);

  const m = meterAt(tempoMapFrom(snapshot?.session), clip.start);
  const sb = stepBeats(m.num);
  const grid = buildGrid(clip.notes ?? [], m.num);
  const playing = useStore((s) => s.transport.playing);

  // DRM-001 — these GM-pitch notes only make sound on a drum track (sampler + kit).
  // If the clip lives on a plain track, offer to convert it so the beat is audible.
  const track = snapshot?.tracks.find((t) => t.clips.some((c) => c.id === clip.id));
  const isDrumTrack = track?.type === "drum";

  const onCell = (lane: number, step: number, shift: boolean) => {
    const cell = grid[lane][step];
    if (!cell.on)
      void exec("add_note", { clipId: clip.id, pitch: DRUM_LANES[lane].pitch, start: noteStart(step, sb), length: sb, velocity: 100 });
    else if (shift)
      void exec("set_note", { clipId: clip.id, noteIndex: cell.noteIndex, velocity: cycleVelocity(cell.velocity) });
    else
      void exec("remove_note", { clipId: clip.id, noteIndex: cell.noteIndex });
  };

  // Remove every grid note. Descending noteIndex so earlier removals never
  // invalidate an index we still hold (the backend reindexes on each removal).
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
        <span className="dr-hint tc">
          {track && !isDrumTrack ? "no kit on this track — make it a drum track to hear it" : "click a step to toggle · shift-click a step to cycle velocity"}
        </span>
      </div>
      <div className="dr-grid" role="grid" aria-label="Drum step sequencer">
        {DRUM_LANES.map((lane, li) => (
          <div className="dr-row" role="row" key={lane.pitch}>
            <div className="dr-label tc">{lane.name}</div>
            <div className="dr-steps">
              {Array.from({ length: STEPS }, (_, si) => {
                const cell = grid[li][si];
                return (
                  <button
                    key={si}
                    type="button"
                    role="gridcell"
                    className={`dr-cell${cell.on ? " on" : ""}${si % 4 === 0 ? " beat" : ""}`}
                    data-testid="dr-cell"
                    data-lane={li}
                    data-step={si}
                    data-on={cell.on}
                    aria-label={`${lane.name} step ${si + 1}${cell.on ? ` on, velocity ${cell.velocity}` : " off"}`}
                    style={cell.on ? { opacity: 0.4 + 0.6 * (cell.velocity / 127) } : undefined}
                    onClick={(e) => onCell(li, si, e.shiftKey)}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
