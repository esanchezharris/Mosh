import type { Snapshot, Track } from "../types";

// MP-001 — pure multiplayer helpers (no React, no bridge): the commit-on-move
// trigger derivation and the lock-ownership lookups. The selection-driven trigger
// is only a HINT; the store backstops it with an idle checkpoint timer.

export const SESSION_KEY = "__session__";

export type PeerInfo = { name: string; color: string; online: boolean };
export type MpSession = { active: boolean; roomCode: string | null; selfPeer: string | null; connected: boolean };
export type PeerSelection = { trackId: string | null; clipId: string | null };
export type PeerPresence = { position: number; playing: boolean; recording: boolean; updatedAtMs: number };
export type SyncActions = { release: string | null; claim: string | null };

/** The track the local user is "actively editing" — the trigger for commit-on-move.
 *  The track of the first selected CLIP, else the selected track, else null. */
export function deriveActiveTrackId(
  selection: Iterable<string>,
  selectedTrackId: string | null,
  snapshot: Snapshot | null,
): string | null {
  if (snapshot) {
    for (const clipId of selection) {
      const owner = snapshot.tracks.find((t) => t.clips.some((c) => c.id === clipId));
      if (owner) return owner.id;
    }
  }
  return selectedTrackId ?? null;
}

/** When the active track transitions prev -> next, commit+release prev and claim next.
 *  A no-op when unchanged. */
export function computeSyncActions(prev: string | null, next: string | null): SyncActions {
  if (prev === next) return { release: null, claim: null };
  return { release: prev, claim: next };
}

/** A track's stable logical id (the relay lock key) from the snapshot. */
export function logicalIdOf(trackId: string | null, snapshot: Snapshot | null): string | null {
  if (!trackId || !snapshot) return null;
  return snapshot.tracks.find((t) => t.id === trackId)?.logicalId ?? null;
}

/** The peer that holds a track's lock (by the track's logicalId), or null if free. */
export function lockOwnerOfTrack(
  track: Pick<Track, "logicalId"> | null | undefined,
  locksByLogicalId: Record<string, string>,
): string | null {
  const lid = track?.logicalId;
  if (!lid) return null;
  return locksByLogicalId[lid] ?? null;
}

/** True when a track is locked by a peer OTHER than us (so the UI marks it read-only). */
export function isTrackLockedByOther(
  track: Pick<Track, "logicalId"> | null | undefined,
  locksByLogicalId: Record<string, string>,
  selfPeer: string | null,
): boolean {
  const owner = lockOwnerOfTrack(track, locksByLogicalId);
  return owner !== null && owner !== selfPeer;
}

/** Drop locks held by a peer who is no longer present-and-online. The relay's lock
 *  table can briefly outlive a peer (a crashed owner's lock lingers until its lease
 *  lapses, and a poll's {peers, locks} can disagree for a tick), which would paint a
 *  stale read-only badge. Our own locks are always kept; a lock is kept only if its
 *  owner is a current, online peer. Purely PRESENTATIONAL — the backend lock guard
 *  remains the real arbiter; this just keeps the badge honest. */
export function pruneOfflineLocks(
  locksByLogicalId: Record<string, string>,
  peers: Record<string, { online: boolean }>,
  selfPeer: string | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [logicalId, owner] of Object.entries(locksByLogicalId)) {
    if (owner === selfPeer || peers[owner]?.online) out[logicalId] = owner;
  }
  return out;
}
