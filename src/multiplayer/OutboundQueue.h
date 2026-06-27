#pragma once

#include <juce_core/juce_core.h>
#include <deque>
#include <map>
#include <mutex>
#include <vector>

namespace mosh
{

/** A thread-safe, fire-and-forget outbound publish queue for MultiplayerSession.

    The message (UI) thread ENQUEUES here in O(1) and returns immediately; the
    background poll thread DRAINS it and does the blocking HTTP publish — so a
    remote/slow relay never stalls the UI. (Before this, broadcastPresence published
    synchronously on the message thread 4×/second — the #157 jank.)

    Two enqueue modes:
      - pushCoalesced(key,msg) keeps only the LATEST message per key. Used for
        "current state" broadcasts (presence position/playing; selection) where a
        stale frame is worthless: if the poll thread is mid-round-trip, this collapses
        the backlog to one frame instead of flushing a useless burst.
      - pushFifo(msg) appends, preserving order and every distinct op. Used for
        broadcasts where each message matters (structural edits, WebRTC signaling).

    Engine-free + HTTP-free (juce::var only) so it is Catch2-testable in isolation. */
class OutboundQueue
{
public:
    /** Enqueue the latest message for `key`, replacing any not-yet-drained one. */
    void pushCoalesced (const juce::String& key, juce::var msg);
    /** Enqueue an ordered, must-not-drop message. */
    void pushFifo (juce::var msg);

    /** Atomically take everything queued — the FIFO messages in insertion order,
        then the coalesced messages in key order — and clear the queue. Called by
        the poll thread; each returned message is then published over HTTP. */
    std::vector<juce::var> drain();

    /** Pending item count (FIFO entries + distinct coalesce keys). Test/introspection. */
    int pending() const;

private:
    mutable std::mutex m_;
    std::deque<juce::var>           fifo_;
    std::map<juce::String, juce::var> coalesced_;
};

} // namespace mosh
