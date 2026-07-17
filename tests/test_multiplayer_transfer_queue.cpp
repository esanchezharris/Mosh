#include <catch2/catch_test_macros.hpp>
#include "multiplayer/TransferQueue.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <vector>

using namespace mosh;

namespace
{
    // A synchronous stand-in for juce::MessageManager::callAsync: just invokes the
    // apply closure inline, on whatever thread calls it (the TransferQueue's own
    // worker thread, in these tests). That keeps the tests deterministic and
    // message-loop-free while still exercising the SAME ordering contract real
    // usage relies on (a real callAsync preserves FIFO delivery order too).
    TransferQueue::Dispatcher inlineDispatcher()
    {
        return [] (std::function<void()> f) { if (f) f(); };
    }

    // Poll a predicate up to a bounded deadline instead of a fixed sleep — avoids
    // both flakiness (too short) and needless slowness (too long) on a real
    // background thread. Mirrors the busy-wait style already used by
    // test_multiplayer_outbox.cpp's concurrent-producers test.
    bool waitUntil (std::function<bool()> pred, int timeoutMs = 2000)
    {
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds (timeoutMs);
        while (std::chrono::steady_clock::now() < deadline)
        {
            if (pred()) return true;
            std::this_thread::sleep_for (std::chrono::milliseconds (2));
        }
        return pred();
    }
}

// TransferQueue is the engine-free, HTTP-free ordered-worker seam that lets
// MultiplayerSession move slow stem transfers off the message thread AND off the
// poll thread (a dedicated thread, so a multi-minute upload never starves the
// poll loop's /mp/events heartbeat + lock-lease refresh) while still preserving
// the relative apply order of commit/bootstrap_state/structural frames.

TEST_CASE ("transfer queue: an empty job (no prefetch, no apply) completes harmlessly", "[multiplayer][transferqueue]")
{
    TransferQueue q (inlineDispatcher());
    REQUIRE (q.completedCount() == 0);
    q.enqueue ({});
    REQUIRE (waitUntil ([&] { return q.completedCount() == 1; }));
}

TEST_CASE ("transfer queue: prefetch runs on the worker thread; apply is dispatched afterwards", "[multiplayer][transferqueue]")
{
    TransferQueue q (inlineDispatcher());
    std::atomic<bool> prefetchRan { false };
    std::atomic<bool> applyRan { false };
    std::atomic<bool> applySawPrefetchDone { false };

    TransferQueue::Job job;
    job.prefetch = [&] { prefetchRan.store (true); };
    job.apply    = [&] { applySawPrefetchDone.store (prefetchRan.load()); applyRan.store (true); };
    q.enqueue (std::move (job));

    REQUIRE (waitUntil ([&] { return applyRan.load(); }));
    REQUIRE (prefetchRan.load());
    REQUIRE (applySawPrefetchDone.load());
}

TEST_CASE ("transfer queue: a job may omit prefetch (apply-only, e.g. a structural mirror)", "[multiplayer][transferqueue]")
{
    TransferQueue q (inlineDispatcher());
    std::atomic<bool> applyRan { false };

    TransferQueue::Job job;
    job.apply = [&] { applyRan.store (true); };
    q.enqueue (std::move (job));

    REQUIRE (waitUntil ([&] { return applyRan.load(); }));
}

TEST_CASE ("transfer queue: a job may omit apply (e.g. the host's bootstrap-answer upload+publish)", "[multiplayer][transferqueue]")
{
    TransferQueue q (inlineDispatcher());
    std::atomic<bool> prefetchRan { false };

    TransferQueue::Job job;
    job.prefetch = [&] { prefetchRan.store (true); };
    q.enqueue (std::move (job));

    REQUIRE (waitUntil ([&] { return q.completedCount() == 1; }));
    REQUIRE (prefetchRan.load());
}

TEST_CASE ("transfer queue: apply stages run in strict enqueue (FIFO) order", "[multiplayer][transferqueue]")
{
    TransferQueue q (inlineDispatcher());
    std::mutex order_m;
    std::vector<int> order;

    constexpr int kJobs = 20;
    for (int i = 0; i < kJobs; ++i)
    {
        TransferQueue::Job job;
        job.apply = [&order_m, &order, i]
        {
            const std::lock_guard<std::mutex> lk (order_m);
            order.push_back (i);
        };
        q.enqueue (std::move (job));
    }

    REQUIRE (waitUntil ([&] { return q.completedCount() == kJobs; }));

    const std::lock_guard<std::mutex> lk (order_m);
    REQUIRE (order.size() == (size_t) kJobs);
    for (int i = 0; i < kJobs; ++i)
        REQUIRE (order[(size_t) i] == i);
}

