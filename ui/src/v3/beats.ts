import { useStore } from "../store";

// V3 parity brief rows 2–3: "drop in a beat" is ONE command. add_drum_pattern with no target
// creates a drum track, loads the bundled kit and lays the pattern in a one-bar clip inside a
// single transaction (MoshOps cmdAddDrumPattern; bridge.mock mirrors it), so the drop is one
// undo step. The pattern is the same string grammar the agent uses ("lane: steps; …").
export const DEFAULT_DRUM_BEAT = "kick: x...x...x...x...; snare: ....x.......x...; hat: x.x.x.x.x.x.x.x.";

export type DroppedBeat = { trackId: string; clipId: string; noteCount: number };

/** Drop the default beat at the playhead: one add_drum_pattern, then select the new clip and
 *  open the shared editor on it (pads + sequencer tabs are its drum-clip mode). Returns null
 *  and leaves lastError set when the engine refuses. */
export async function dropDrumBeat(): Promise<DroppedBeat | null> {
  const s = useStore.getState();
  const r = await s.exec("add_drum_pattern", {
    pattern: DEFAULT_DRUM_BEAT, name: "Drums", start: s.transport.position ?? 0,
  }) as { ok: boolean; data?: Partial<DroppedBeat>; error?: string };
  if (!r.ok || !r.data?.trackId || !r.data.clipId) return null;
  const { trackId, clipId } = r.data;
  // Native lands the new track through events; the mock through invalidate(). Refresh so the
  // selection below always sees the track, whichever backend answered (and so a caller that
  // reads the snapshot right after this resolves sees it too).
  await useStore.getState().refresh();
  const st = useStore.getState();
  st.setSelectedTrack(trackId);
  st.select([clipId]);
  st.openPianoRoll(clipId);
  return { trackId, clipId, noteCount: r.data.noteCount ?? 0 };
}
