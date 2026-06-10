import { useMemo, useState } from "react";
import { useStore } from "../store";
import type { Track, SamplerSound, CommandResult } from "../types";

// The native drum rack (Stage 14): an FL-style step sequencer over the track's
// sampler pads. Rows = loaded sounds, columns = 16th steps across the first
// MIDI clip. A click cycles off → hit (vel 96) → accent (vel 118) → off, and
// every change is a MoshOps command (add_notes / remove_notes) — the recorder
// captures each click as correction data. Optimistic cell state bridges the
// gap until the snapshot refresh lands.

const STEP_BEATS = 0.25; // 16ths
const HIT_VEL = 96;
const ACCENT_VEL = 118;
const MAX_STEPS = 64;

type CellState = 0 | 1 | 2; // off | hit | accent

export function DrumRackPanel({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const secsPerBeat = useStore((s) => s.secsPerBeat);
  const beatsPerBar = useStore((s) => s.beatsPerBar);

  const sampler = (track.plugins ?? []).find((p) => (p.sounds?.length ?? 0) > 0);
  const clip = track.clips.find((c) => c.type === "midi") ?? null;

  // Optimistic overrides: "pitch:step" → cell state, cleared when the
  // snapshot catches up (keyed by the clip's note array identity).
  const [pending, setPending] = useState<Record<string, CellState>>({});
  const notesKey = clip?.notes ? JSON.stringify(clip.notes.length) + clip.id : "";
  const [seenKey, setSeenKey] = useState(notesKey);
  if (notesKey !== seenKey) {
    setSeenKey(notesKey);
    setPending({});
  }

  const spb = secsPerBeat();
  const clipBeats = clip ? Math.max(1, Math.round(clip.length / spb)) : 0;
  const steps = Math.min(MAX_STEPS, Math.round(clipBeats / STEP_BEATS));
  const stepsPerBar = Math.round(beatsPerBar() / STEP_BEATS);

  const grid = useMemo(() => {
    const g = new Map<string, CellState>();
    if (!clip?.notes) return g;
    for (const n of clip.notes) {
      const step = Math.round(n.startBeats / STEP_BEATS);
      if (Math.abs(n.startBeats - step * STEP_BEATS) > 0.06) continue; // off-grid (humanized) — preview only
      g.set(`${n.pitch}:${step}`, n.vel >= (HIT_VEL + ACCENT_VEL) / 2 ? 2 : 1);
    }
    return g;
  }, [clip]);

  if (!sampler || !clip) {
    if (!sampler) return null;
    return (
      <div className="drumrack">
        <div className="dr-title">drum rack · {track.name}</div>
        <button
          className="rack-add"
          onClick={() => exec("add_midi_clip", { trackId: track.id, name: "pattern", start: 0, length: spb * beatsPerBar() * 2, notes: [] })}
        >
          + pattern clip
        </button>
      </div>
    );
  }

  const cellState = (pitch: number, step: number): CellState =>
    pending[`${pitch}:${step}`] ?? grid.get(`${pitch}:${step}`) ?? 0;

  const cycle = (pitch: number, step: number) => {
    const cur = cellState(pitch, step);
    const next = ((cur + 1) % 3) as CellState;
    setPending((p) => ({ ...p, [`${pitch}:${step}`]: next }));
    const startBeats = step * STEP_BEATS;
    const range = { rangeStartBeats: startBeats - 0.001, rangeLengthBeats: 0.002 };
    if (cur !== 0)
      void exec("remove_notes", { clipId: clip.id, pitches: [pitch], ...range });
    if (next !== 0)
      void exec("add_notes", {
        clipId: clip.id,
        notes: [{ pitch, startBeats, durBeats: STEP_BEATS, vel: next === 2 ? ACCENT_VEL : HIT_VEL }],
      });
  };

  const sounds: SamplerSound[] = sampler.sounds ?? [];

  // "+ pad" (Stage 15): native file dialog → add_sampler_sound on the next
  // free key above the highest pad (key-ranged so pads never overlap).
  const addPad = async () => {
    const res = (await exec("choose_file", { title: "Choose a one-shot for the new pad" })) as CommandResult<{ path?: string }>;
    const path = res.ok ? res.data?.path : undefined;
    if (!path) return;
    const key = sounds.length ? Math.max(...sounds.map((s) => s.keyNote)) + 2 : 24;
    void exec("add_sampler_sound", {
      trackId: track.id,
      index: sampler.index,
      file: path,
      keyNote: key,
      minNote: key,
      maxNote: key,
      openEnded: true,
    });
  };

  return (
    <div className="drumrack">
      <div className="dr-title">
        drum rack · <b>{track.name}</b>
        <button className="dr-add" onClick={() => void addPad()} title="Add a pad from a sample">+ pad</button>
        <span className="dr-hint">click: hit → accent → off</span>
      </div>
      <div className="dr-grid">
        {sounds.map((snd) => (
          <div className="dr-row" key={snd.keyNote}>
            <span className="dr-pad" title={`${snd.name} · key ${snd.keyNote}`}>
              {snd.name.length > 14 ? snd.name.slice(0, 13) + "…" : snd.name}
            </span>
            <span className="dr-steps">
              {Array.from({ length: steps }, (_, i) => {
                const st = cellState(snd.keyNote, i);
                const barStart = i % stepsPerBar === 0;
                const beatStart = i % 4 === 0;
                return (
                  <button
                    key={i}
                    className={`dr-cell s${st} ${barStart ? "bar" : beatStart ? "beat" : ""}`}
                    onClick={() => cycle(snd.keyNote, i)}
                  />
                );
              })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Visible only when the selected track actually has sampler pads.
export function trackHasRack(track: Track | null): track is Track {
  return !!track && (track.plugins ?? []).some((p) => (p.sounds?.length ?? 0) > 0);
}
