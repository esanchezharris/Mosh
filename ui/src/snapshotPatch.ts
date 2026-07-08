import type { Snapshot, Track } from "./types";

// Scoped snapshot invalidation. A provably track-local backend mutation (mixer volume/pan/
// mute, plugin param) emits `snapshot_invalidated` with this payload carrying JUST the
// changed track's var. The UI splices that one track into the snapshot instead of re-pulling
// the whole thing (measured 330 ms / 3.7 MiB at 100 tracks × 200 notes). Anything that can
// touch the track LIST, session, or other tracks still emits a payload-less full invalidation.
export type TrackPatch = { scope: "track"; trackId: string; track: Track };

export function isTrackPatch(payload: unknown): payload is TrackPatch {
  const p = payload as TrackPatch | undefined;
  return !!p && p.scope === "track" && typeof p.trackId === "string" && !!p.track && typeof p.track === "object";
}

/** Replace one track in the snapshot by id, preserving order. Returns null when the id isn't
 *  present (the caller falls back to a full refresh so the UI can't silently miss the change). */
export function applyTrackPatch(snapshot: Snapshot, patch: TrackPatch): Snapshot | null {
  let found = false;
  const tracks = snapshot.tracks.map((t) => {
    if (t.id === patch.trackId) { found = true; return patch.track; }
    return t;
  });
  return found ? { ...snapshot, tracks } : null;
}
