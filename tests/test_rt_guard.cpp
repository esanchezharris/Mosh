#include <catch2/catch_test_macros.hpp>
#include "audio/RealtimeAudioGuard.h"
#include <thread>
#include <atomic>

// This target is compiled with MOSH_RT_GUARD=1 so the tripwire is active and testable. A
// no-abort handler lets us COUNT violations instead of aborting the process on the default
// jassertfalse.
using namespace mosh::rtguard;

namespace
{
    // Install a counting handler once; the global violationCount() is the source of truth.
    struct CountingHandler
    {
        CountingHandler() { setViolationHandler ([] {}); }   // swallow — we assert via violationCount()
    };
    CountingHandler installHandler;

    // Force a real heap allocation the optimiser can't elide.
    volatile void* sink = nullptr;
    void heapAllocate()
    {
        auto* p = new int[64];
        sink = p;
        delete[] p;
    }
}

TEST_CASE ("allocation inside an RT scope is flagged", "[rtguard]")
{
    const long before = violationCount();
    {
        ScopedRealtime rt;
        heapAllocate();
    }
    REQUIRE (violationCount() == before + 1);
}

TEST_CASE ("allocation outside any RT scope is silent", "[rtguard]")
{
    const long before = violationCount();
    heapAllocate();
    REQUIRE (violationCount() == before);
}

TEST_CASE ("RT scope is thread-local: another thread allocating is NOT flagged", "[rtguard]")
{
    // The MAIN thread is "in RT"; a DIFFERENT thread (like anira's bg inference thread)
    // allocates. We measure the WORKER's OWN violation delta around just its allocation —
    // not the global count, because spawning/joining a std::thread allocates ON THE MAIN
    // thread (which is in-scope and legitimately fires). Catch2 REQUIRE is not thread-safe,
    // so the worker reports via atomics and we assert on the main thread after join().
    std::atomic<bool> workerSawRtFlag { true };
    std::atomic<long> workerAllocDelta { -1 };
    {
        ScopedRealtime rt;                   // MAIN thread marked "in RT"
        std::thread other ([&] {
            workerSawRtFlag = onAudioThreadNow();        // expect false — the flag is thread-local
            const long b = violationCount();
            heapAllocate();                              // worker's own g_rtDepth == 0
            workerAllocDelta = violationCount() - b;     // expect 0 — not flagged
        });
        other.join();
    }
    REQUIRE_FALSE (workerSawRtFlag.load());  // proves g_rtDepth is per-thread
    REQUIRE (workerAllocDelta.load() == 0);  // the worker's allocation was NOT flagged
}

TEST_CASE ("nested scopes use a depth counter (still flagged after popping one level)", "[rtguard]")
{
    REQUIRE_FALSE (onAudioThreadNow());
    {
        ScopedRealtime outer;
        {
            ScopedRealtime inner;
            REQUIRE (onAudioThreadNow());
        }
        const long before = violationCount();
        heapAllocate();                      // still inside `outer` ⇒ flagged
        REQUIRE (violationCount() == before + 1);
    }
    REQUIRE_FALSE (onAudioThreadNow());      // fully popped
}
