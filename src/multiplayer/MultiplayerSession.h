#pragma once

#include "MultiplayerClient.h"
#include <juce_events/juce_events.h>
#include <atomic>
#include <functional>
#include <map>
#include <thread>

namespace mosh
{

/** The live multiplayer session: owns a MultiplayerClient and a BACKGROUND poll
    thread. MultiplayerClient.poll() does blocking HTTP, so it must NOT run on the
    message thread; the loop marshals every result back to the message thread via
    MessageManager::callAsync (the engine + WebView are message-thread only).

    Wiring is via three callbacks (set by MoshOps), so this class stays decoupled
    from Tracktion/the bridge:
      - applyCommit(blob)  : apply a peer's track commit (-> apply_remote_track)
      - emit(type,payload) : push mp_state / peer_selection to the WebView
      - syncLocks(...)      : feed the relay lock table into the local guard

    The command-driven calls (create/join/leave/claim/commit/broadcastSelection)
    run on the message thread from the MoshOps mp_* commands; they each do a single
    short HTTP round-trip. Only the continuous poll lives on the background thread. */
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
    /** Stop polling + leave the room; pushes an inactive mp_state. */
    void leaveSession();

    bool         active()   const { return running_.load(); }
    juce::String roomCode() const { return client_.roomCode(); }
    juce::String selfPeer() const { return client_.peerId(); }

    /** Claim `logicalId` on the relay (the lock arbiter). Returns the granted epoch,
        or -1 if denied. Remembers the epoch so a later commit() is not fenced. */
    int  claim (const juce::String& logicalId);
    /** Serialize-published commit of a track we hold (carrying its stem hashes),
        then release the lock. */
    void commit (const juce::String& logicalId, const juce::String& blob, const juce::var& audioRefs);
    /** Publish our current selection (presence) to the room. */
    void broadcastSelection (const juce::String& trackId, const juce::String& clipId);
    /** Mirror a session-global scalar op ({command, args}) to the peer. */
    void broadcastStructural (const juce::String& command, const juce::var& args);
    /** P4 — upload/download a content-addressed stem via the relay's signed URLs. */
    bool uploadBlob (const juce::String& hash, const juce::String& ext, const juce::File& file);
    bool downloadBlob (const juce::String& hash, const juce::String& ext, const juce::File& dest);

private:
    void startPoll();
    void stopPoll();
    void pollLoop();

    MultiplayerClient client_;
    ApplyCommitFn      applyCommit_;
    EmitFn             emit_;
    SyncLocksFn        syncLocks_;
    ProvideBootstrapFn provideBootstrap_;
    ApplyBootstrapFn   applyBootstrap_;
    ApplyStructuralFn  applyStructural_;
    std::map<juce::String, int> heldEpochs_;   // logicalId -> granted epoch (commit fencing)
    std::thread        pollThread_;
    std::atomic<bool>  running_ { false };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MultiplayerSession)
};

} // namespace mosh
