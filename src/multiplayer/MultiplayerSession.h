#pragma once

#include "MultiplayerClient.h"
#include "OutboundQueue.h"
#include "TransferQueue.h"
#include <juce_events/juce_events.h>
#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <thread>

namespace mosh
{

/** The live multiplayer session: owns a MultiplayerClient, a BACKGROUND poll
    thread, and (PR-2) a dedicated TransferQueue worker for stem uploads/downloads.
    MultiplayerClient.poll() does blocking HTTP, so it must NOT run on the message
    thread; the loop marshals every result back to the message thread via
    MessageManager::callAsync (the engine + WebView are message-thread only).

    Wiring is via three callbacks (set by MoshOps), so this class stays decoupled
    from Tracktion/the bridge:
      - applyCommit(blob)  : apply a peer's track commit (-> apply_remote_track)
      - emit(type,payload) : push mp_state / peer_selection / mp_commit_done to the WebView
      - syncLocks(...)      : feed the relay lock table into the local guard

    Fire-and-forget broadcasts (presence/selection/structural/webrtc) do NOT do HTTP
    on the message thread: they enqueue onto outbox_ in O(1) and the poll thread
    drains + publishes them, so a remote/slow relay never janks the UI (the #157
    250ms periodic presence broadcast made this matter).

    PR-2 — stem transfer off the message thread AND off the poll thread. Every
    upload/download used to run wherever it was called from (the message thread
    for an outbound commit's upload; INSIDE the poll loop's callAsync for a
    received commit's download or the host's bootstrap-answer upload) — a large
    file froze the UI for as long as the transfer took. Now:
      - `commit()` still does its synchronous engine-side prep in the CALLER
        (MoshOps::cmdMpCommitTrack: hash/copy-to-by-hash/repoint/serialize — an
        immutable content-addressed snapshot, so further user edits during the
        upload are safe by construction) and returns immediately; the actual
        upload + publish + lock release run on transferQueue_'s dedicated worker
        thread, with completion reported via an additive `mp_commit_done` event
        (ok/error) — the wire commit message shape is UNCHANGED.
      - Received "commit" / "bootstrap_state" / "structural" frames from pollLoop
        are turned into TransferQueue::Job (prefetch = download any missing
        stems on the worker thread; apply = the existing applyCommit_/
        applyBootstrap_/applyStructural_ callback, dispatched back to the message
        thread) and routed through the SAME single-worker FIFO — even structural
        (whose prefetch is a no-op) — so a fast tempo change enqueued right after
        a slow commit can never apply before it: one worker + strict FIFO +
        callAsync's own FIFO delivery preserves the peer's original seq order
        end-to-end. presence/selection/webrtc/locks/mp_state are UNCHANGED (still
        applied immediately inline) — they are not state that must serialize
        against a stem transfer.
      - The host's bootstrap answer is split: the message-thread part
        (MoshOps::serializeProjectForBootstrapAnswer, called from provideBootstrap_)
        does the engine-touching content-addressing/serialize and returns
        {tracks, annotations, stemFiles[]} WITHOUT uploading; one worker job then
        uploads every stem THEN publishes bootstrap_state (in-job ordering
        guarantees the guest's prefetch finds the blobs already on the relay).
      - Why a DEDICATED worker rather than reusing the poll thread: a multi-minute
        transfer on the poll thread would stop it from calling client_.poll()
        (no /mp/events heartbeat) and so from touch()-ing this peer's own held
        lock leases — the relay auto-frees a lock after 90s of silence
        (supabase/migrations/0001_mp_relay.sql:47; relay/room.py's
        LOCK_LEASE_S) — so a slow OUTBOUND transfer could look like an abandoned
        edit and let a peer steal a lock this user is still actively using. The
        separate worker keeps polling (and the lease) alive throughout.
      - `MOSH_MP_SYNC_TRANSFER=1` reverts every path above to the original fully
        synchronous, inline behaviour (cheap playtest insurance / a kill switch —
        see docs/MULTIPLAYER.md).

    stemBaseDir_ (mutex-guarded, like MultiplayerClient's own mutable members — a
    juce::String is refcounted, so an unsynchronized cross-thread read/write is a
    crash risk, not just staleness) is the worker thread's ONLY way to know where
    the session's `audio/by-hash/` directory lives: the worker must NEVER call
    eng.editFile() itself (same reasoning as MultiplayerClient.h's roomCode_/etc)
    — MoshOps refreshes it (setStemBaseDir) at construction and whenever the
    backing edit file can change (new_project/open_project/save_as) or a session
    starts (create/join). */
class MultiplayerSession
{
public:
    // The full commit message ({logicalId, epoch, blob, audioRefs}) so the receiver
    // can fetch any referenced stems before applying.
    using ApplyCommitFn = std::function<void (const juce::var& commitMsg)>;
    using EmitFn        = std::function<void (const juce::String& type, juce::var payload)>;
    using SyncLocksFn   = std::function<void (bool active, const juce::String& selfPeer,
                                              const std::map<juce::String, juce::String>& locks)>;
    // P6 bootstrap: host serializes the whole project (returns the bundle);
    // joiner adopts a received bundle.
    using ProvideBootstrapFn = std::function<juce::var()>;
    using ApplyBootstrapFn   = std::function<void (const juce::var& bundle)>;
    // Apply a peer's session-global scalar op ({command, args}) locally.
    using ApplyStructuralFn  = std::function<void (const juce::var& msg)>;

