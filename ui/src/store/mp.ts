// Multiplayer slice (MP-001) — presence state fed by the peer_* / mp_state events
// (off the snapshot, like the telemetry rails) plus the session/commit actions.
// All UI-local reactions; mutations still flow through commands. Inactive in
// single-player, so these stay empty/no-op. The module-level `mpSyncChain`
// serializer moves here WITH its only user (syncActiveTrack) — it is intentionally
// outside the React/zustand lifecycle and keeps identical single-instance semantics.
import type { StateCreator } from "zustand";
import type { CommandResult } from "../types";
// MP-001 — multiplayer presence + the commit-on-move trigger (pure helpers).
import {
  deriveActiveTrackId, computeSyncActions,
  type MpSession, type PeerInfo, type PeerSelection, type PeerPresence,
} from "../multiplayer/sync";
// Type-only imports from the store module (erased at compile time — no runtime cycle).
import type { State } from "../store";

export type MpSlice = {
  // MP-001 — multiplayer presence, fed by the peer_* / mp_state events (off the
  // snapshot, like transport/levels). All UI-local reactions; mutations still flow
  // through commands. Inactive in single-player, so these stay empty/no-op.
  mp: MpSession;
  peers: Record<string, PeerInfo>;                 // peerId -> name/color/online
  peerSelection: Record<string, PeerSelection>;    // peerId -> their current selection
  peerPresence: Record<string, PeerPresence>;
  locksByLogicalId: Record<string, string>;        // logicalId -> ownerPeerId
  activeTrackId: string | null;                    // derived; the commit-on-move trigger
  // PR-2 adversarial-review BLOCKER: mp_commit_done previously had no frontend
  // consumer at all — a failed stem upload (commit-on-move, PR-2's async transfer)
  // was invisible; the track just silently stayed sourceMissing for the peer.
  // Keyed by logicalId (what mp_commit_done carries), not trackId (transient/UI).
  pendingCommits: Record<string, true>;            // logicalId -> mid-upload ("uploading")
  failedCommits: Record<string, string>;           // logicalId -> last error (persists until a retry succeeds)
  retryFailedCommit: (logicalId: string) => Promise<void>;
  mpCreateSession: (name?: string, color?: string) => Promise<void>;
  // Returns the raw result so the join UI can render INLINE failure feedback (#42);
  // the global lastError is still set for surfaces that only watch the error bar.
  mpJoinSession: (code: string, name?: string, color?: string) => Promise<CommandResult>;
  mpLeaveSession: () => Promise<void>;
  syncActiveTrack: () => Promise<void>;            // recompute activeTrack; commit+claim on change
};

// Serializes overlapping syncActiveTrack() runs (rapid selection changes) so their
// commit/claim/broadcast relay round-trips never interleave — a commit must never
// race ahead of (or behind) its own claim. Each run is chained after the previous;
// `run` is used as both fulfil and reject handler so a failed link can't wedge it.
let mpSyncChain: Promise<void> = Promise.resolve();

export const createMpSlice: StateCreator<State, [], [], MpSlice> = (set, get) => ({
  mp: { active: false, roomCode: null, selfPeer: null, connected: false },
  peers: {},
  peerSelection: {},
  peerPresence: {},
  locksByLogicalId: {},
  activeTrackId: null,
  pendingCommits: {},
  failedCommits: {},

  // MP-001 — session entry. The native session manager creates/joins the relay
  // room and starts the poll loop (which emits mp_state / commits / peer_selection).
  mpCreateSession: async (name = "", color = "") => {
    const r = await get().exec("mp_create_session", { name, color });
    if (!r.ok) set({ lastError: r.error ?? "create session failed" });
  },
  mpJoinSession: async (code, name = "", color = "") => {
    const r = await get().exec("mp_join_session", { code, name, color });
    if (!r.ok) set({ lastError: r.error ?? "join session failed" });
    return r;
  },
  mpLeaveSession: async () => {
    await get().exec("mp_leave_session");
    set({ mp: { active: false, roomCode: null, selfPeer: null, connected: false },
          peers: {}, peerSelection: {}, peerPresence: {}, locksByLogicalId: {}, activeTrackId: null,
          pendingCommits: {}, failedCommits: {} });
  },

  // PR-2 adversarial-review BLOCKER: re-fire mp_commit_track for a track whose last
  // commit failed (mp_commit_done{ok:false}). Looks up the CURRENT trackId for this
  // logicalId in the live snapshot (the failure is recorded by logicalId, the only
  // thing mp_commit_done carries; trackId is transient/UI). If the track is gone
  // (removed/undone since the failure), just drop the stale entry.
  retryFailedCommit: async (logicalId) => {
    const s = get();
    const track = s.snapshot?.tracks.find((t) => t.logicalId === logicalId);
    if (!track) {
      set((st) => {
        const failedCommits = { ...st.failedCommits };
        delete failedCommits[logicalId];
        return { failedCommits };
      });
      return;
    }
    set((st) => ({ pendingCommits: { ...st.pendingCommits, [logicalId]: true } }));
    await s.exec("mp_commit_track", { trackId: track.id });
    // The eventual mp_commit_done event (ok:true/false) resolves pendingCommits/
    // failedCommits below — no need to duplicate that bookkeeping here.
  },

  // Commit-on-move: when the actively-edited track changes, commit+release the
  // previous track (serialize -> publish) and claim the next, then broadcast our
  // selection. No-op in single-player (mp inactive). Selection is only a hint; the
  // native idle checkpoint backstops a long edit that never moves off a track.
  syncActiveTrack: () => {
    const run = async () => {
      const s = get();
      if (!s.mp.active) return;
      const next = deriveActiveTrackId(s.selection, s.selectedTrackId, s.snapshot);
      const prev = s.activeTrackId;
      if (prev === next) return;
      set({ activeTrackId: next });
      const { release, claim } = computeSyncActions(prev, next);
      if (release) {
        const r = await s.exec("mp_commit_track", { trackId: release });
        // PR-2 adversarial-review BLOCKER: mp_commit_track's own immediate return only
        // reflects the SYNCHRONOUS engine work (content-address/serialize) — the actual
        // upload success/failure lands later via mp_commit_done (exec() above already
        // surfaces a synchronous-call failure via lastError; this only handles the
        // async upload outcome). Mark it "uploading" now so a stale failure from a
        // PRIOR commit of this same track is cleared the moment a new one starts,
        // rather than lingering after it actually succeeds.
        const lid = r.ok ? (r.data as { logicalId?: string } | undefined)?.logicalId : undefined;
        if (lid) {
          set((st) => {
            const failedCommits = { ...st.failedCommits };
            delete failedCommits[lid];
            return { pendingCommits: { ...st.pendingCommits, [lid]: true }, failedCommits };
          });
        }
      }
      if (claim) await s.exec("mp_claim_track", { trackId: claim });
      await s.exec("mp_broadcast_selection", { trackId: next, clipId: [...s.selection][0] ?? null });
    };
    // Chain after the previous run so two rapid selection changes can't interleave
    // their relay calls. Read state at RUN time (inside `run`), so a burst collapses
    // to the latest active track rather than replaying stale intermediates. `run` is
    // both the fulfil AND reject handler, so a failed link self-heals (the next run
    // still fires); the terminal .catch absorbs the LAST link's rejection (exec can
    // reject at the bridge level) so a trailing failure isn't an unhandledrejection.
    mpSyncChain = mpSyncChain.then(run, run);
    void mpSyncChain.catch(() => {});
    return mpSyncChain;
  },
});
