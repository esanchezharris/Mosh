import { useStore } from "../store";
import { barPosAt, barPosToSec, barSeconds, meterAt, tempoMapFrom } from "../time";
import { useV3 } from "./shellState";
import { usePresetMemory } from "./presetMemory";
import { agentTaskLive } from "./agentTask";

// V3 parity brief rows 2–3: "drop in a beat" is ONE command. add_drum_pattern with no target
// creates a drum track, loads the bundled kit and tiles the one-bar pattern across a
// BEAT_BARS-bar clip inside a single transaction (MoshOps cmdAddDrumPattern, DrumPattern.h;
// bridge.mock mirrors it), so the drop is one undo step. The pattern is the same string grammar
// the agent uses ("lane: steps; …").
export const DEFAULT_DRUM_BEAT = "kick: x...x...x...x...; snare: ....x.......x...; hat: x.x.x.x.x.x.x.x.";

/** Bars a dropped part spans — an integer (the native parser truncates, and caps at 16). */
export const BEAT_BARS = 4;
/** The most bars add_drum_pattern tiles (DrumPattern.h, drumPatternUtil: bars 1-16). */
const MAX_DROP_BARS = 16;

export type DroppedBeat = { trackId: string; clipId: string; noteCount: number };

type Store = ReturnType<typeof useStore.getState>;

/** The loop region while Loop is ON and the region is not collapsed, else null. */
function armedLoop(s: Pick<Store, "transport">): { start: number; end: number } | null {
  const t = s.transport;
  if (!t.looping) return null;
  const start = t.loopStart ?? 0, end = t.loopEnd ?? 0;
  return end - start > 1e-6 ? { start: Math.max(0, start), end } : null;
}

/** Where a dropped part starts. With Loop ON: the loop start — a playhead that has been cycling
 *  the loop sits on an arbitrary bar, and a part dropped there lands partly or wholly outside
 *  the loop (fixCheck A1). Otherwise bar 1 in an empty session (nothing to line up with, and the
 *  frozen source stays exactly BEAT_BARS long), else the bar at or before the playhead. */
export function dropStart(s: Pick<Store, "snapshot" | "transport">): number {
  const loop = armedLoop(s);
  if (loop) return loop.start;
  const tracks = s.snapshot?.tracks ?? [];
  if (!tracks.some((t) => t.clips.length > 0)) return 0;
  const map = tempoMapFrom(s.snapshot?.session);
  return Math.max(0, barPosToSec(map, Math.floor(barPosAt(map, s.transport.position ?? 0) + 1e-6)));
}

/** Bars a dropped beat spans: with Loop ON the loop's length in bars (rounded, 1-16) so the
 *  tiled beat fills the loop; otherwise BEAT_BARS. */
export function dropBars(s: Pick<Store, "snapshot" | "transport">): number {
  const loop = armedLoop(s);
  if (!loop) return BEAT_BARS;
  const map = tempoMapFrom(s.snapshot?.session);
  const bars = Math.round(barPosAt(map, loop.end) - barPosAt(map, loop.start));
  return Math.min(MAX_DROP_BARS, Math.max(1, bars));
}

/** With no loop region yet (loopEnd <= loopStart — how a fresh session boots), make the region
 *  the dropped clip so the TopBar Loop arms exactly it. Only the region: {loopStart, loopEnd}
 *  and no `loop` flag — the engine (and the mock) set the range whenever both bounds are
 *  present, and a flag read from the store could be stale and turn Loop back off right after
 *  the owner turned it on. An existing region is left alone. */
async function loopRegionToClip(start: number, length: number): Promise<void> {
  const st = useStore.getState();
  const t = st.transport;
  if ((t.loopEnd ?? 0) - (t.loopStart ?? 0) > 1e-6 || !(length > 0)) return;
  await st.exec("set_transport", { loopStart: start, loopEnd: start + length });
}

// One drop at a time. + Drum beat and + Chords stay enabled while their own promise runs, so a
// double click would otherwise run the drop twice: two Drums tracks (two undo steps), or a second
// + Chords colliding with the first click's own open batch. The flag is set synchronously on
// the call (before the drop's first await) and cleared when the drop settles, even on a throw.
// A call made while another drop is in flight does nothing and resolves null.
let dropInFlight = false;
async function oneDropAtATime<T>(drop: () => Promise<T>): Promise<T | null> {
  if (dropInFlight) return null;
  dropInFlight = true;
  try { return await drop(); } finally { dropInFlight = false; }
}

/** Drop the default beat: one add_drum_pattern (dropBars bars at dropStart — BEAT_BARS, or the
 *  loop with Loop ON), then select the new clip — the editor stays CLOSED so Loop and Play are
 *  reachable at once (double-click or Enter opens it). Returns null and leaves lastError set
 *  when the engine refuses; resolves null without doing anything while another drop runs. */
export const dropDrumBeat = (): Promise<DroppedBeat | null> => oneDropAtATime(dropDrumBeatNow);

async function dropDrumBeatNow(): Promise<DroppedBeat | null> {
  const s = useStore.getState();
  const start = dropStart(s);
  const r = await s.exec("add_drum_pattern", {
    pattern: DEFAULT_DRUM_BEAT, name: "Drums", start, bars: dropBars(s),
  }) as { ok: boolean; data?: Partial<DroppedBeat>; error?: string };
  if (!r.ok || !r.data?.trackId || !r.data.clipId) return null;
  const { trackId, clipId } = r.data;
  // Native lands the new track through events; the mock through invalidate(). Refresh so the
  // selection below always sees the track, whichever backend answered (and so a caller that
  // reads the snapshot right after this resolves sees it too).
  await useStore.getState().refresh();
  const st = useStore.getState();
  const clip = st.snapshot?.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId);
  if (clip) await loopRegionToClip(clip.start, clip.length);
  st.setSelectedTrack(trackId);
  st.select([clipId]);
  return { trackId, clipId, noteCount: r.data.noteCount ?? 0 };
}

