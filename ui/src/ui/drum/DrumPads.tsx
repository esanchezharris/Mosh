// The Drum Rack pad grid — a 4x4 bank over the full 128-note range, the way Ableton's
// Drum Rack presents a kit.
//
// It is a VIEW of the track's sampler (snapshot.drumPads), not a second model: every pad
// edit is an ordinary command, and the grid re-derives itself from the next snapshot. The
// step sequencer beside it stays exactly as it was — it is a good pattern-writing surface
// that Ableton does not have, and this is for kit-building and playing instead.
//
// Pads are addressed by the NOTE that triggers them, never by the sampler's sound index:
// the index shifts whenever a kit is reloaded or a pad is cleared, the note does not.

import { useState } from "react";
import { useStore } from "../../store";
import { pickFiles } from "../../bridge";
import { notePreview } from "../../audio/notePreview";
import { noteName } from "../../musicalKey";
import type { DrumPad, Track } from "../../types";

/** Ableton shows 16 pads at a time; the bank selector walks the 128-note range. */
const BANK = 16;
const BANKS = 128 / BANK;
/** The bank holding the General MIDI kit (36..51), which is where a Mosh kit lands. */
const GM_BANK = Math.floor(36 / BANK);

export function DrumPads({ track, clipId }: { track: Track; clipId?: string }) {
  const exec = useStore((s) => s.exec);
  const [bank, setBank] = useState(GM_BANK);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const pads = track.drumPads ?? [];
  const byNote = new Map<number, DrumPad>();
  for (const p of pads) {
    // A melodic-mode sound spans the whole keyboard; it is a pitched instrument rather
    // than a pad, so it is shown only on its root note instead of filling all 128 cells.
    if (p.maxNote - p.minNote > 12) byNote.set(p.pitch, p);
    else for (let n = p.minNote; n <= p.maxNote; n++) byNote.set(n, p);
  }
  const muted = new Set(track.drumMutedPitches ?? []);
  const solo = new Set(track.drumSoloPitches ?? []);

  const base = bank * BANK;
  const notes = Array.from({ length: BANK }, (_, i) => base + i);
  // Bottom-left is the lowest note, as on hardware: rows are laid out bottom-up.
  const rows = [3, 2, 1, 0].map((r) => notes.slice(r * 4, r * 4 + 4));

  const assign = async (note: number, file?: string) => {
    const path = file ?? (await pickFiles({ filters: "*.wav;*.aif;*.aiff;*.flac;*.mp3", title: "Choose a sample for this pad" })).files?.[0];
    if (!path) return;
    await exec("assign_sample", { trackId: track.id, note, file: path });
  };

  return (
    <div className="dp" data-testid="drum-pads">
      <div className="dp-head">
        <span className="dp-title display">Drum Rack</span>
        <span className="seg" role="group" aria-label="Pad bank">
          <button className="btn" data-testid="dp-bank-down" aria-label="Lower pads"
            disabled={bank === 0} onClick={() => setBank((b) => Math.max(0, b - 1))}>▾</button>
          <span className="dp-bank tc" data-testid="dp-bank">{noteName(base)}–{noteName(base + BANK - 1)}</span>
          <button className="btn" data-testid="dp-bank-up" aria-label="Higher pads"
            disabled={bank >= BANKS - 1} onClick={() => setBank((b) => Math.min(BANKS - 1, b + 1))}>▴</button>
        </span>
        <span className="spacer" />
        <button className="btn" data-testid="dp-reset-kit"
          title="Reload the bundled kit onto every pad, discarding per-pad sample swaps"
          onClick={() => exec("load_drum_kit", { trackId: track.id })}>Reset kit</button>
      </div>

      <div className="dp-grid" role="group" aria-label="Drum pads">
        {rows.map((row, ri) => (
          <div className="dp-row" key={ri}>
            {row.map((note) => {
              const pad = byNote.get(note);
              const isMuted = muted.has(note);
              const isSolo = solo.has(note);
              return (
                <div key={note}
                  className={`dp-pad${pad ? " filled" : ""}${isMuted ? " muted" : ""}${isSolo ? " solo" : ""}${dragOver === note ? " over" : ""}`}
                  data-testid="dp-pad" data-note={note}
                  role="button" tabIndex={0}
                  aria-label={`${noteName(note)}${pad ? ` — ${pad.name}` : " — empty"}`}
                  title={pad ? `${pad.name} · ${pad.gainDb.toFixed(1)} dB${pad.chokeGroup ? ` · choke ${pad.chokeGroup}` : ""}` : "Empty — click to load a sample, or drop one here"}
                  // Dropping a file straight from Finder is how a kit actually gets built.
                  onDragOver={(e) => { e.preventDefault(); setDragOver(note); }}
                  onDragLeave={() => setDragOver((n) => (n === note ? null : n))}
                  onDrop={(e) => {
                    e.preventDefault(); setDragOver(null);
                    const f = e.dataTransfer?.files?.[0] as (File & { path?: string }) | undefined;
                    if (f?.path) void assign(note, f.path);
                  }}
                  onPointerDown={() => {
                    // Clicking a pad PLAYS it — the same audition path the piano roll and
                    // the computer keyboard use, so a bare drum track sounds through the
                    // sampler even with no clip on it.
                    if (pad) notePreview.tap(track.id, note);
                    else void assign(note);
                  }}>
                  <span className="dp-note tc">{noteName(note)}</span>
                  <span className="dp-name">{pad?.name ?? "—"}</span>
                  {pad && (
                    <span className="dp-ctl">
                      <button className={`dp-m${isMuted ? " on" : ""}`} data-testid="dp-mute"
                        title="Mute this pad" aria-pressed={isMuted}
                        onPointerDown={(e) => { e.stopPropagation(); void exec("set_drum_lane", { trackId: track.id, note, mute: !isMuted }); }}>M</button>
                      <button className={`dp-s${isSolo ? " on" : ""}`} data-testid="dp-solo"
                        title="Solo this pad" aria-pressed={isSolo}
                        onPointerDown={(e) => { e.stopPropagation(); void exec("set_drum_lane", { trackId: track.id, note, solo: !isSolo }); }}>S</button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <PadInspector track={track} pads={pads} clipId={clipId} />
      <div className="dp-foot">click a pad to hear it · drop a sample on a pad to load it · empty pad opens a file picker</div>
    </div>
  );
}

/** Per-pad mixer + choke, for whichever pad is selected. */
function PadInspector({ track, pads, clipId }: { track: Track; pads: readonly DrumPad[]; clipId?: string }) {
  const exec = useStore((s) => s.exec);
  const [note, setNote] = useState<number | null>(null);
  const pad = pads.find((p) => p.pitch === note) ?? pads[0] ?? null;
  if (!pad) return null;

  const set = (args: Record<string, unknown>) => exec("set_drum_pad", { trackId: track.id, note: pad.pitch, ...args });

  return (
    <div className="dp-insp" data-testid="dp-inspector">
      <label className="dp-field">pad
        <select data-testid="dp-pick" value={pad.pitch} onChange={(e) => setNote(Number(e.target.value))}>
          {pads.map((p) => <option key={p.pitch} value={p.pitch}>{noteName(p.pitch)} · {p.name}</option>)}
        </select>
      </label>
      <label className="dp-field">level
        <input type="range" data-testid="dp-gain" min={-48} max={12} step={0.5} value={pad.gainDb}
          onChange={(e) => void set({ gainDb: Number(e.target.value) })} />
        <span className="tc">{pad.gainDb.toFixed(1)} dB</span>
      </label>
      <label className="dp-field">pan
        <input type="range" data-testid="dp-pan" min={-1} max={1} step={0.05} value={pad.pan}
          onChange={(e) => void set({ pan: Number(e.target.value) })} />
      </label>
      <label className="dp-field" title="Pads sharing a choke group cut each other off — a closed hat silencing an open one. Applies to live playing; use Apply choke to bake it into the clip so playback and export obey it too.">choke
        <select data-testid="dp-choke" value={pad.chokeGroup ?? 0}
          onChange={(e) => void set({ chokeGroup: Number(e.target.value) })}>
          <option value={0}>none</option>
          {Array.from({ length: 8 }, (_, i) => i + 1).map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
      </label>
      <button className="btn" data-testid="dp-clear" title="Empty this pad"
        onClick={() => void exec("clear_drum_pad", { trackId: track.id, note: pad.pitch })}>Clear</button>
      {clipId && pads.some((p) => p.chokeGroup) && (
        <button className="btn" data-testid="dp-apply-choke"
          title="Bake the choke groups into this clip's note lengths, so playback and export obey them too — choke otherwise applies only to pads you play live. Shortens notes; undoable."
          onClick={() => void exec("apply_choke", { clipId })}>Apply choke</button>
      )}
    </div>
  );
}
