#include <catch2/catch_test_macros.hpp>
#include "multiplayer/OutboundQueue.h"

#include <atomic>
#include <thread>
#include <vector>

using namespace mosh;

namespace
{
    // Build a tiny tagged message so we can identify it after a round-trip.
    juce::var msgWith (const juce::String& type, int n)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty ("type", type);
        o->setProperty ("n", n);
        return juce::var (o);
    }

    int nOf (const juce::var& v) { return (int) v.getProperty ("n", -1); }
    juce::String typeOf (const juce::var& v) { return v.getProperty ("type", juce::var()).toString(); }
}

// The OutboundQueue is the engine-free, HTTP-free seam that lets the message thread
// hand a fire-and-forget publish to the background poll thread in O(1) instead of
// blocking on a synchronous HTTP POST (the #157 250ms presence-broadcast jank).

TEST_CASE ("outbox: a coalesced message is queued and drained once", "[multiplayer][outbox]")
{
    OutboundQueue q;
    REQUIRE (q.pending() == 0);

    q.pushCoalesced ("presence", msgWith ("presence", 1));
    REQUIRE (q.pending() == 1);

    auto out = q.drain();
    REQUIRE (out.size() == 1);
    REQUIRE (typeOf (out[0]) == "presence");
    REQUIRE (nOf (out[0]) == 1);
}

TEST_CASE ("outbox: coalesced pushes keep only the LATEST per key", "[multiplayer][outbox]")
{
    OutboundQueue q;

    // Periodic presence floods in; only the most recent frame should survive — a
    // slow relay must never back up a burst of stale positions.
    q.pushCoalesced ("presence", msgWith ("presence", 1));
    q.pushCoalesced ("presence", msgWith ("presence", 2));
    q.pushCoalesced ("presence", msgWith ("presence", 3));
    REQUIRE (q.pending() == 1);

    auto out = q.drain();
    REQUIRE (out.size() == 1);
    REQUIRE (nOf (out[0]) == 3);   // newest wins
}

TEST_CASE ("outbox: distinct coalesce keys are independent", "[multiplayer][outbox]")
{
    OutboundQueue q;

    q.pushCoalesced ("presence",  msgWith ("presence", 7));
    q.pushCoalesced ("selection", msgWith ("selection", 9));
    q.pushCoalesced ("presence",  msgWith ("presence", 8));   // overwrites presence only
    REQUIRE (q.pending() == 2);

    auto out = q.drain();
    REQUIRE (out.size() == 2);

    // Coalesced items drain in a deterministic (key-sorted) order: presence < selection.
    REQUIRE (typeOf (out[0]) == "presence");
    REQUIRE (nOf (out[0]) == 8);
    REQUIRE (typeOf (out[1]) == "selection");
    REQUIRE (nOf (out[1]) == 9);
}

TEST_CASE ("outbox: FIFO messages keep insertion order and are never coalesced", "[multiplayer][outbox]")
{
    OutboundQueue q;

    q.pushFifo (msgWith ("structural", 1));
    q.pushFifo (msgWith ("structural", 2));
    q.pushFifo (msgWith ("webrtc", 3));
    REQUIRE (q.pending() == 3);

    auto out = q.drain();
    REQUIRE (out.size() == 3);
    REQUIRE (nOf (out[0]) == 1);
    REQUIRE (nOf (out[1]) == 2);
    REQUIRE (nOf (out[2]) == 3);
}

TEST_CASE ("outbox: drain returns FIFO first, then coalesced, then clears", "[multiplayer][outbox]")
{
    OutboundQueue q;

    q.pushFifo (msgWith ("structural", 10));
    q.pushCoalesced ("presence", msgWith ("presence", 20));
    q.pushFifo (msgWith ("webrtc", 11));

    auto out = q.drain();
    REQUIRE (out.size() == 3);
    REQUIRE (typeOf (out[0]) == "structural");   // FIFO, in order
    REQUIRE (typeOf (out[1]) == "webrtc");
    REQUIRE (typeOf (out[2]) == "presence");      // coalesced, last

    // A second drain on an untouched queue is empty (drain clears).
    REQUIRE (q.pending() == 0);
    REQUIRE (q.drain().empty());
}

TEST_CASE ("outbox: concurrent producers lose nothing (mutex conservation)", "[multiplayer][outbox]")
{
    OutboundQueue q;

    constexpr int kThreads = 8;
    constexpr int kPerThread = 500;
    std::atomic<int> drained { 0 };
    std::atomic<bool> stop { false };

    // A concurrent draining consumer interleaved with the producers.
    std::thread consumer ([&]
    {
        while (! stop.load())
            drained.fetch_add ((int) q.drain().size());
    });

    std::vector<std::thread> producers;
    for (int t = 0; t < kThreads; ++t)
        producers.emplace_back ([&, t]
        {
            for (int i = 0; i < kPerThread; ++i)
                q.pushFifo (msgWith ("structural", t * kPerThread + i));
        });

    for (auto& p : producers) p.join();
    stop.store (true);
    consumer.join();

    drained.fetch_add ((int) q.drain().size());   // sweep anything left
    REQUIRE (drained.load() == kThreads * kPerThread);
}
