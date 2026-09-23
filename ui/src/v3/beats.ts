import { useStore } from "../store";
import { barPosAt, barPosToSec, tempoMapFrom } from "../time";

// V3 parity brief rows 2–3: "drop in a beat" is ONE command. add_drum_pattern with no target
// creates a drum track, loads the bundled kit and tiles the one-bar pattern across a
// BEAT_BARS-bar clip inside a single transaction (MoshOps cmdAddDrumPattern, DrumPattern.h;
// bridge.mock mirrors it), so the drop is one undo step. The pattern is the same string grammar
// the agent uses ("lane: steps; …").
export const DEFAULT_DRUM_BEAT = "kick: x...x...x...x...; snare: ....x.......x...; hat: x.x.x.x.x.x.x.x.";

/** Bars a dropped part spans — an integer (the native parser truncates, and caps at 16). */
export const BEAT_BARS = 4;

export type DroppedBeat = { trackId: string; clipId: string; noteCount: number };

type Store = ReturnType<typeof useStore.getState>;

/** Where a dropped part starts: bar 1 in an empty session (nothing to line up with, and the
 *  frozen source stays exactly BEAT_BARS long), otherwise the bar at or before the playhead. */
export function dropStart(s: Pick<Store, "snapshot" | "transport">): number {
  const tracks = s.snapshot?.tracks ?? [];
  if (!tracks.some((t) => t.clips.length > 0)) return 0;
  const map = tempoMapFrom(s.snapshot?.session);
  return Math.max(0, barPosToSec(map, Math.floor(barPosAt(map, s.transport.position ?? 0) + 1e-6)));
}

/** With no loop region yet (loopEnd <= loopStart — how a fresh session boots), make the region
 *  the dropped clip so the TopBar Loop arms exactly it. Only the region: `loop` rides along
 *  unchanged because the mock (like the brace) applies loopStart/loopEnd only when the flag is
 *  present, and the engine sets the range independently of it. An existing region is left alone. */
async function loopRegionToClip(start: number, length: number): Promise<void> {
  const st = useStore.getState();
  const t = st.transport;
  if ((t.loopEnd ?? 0) - (t.loopStart ?? 0) > 1e-6 || !(length > 0)) return;
  await st.exec("set_transport", { loop: !!t.looping, loopStart: start, loopEnd: start + length });
}

/** Drop the default beat: one add_drum_pattern (BEAT_BARS bars at dropStart), then select the
 *  new clip — the editor stays CLOSED so Loop and Play are reachable at once (double-click or
 *  Enter opens it). Returns null and leaves lastError set when the engine refuses. */
export async function dropDrumBeat(): Promise<DroppedBeat | null> {
  const s = useStore.getState();
  const start = dropStart(s);
  const r = await s.exec("add_drum_pattern", {
    pattern: DEFAULT_DRUM_BEAT, name: "Drums", start, bars: BEAT_BARS,
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
