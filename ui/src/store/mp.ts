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

// MP-003 — how often a parked (never-switched) active track re-publishes + renews
// its lock while idle. Well under the 90s lease (supabase/migrations/0001_mp_relay.sql)
// so several renewal opportunities happen before it could lapse; ticked off the
// mp_state event (~4/s while a session is active — the native poll loop), not a
// separate timer. See mpIdleCheckpointTick's own doc comment for the full story.
export const MP_IDLE_CHECKPOINT_MS = 20_000;

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
  // MP-003 — when we last committed+(re)claimed activeTrackId (a real track
  // switch, or an idle checkpoint). Drives mpIdleCheckpointTick's cadence.
  activeTrackClaimedAtMs: number | null;
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
  // MP-003 — re-commit+re-claim the active track once MP_IDLE_CHECKPOINT_MS has
  // elapsed since it was last (re)claimed. A cheap no-op most calls (the clock
  // hasn't elapsed yet); called from the mp_state event handler.
  mpIdleCheckpointTick: () => Promise<void>;
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
  activeTrackClaimedAtMs: null,
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
          activeTrackClaimedAtMs: null,
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
  // selection. No-op in single-player (mp inactive). Selection is only a hint;
  // mpIdleCheckpointTick backstops a long edit that never moves off a track.
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
      if (claim) {
        await s.exec("mp_claim_track", { trackId: claim });
        // MP-003 — (re)start the idle-checkpoint clock: a freshly claimed track
        // shouldn't immediately re-checkpoint itself.
        set({ activeTrackClaimedAtMs: Date.now() });
      }
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

  // MP-003 — closes two related, previously-open gaps (prior audit:
  // docs/2026-07-17-mp-playtest-readiness-audit.md §3 #1): the lock lease
  // (90s, supabase/migrations/0001_mp_relay.sql) is never renewed while parked
  // on one track, so (a) the peer sees nothing from a long single-track session
  // until a track switch, and (b) another peer merely re-clicking the same track
  // after ~90s can silently steal the lock. docs/MULTIPLAYER.md and this file's
  // own former comments already CLAIMED a "native idle checkpoint" backstopped
  // this — it did not exist anywhere in the codebase (confirmed by the prior
  // audit's exhaustive grep); this is that mechanism, built for real.
  //
  // Re-committing the active track (serialize+publish — content-addressed/
  // deduped, so re-sending unchanged audio is cheap) both flushes progress to
  // the peer (fixes a) AND, by immediately re-claiming the same track right
  // after, mints a fresh epoch + a fresh 90s lease server-side (mp_try_lock's
  // own ON CONFLICT branch grants a renewal to the current owner — see
  // supabase/migrations/0001_mp_relay.sql), fixing the lease-theft gap too (b).
  // There is a brief (sub-second) window between the commit's lock release and
  // the re-claim where a peer racing for the SAME track could win it first —
  // accepted as rare, same posture as tempo's own last-writer-wins; the periodic
  // MP_IDLE_CHECKPOINT_MS < the 90s lease bounds how long a genuinely idle track
  // could ever sit unrenewed to begin with.
  //
  // Deliberately ticked off the mp_state event (already firing ~4/s while a
  // session is active — the native poll loop) rather than a dedicated
  // setInterval, so there is nothing extra to tear down on unmount/leave.
  mpIdleCheckpointTick: async () => {
    const s = get();
    if (!s.mp.active) return;
    const trackId = s.activeTrackId;
    if (!trackId) return;
    const last = s.activeTrackClaimedAtMs;
    if (last !== null && Date.now() - last < MP_IDLE_CHECKPOINT_MS) return;
    // Stamp the clock FIRST: mp_state ticks every ~250ms, and the commit/claim
    // round trip below is async, so without this a burst of ticks while one
    // checkpoint is still in flight would fire several redundant ones.
    set({ activeTrackClaimedAtMs: Date.now() });
    const r = await s.exec("mp_commit_track", { trackId });
    const lid = r.ok ? (r.data as { logicalId?: string } | undefined)?.logicalId : undefined;
    if (lid) {
      set((st) => {
        const failedCommits = { ...st.failedCommits };
        delete failedCommits[lid];
        return { pendingCommits: { ...st.pendingCommits, [lid]: true }, failedCommits };
      });
    }
    // Only re-claim if this is still the track we're actively on (a real track
    // switch — syncActiveTrack — could have raced ahead while the commit above
    // was in flight; that path owns its own claim, so don't fight it).
    if (get().activeTrackId === trackId) await s.exec("mp_claim_track", { trackId });
  },
});