// ── + Chords (demo readiness A20) ────────────────────────────────────────────────────────
// A fixed four-chord progression in A minor — Am, F, C, G, one chord per bar held for the whole
// bar — so the Presets moment has notes to play from an empty session. MIDI pitches per bar.
export const CHORD_PROGRESSION: readonly (readonly number[])[] = [
  [57, 60, 64],   // Am
  [53, 57, 60],   // F
  [55, 60, 64],   // C
  [55, 59, 62],   // G
];
const CHORD_VELOCITY = 90;
const KEYS_PRESET = /keys/i;   // the bundled 4OSC patch: "mosh-keys" today, "Keys" once renamed

export type DroppedChords = { trackId: string; clipId: string; noteCount: number; preset: string | null };

type Exec = (command: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; error?: string }>;

/** Notes for the progression, in beats (the clip's note unit): bar i starts at i × beatsPerBar. */
export function chordNotes(beatsPerBar: number): { pitch: number; start: number; length: number; velocity: number }[] {
  return CHORD_PROGRESSION.slice(0, BEAT_BARS).flatMap((chord, bar) =>
    chord.map((pitch) => ({ pitch, start: bar * beatsPerBar, length: beatsPerBar, velocity: CHORD_VELOCITY })));
}

/** + Chords: ONE batch (one undo step) — create_track "Keys" → add_midi_clip (BEAT_BARS bars at the
 *  + Drum beat start rule, so at the loop start while Loop is on; the engine loads the default 4OSC onto the instrument-less track) →
 *  add_note with the whole progression → load_preset of the bundled Keys patch, best effort (a
 *  missing or refused preset keeps the chords). Then the new track is selected and the Browser
 *  opens on its Presets tab. The preset list is read BEFORE the batch (read-only), so the batch
 *  holds edits only. While another batch is open it refuses instead of folding the user's click
 *  into that batch's undo step, and names Moshi as the cause only while a Moshi task is live.
 *  Resolves null without doing anything while another drop runs. */
export const dropChords = (): Promise<DroppedChords | null> => oneDropAtATime(dropChordsNow);

async function dropChordsNow(): Promise<DroppedChords | null> {
  const s = useStore.getState();
  const exec = s.exec as unknown as Exec;
  const start = dropStart(s);
  const meter = meterAt(tempoMapFrom(s.snapshot?.session), start);
  const length = BEAT_BARS * barSeconds(meter);

  const listed = await exec("list_presets", { plugin: "4osc" });
  const presets = (listed.ok ? (listed.data as { presets?: { name: string; file: string }[] } | undefined)?.presets : undefined) ?? [];
  const keys = presets.find((p) => KEYS_PRESET.test(p.name) || KEYS_PRESET.test(p.file.split("/").pop() ?? ""));

  const begin = await exec("batch_begin", { name: "Add chords" });
  if (!begin.ok) {
    s.setLastError(agentTaskLive()
      ? "Moshi is still working — add chords when it finishes"
      : "+ Chords: another edit is still open — try again when it finishes");
    return null;
  }
  let trackId = "", clipId = "", noteCount = 0, preset: string | null = null, failure: string | null = null;
  try {
    const t = await exec("create_track", { name: "Keys" });
    trackId = String((t.data as { trackId?: string } | undefined)?.trackId ?? "");
    if (!t.ok || !trackId) { failure = t.error ?? "could not create the Keys track"; return null; }
    const c = await exec("add_midi_clip", { trackId, start, length, name: "Chords" });
    clipId = String((c.data as { clipId?: string } | undefined)?.clipId ?? "");
    if (!c.ok || !clipId) { failure = c.error ?? "could not add the chord clip"; return null; }
    const n = await exec("add_note", { clipId, notes: chordNotes(meter.num) });
    if (!n.ok) { failure = n.error ?? "could not write the chords"; return null; }
    noteCount = Number((n.data as { noteCount?: number } | undefined)?.noteCount ?? 0);
    if (keys) {
      try {
        const lp = await exec("load_preset", { trackId, file: keys.file });
        if (lp.ok) preset = keys.name;
      } catch { /* best effort: the chords stay on the default patch */ }
    }
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
    return null;
  } finally {
    await exec("batch_end", {});
    // A half-built part is worse on stage than none: undo the batch we own (it holds at least the
    // new track, so this one undo reverts exactly it), and say why.
    if (failure !== null) {
      if (trackId) await exec("undo");
      s.setLastError(`+ Chords: ${failure}`);
      await useStore.getState().refresh();
    }
  }
  await useStore.getState().refresh();
  const st = useStore.getState();
  if (preset) {
    // name the loaded patch in the Presets pane (the 4OSC the engine put on the new track)
    const synth = st.snapshot?.tracks.find((t) => t.id === trackId)?.plugins?.find((p) => p.isInstrument);
    if (synth) usePresetMemory.getState().remember(trackId, synth.index, preset);
  }
  st.setSelectedTrack(trackId);
  st.select([clipId]);
  const shell = useV3.getState();
  shell.setPane("browser");
  shell.setBrowserTab("presets");
  return { trackId, clipId, noteCount, preset };
}
