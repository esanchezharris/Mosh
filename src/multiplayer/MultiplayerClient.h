#pragma once

#include <juce_core/juce_core.h>

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
    a track into a commit; apply a received commit via apply_remote_track). */
class MultiplayerClient
{
public:
    /** @param relayBaseUrl  relay root; empty => MOSH_RELAY_URL or the default. */
    explicit MultiplayerClient (const juce::String& relayBaseUrl = {});

    juce::String peerId()    const { return peerId_; }
    juce::String roomCode()  const { return roomCode_; }
    juce::String relayUrl()  const { return base_; }
    bool         connected() const { return roomCode_.isNotEmpty(); }
    int          haveSeq()   const { return haveSeq_; }
    bool         needsResync() const { return needsResync_; }
    juce::String lastError() const { return lastError_; }

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
        peerId->{name,color,online}). Updated by poll() only (single-threaded). */
    juce::var lastLocks() const { return lastLocks_; }
    juce::var lastPeers() const { return lastPeers_; }
    /** Leave the room (best-effort). */
    void leave();

private:
    juce::var httpGet  (const juce::String& path);
    juce::var httpPost (const juce::String& path, const juce::var& body);
    // Extra request headers. Adds the Supabase `apikey` (from MOSH_RELAY_APIKEY)
    // when set — required by the cloud Edge Function relay, harmlessly ignored by
    // the local self-host relay, so one binary targets either backend via env.
    juce::String extraHeaders (bool includeContentType) const;

    juce::String base_;
    juce::String apiKey_;
    juce::String peerId_;
    juce::String roomCode_;
    int          haveSeq_     = 0;
    bool         needsResync_ = false;
    juce::var    lastLocks_;
    juce::var    lastPeers_;
    juce::String lastError_;
};

} // namespace mosh