TEST_CASE ("transfer queue: order holds even when an earlier job's prefetch is slower than a later one's", "[multiplayer][transferqueue]")
{
    // Job 0's prefetch deliberately takes longer than job 1's -- a naive
    // multi-threaded (non-FIFO-worker) design could let job 1 "finish" and apply
    // first. The single dedicated worker must not let that happen: a fast
    // structural mirror enqueued right after a slow commit upload must still
    // apply strictly AFTER it, never jumping the queue.
    TransferQueue q (inlineDispatcher());
    std::mutex order_m;
    std::vector<int> order;

    TransferQueue::Job slow;
    slow.prefetch = [] { std::this_thread::sleep_for (std::chrono::milliseconds (80)); };
    slow.apply = [&] { const std::lock_guard<std::mutex> lk (order_m); order.push_back (0); };
    q.enqueue (std::move (slow));

    TransferQueue::Job fast;
    fast.apply = [&] { const std::lock_guard<std::mutex> lk (order_m); order.push_back (1); };
    q.enqueue (std::move (fast));

    REQUIRE (waitUntil ([&] { return q.completedCount() == 2; }));

    const std::lock_guard<std::mutex> lk (order_m);
    REQUIRE (order == std::vector<int> ({ 0, 1 }));
}

TEST_CASE ("transfer queue: abort() drains pending jobs -- their prefetch/apply never run", "[multiplayer][transferqueue]")
{
    TransferQueue q (inlineDispatcher());

    // Block the worker on the FIRST job so the rest pile up in the queue while
    // we call abort() -- proving abort() discards work still WAITING, not just
    // work already in flight.
    std::mutex gate_m;
    std::condition_variable gate_cv;
    bool release = false;
    std::atomic<bool> firstStarted { false };

    TransferQueue::Job first;
    first.prefetch = [&]
    {
        firstStarted.store (true);
        std::unique_lock<std::mutex> lk (gate_m);
        gate_cv.wait (lk, [&] { return release; });
    };
    q.enqueue (std::move (first));
    REQUIRE (waitUntil ([&] { return firstStarted.load(); }));

    std::atomic<int> pendingRan { 0 };
    for (int i = 0; i < 5; ++i)
    {
        TransferQueue::Job job;
        job.prefetch = [&pendingRan] { pendingRan.fetch_add (1); };
        job.apply    = [&pendingRan] { pendingRan.fetch_add (1000); };   // distinguishable if it ran
        q.enqueue (std::move (job));
    }
    REQUIRE (q.pending() == 5);   // queued behind the blocked first job

    // abort() BLOCKS (joins the worker) until the first job's own prefetch
    // returns -- exactly like a real slow-transfer job that must cooperatively
    // notice isAborting() and bail out. Call it from another thread (mirroring
    // leaveSession() calling abort() from the message thread while the worker is
    // mid-transfer) and release the gate from here once abort() has flagged
    // aborting_ (which happens BEFORE the join, so this doesn't race).
    std::thread aborter ([&] { q.abort(); });
    REQUIRE (waitUntil ([&] { return q.isAborting(); }));
    {
        const std::lock_guard<std::mutex> lk (gate_m);
        release = true;
    }
    gate_cv.notify_all();
    aborter.join();

    // None of the 5 pending jobs' prefetch or apply ever ran.
    REQUIRE (pendingRan.load() == 0);
}

TEST_CASE ("transfer queue: enqueue after abort() is a silent no-op", "[multiplayer][transferqueue]")
{
    TransferQueue q (inlineDispatcher());
    q.abort();

    std::atomic<bool> ran { false };
    TransferQueue::Job job;
    job.prefetch = [&] { ran.store (true); };
    job.apply    = [&] { ran.store (true); };
    q.enqueue (std::move (job));

    // Give a (would-be) worker a moment to prove it does NOT run this job.
    std::this_thread::sleep_for (std::chrono::milliseconds (50));
    REQUIRE (! ran.load());
    REQUIRE (q.pending() == 0);
    REQUIRE (q.isAborting());
}

TEST_CASE ("transfer queue: isAborting() lets an in-flight prefetch bail out early", "[multiplayer][transferqueue]")
{
    TransferQueue q (inlineDispatcher());
    std::atomic<bool> started { false };
    std::atomic<bool> bailedEarly { false };
    std::atomic<bool> applyRan { false };

    TransferQueue::Job job;
    job.prefetch = [&]
    {
        started.store (true);
        // A long-running transfer's own retry/poll loop should look like this.
        for (int i = 0; i < 500 && ! q.isAborting(); ++i)
            std::this_thread::sleep_for (std::chrono::milliseconds (5));
        if (q.isAborting())
            bailedEarly.store (true);
    };
    job.apply = [&] { applyRan.store (true); };
    q.enqueue (std::move (job));

    REQUIRE (waitUntil ([&] { return started.load(); }));
    q.abort();

    REQUIRE (bailedEarly.load());
    // An interrupted prefetch's apply stage must not run (nothing coherent to apply).
    REQUIRE (! applyRan.load());
}

TEST_CASE ("transfer queue: destruction aborts + joins without explicit abort()", "[multiplayer][transferqueue]")
{
    std::atomic<bool> ran { false };
    {
        TransferQueue q (inlineDispatcher());
        TransferQueue::Job job;
        job.apply = [&] { ran.store (true); };
        q.enqueue (std::move (job));
        REQUIRE (waitUntil ([&] { return ran.load(); }));
    }   // ~TransferQueue() must not hang
    REQUIRE (ran.load());
}