    MultiplayerSession (ApplyCommitFn applyCommit, EmitFn emit, SyncLocksFn syncLocks,
                        ProvideBootstrapFn provideBootstrap, ApplyBootstrapFn applyBootstrap,
                        ApplyStructuralFn applyStructural);
    ~MultiplayerSession();

    /** Create a room (this peer joins) + start polling. Returns the code, or "". */
    juce::String createSession (const juce::String& name, const juce::String& color);
    /** Join a room by code + start polling. */
    bool joinSession (const juce::String& code, const juce::String& name, const juce::String& color);
    /** Stop polling + leave the room; aborts any in-flight/queued stem transfer
        (PR-2) before pushing an inactive mp_state. */
    void leaveSession();

    bool         active()   const { return running_.load(); }
    juce::String roomCode() const { return client_.roomCode(); }
    juce::String selfPeer() const { return client_.peerId(); }

    /** True when MOSH_MP_SYNC_TRANSFER=1 pins every transfer path back to fully
        synchronous/inline behaviour (the PR-2 kill switch). */
    bool syncTransferMode() const { return syncMode_; }

    /** PR-2: snapshot the directory stem transfers resolve `audio/by-hash/` under
        (the edit file's parent dir) for the worker thread to use later — call
        from the message thread whenever it can change (session create/join,
        new_project/open_project/save_as) or right after construction. */
    void setStemBaseDir (const juce::String& absoluteDir);

    /** Claim `logicalId` on the relay (the lock arbiter). Returns the granted epoch,
        or -1 if denied. Remembers the epoch so a later commit() is not fenced. */
    int  claim (const juce::String& logicalId);
    /** Publish a committed track. The caller has ALREADY done all synchronous
        engine-side work (content-addressed the clips into `stemFiles`, repointed
        them, serialized `blob`) — `audioRefs` is the wire-safe {hash,ext} array,
        `stemFiles` the parallel array of local absolute paths to upload (never
        sent over the wire). Uploads + publish + lock release run on the transfer
        worker (or inline under MOSH_MP_SYNC_TRANSFER=1); completion is reported
        via an additive `mp_commit_done {logicalId, ok, error?}` event. The lock is
        released in EITHER case (success or failure) — a failed upload must not
        leave the track stuck locked. */
    void commit (const juce::String& logicalId, const juce::String& blob, const juce::var& audioRefs,
                const juce::Array<juce::File>& stemFiles);
    /** Publish our current selection (presence) to the room. */
    void broadcastSelection (const juce::String& trackId, const juce::String& clipId);
    void broadcastPresence (double position, bool playing, bool recording);
    /** Mirror a session-global scalar op ({command, args}) to the peer. */
    void broadcastStructural (const juce::String& command, const juce::var& args);
    /** Point-to-point WebRTC signaling passthrough (SDP/ICE) to one peer. The relay is
        a fan-out, so the message carries `to`; receivers filter on it. Media is P2P —
        only the handshake rides the relay. */
    void sendSignal (const juce::String& toPeer, const juce::var& payload);
    /** P4 — upload/download a content-addressed stem via the relay's signed URLs.
        Direct, synchronous passthrough (used by the self-heal mp_fetch_missing_stems
        command and its own async thread — PR-1 — which manage their own threading;
        NOT routed through transferQueue_). */
    bool uploadBlob (const juce::String& hash, const juce::String& ext, const juce::File& file);
    bool downloadBlob (const juce::String& hash, const juce::String& ext, const juce::File& dest);

