#pragma once

#include <juce_core/juce_core.h>
#include <mutex>

namespace mosh
{

/** Native HTTP client to the Mosh multiplayer relay (relay/server.py).

    Mirrors the proven juce::URL idiom in GenerativeJobManager: a thin JSON-over-
    HTTP wrapper. One peer createSession()s and shares the returned code; the other
    joinSession()s. publish() forwards a message (e.g. a track commit); poll()
    fetches new frames since the last seen seq, EXCLUDING this peer's own (the relay
    drops self-frames, so there is no echo). The relay is reached at MOSH_RELAY_URL
    (default http://127.0.0.1:8771).

    Transport-only: this class knows nothing about Tracktion or MoshOps. The caller
    decides what to put in a message and what to do with received frames (serialize
    a track into a commit; apply a received commit via apply_remote_track).

    Thread-safety: MultiplayerSession drives this from TWO threads — the background
    poll loop runs poll() while the message thread runs publish()/tryLock()/commit()
    etc. The mutable members below (roomCode_, haveSeq_, needsResync_, lastLocks_,
    lastPeers_, lastError_) are therefore guarded by m_. The juce::var/String members
    are refcounted, so an unsynchronized torn read is a crash, not just a stale value.
    The lock is held ONLY around the brief member read/write critical sections — never
    across the blocking HTTP, so a message-thread call never stalls behind an in-flight
    poll(). peerId_/base_/apiKey_ are set once in the ctor and never mutated, so they
    are read lock-free. */
class MultiplayerClient
{
public:
    /** @param relayBaseUrl  relay root; empty => MOSH_RELAY_URL or the default. */
    explicit MultiplayerClient (const juce::String& relayBaseUrl = {});

    juce::String peerId()    const { return peerId_; }   // immutable after ctor
    juce::String relayUrl()  const { return base_; }     // immutable after ctor
    juce::String roomCode()  const { const std::lock_guard<std::mutex> lk (m_); return roomCode_; }
    bool         connected() const { const std::lock_guard<std::mutex> lk (m_); return roomCode_.isNotEmpty(); }
    int          haveSeq()   const { const std::lock_guard<std::mutex> lk (m_); return haveSeq_; }
    bool         needsResync() const { const std::lock_guard<std::mutex> lk (m_); return needsResync_; }
    juce::String lastError() const { const std::lock_guard<std::mutex> lk (m_); return lastError_; }

    /** Create a fresh room (this peer joins it). Returns the room code, or "". */
    juce::String createSession (const juce::String& name = {}, const juce::String& color = {});
    /** Join an existing room by code. Returns true on success. */
    bool joinSession (const juce::String& code, const juce::String& name = {}, const juce::String& color = {});
    /** Publish a message to the room. Returns the assigned seq, or -1 on error. */
    int  publish (const juce::var& msg);
    /** Fetch new frames since the last seen seq (own frames excluded). Advances the
        internal cursor, updates needsResync(), and captures the room's current
        lock table + roster (lastLocks()/lastPeers()). */
    juce::Array<juce::var> poll();
    /** Claim a lock on `key` (a track's logicalId, or the session key). Returns the
        relay's result object {granted, owner, epoch}. */
    juce::var tryLock (const juce::String& key, bool steal = false);
    /** Release a lock on `key`. Returns true if it was ours and is now free. */
    bool releaseLock (const juce::String& key);
    /** The lock table / roster from the most recent poll (objects: key->owner /
        peerId->{name,color,online}). Written by poll() (poll thread), read here from
        the message thread — guarded by m_ so the refcounted var is never torn. */
    juce::var lastLocks() const { const std::lock_guard<std::mutex> lk (m_); return lastLocks_; }
    juce::var lastPeers() const { const std::lock_guard<std::mutex> lk (m_); return lastPeers_; }
    /** Leave the room (best-effort). */
    void leave();

    // ── P4 audio blobs (cloud relay only; the local self-host relay has no
    //    /mp/blob/* endpoints, so these return false gracefully there) ──
    /** Upload `file` as the content-addressed stem <hash>.<ext>, skipping if the
        relay reports it already exists (dedup). Returns true on success/already-there. */
    bool uploadBlob (const juce::String& hash, const juce::String& ext, const juce::File& file);
    /** Download the stem <hash>.<ext> to `dest` via a signed URL. */
    bool downloadBlob (const juce::String& hash, const juce::String& ext, const juce::File& dest);

private:
    juce::var httpGet  (const juce::String& path);
    juce::var httpPost (const juce::String& path, const juce::var& body);
    // Extra request headers. Adds the Supabase `apikey` (from MOSH_RELAY_APIKEY)
    // when set — required by the cloud Edge Function relay, harmlessly ignored by
    // the local self-host relay, so one binary targets either backend via env.
    juce::String extraHeaders (bool includeContentType) const;
    // Record an error string under m_ (called off the HTTP path, never under the lock).
    void setError (const juce::String& e);

    juce::String base_;                // set in ctor (incl. body), then immutable
    juce::String apiKey_;              // set once in ctor, then immutable
    const juce::String peerId_;        // immutable after ctor (init-list only)

    mutable std::mutex m_;             // guards the four mutable fields below
    juce::String roomCode_;
    int          haveSeq_     = 0;
    bool         needsResync_ = false;
    juce::var    lastLocks_;
    juce::var    lastPeers_;
    juce::String lastError_;
};

} // namespace mosh