    /** Thread-safe in-flight-hash registry (adversarial-review SHOULD-FIX, PR-2
        review). Two independent callers can want to downloadBlob() the SAME hash
        into the SAME dest file concurrently: the message thread's self-heal pass
        (MoshOps::cmdMpFetchMissingStems, sync inline or its own detached std::thread)
        and this session's OWN transfer worker thread (prefetchAudioRefs, called from
        a bootstrap_state/commit job). Before PR-2, only the message-thread self-heal
        pass guarded against RE-ENTERING itself (a MoshOps-local, message-thread-only
        std::set) — it had no way to see the worker thread's in-flight fetches, and
        vice versa. This registry is SHARED and mutex-guarded so both sides
        coordinate through one source of truth: claimStem() atomically tests-and-
        inserts, returning false if someone else already claimed it (the caller must
        SKIP, not race a second downloadBlob into the same dest); always pair with
        releaseStem() (even on failure) so a later pass isn't permanently skipped. */
    bool claimStem (const juce::String& hash);
    void releaseStem (const juce::String& hash);

private:
    void startPoll();
    void stopPoll();
    void pollLoop();

    // PR-2 helpers (defined in the .cpp; kept private -- MoshOps only sees the
    // public surface above).
    juce::String stemBaseDir() const;
    juce::File   byHashDirFor (const juce::String& base) const;
    void         emitCommitDone (const juce::String& logicalId, bool ok, const juce::String& error);
    // Downloads any missing {hash,ext} stems referenced by `audioRefsArr` into
    // `baseDir`/audio/by-hash/. `baseDir` MUST be captured by the caller at enqueue
    // time (see the .cpp doc comment) rather than re-read from stemBaseDir() here.
    void         prefetchAudioRefs (const juce::var& audioRefsArr, const juce::String& baseDir);
    // Route a state-mutating job (commit/bootstrap_state/structural/bootstrap-answer)
    // through the SAME ordered pipeline: the transfer worker in async mode, or run
    // inline (prefetch then apply, right here) under MOSH_MP_SYNC_TRANSFER=1.
    void routeStateMutatingJob (TransferQueue::Job job);
    // True once transferQueue_ has been told to stop (no active queue, or an
    // explicitly aborting one) -- the null-safe abort-check every prefetch closure
    // polls, so a stale in-flight transfer notices a leaveSession() promptly.
    bool transferAborting() const;

    MultiplayerClient client_;
    ApplyCommitFn      applyCommit_;
    EmitFn             emit_;
    SyncLocksFn        syncLocks_;
    ProvideBootstrapFn provideBootstrap_;
    ApplyBootstrapFn   applyBootstrap_;
    ApplyStructuralFn  applyStructural_;
    std::map<juce::String, int> heldEpochs_;   // logicalId -> granted epoch (commit fencing); message-thread only
    OutboundQueue      outbox_;                 // message thread enqueues; poll thread publishes
    std::thread        pollThread_;
    std::atomic<bool>  running_ { false };

    const bool         syncMode_;                // MOSH_MP_SYNC_TRANSFER kill switch, latched at construction
    // PR-2 — dedicated stem-transfer worker. A TransferQueue is NOT restartable
    // after abort() (by design — see TransferQueue.h), so this is recreated fresh
    // by createSession()/joinSession() and torn down by leaveSession() (which
    // aborts + joins the old worker before resetting to null), rather than being
    // one queue reused across a leave/rejoin cycle.
    std::unique_ptr<TransferQueue> transferQueue_;

    mutable std::mutex stemBaseDirMutex_;
    juce::String       stemBaseDir_;              // guarded by stemBaseDirMutex_ -- see class doc

    std::mutex              inFlightMutex_;
    std::set<juce::String>  inFlightStems_;         // guarded by inFlightMutex_ -- see claimStem/releaseStem doc

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MultiplayerSession)
};

} // namespace mosh
