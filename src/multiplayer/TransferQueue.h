#pragma once

#include <juce_core/juce_core.h>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>

namespace mosh
{

/** A single dedicated FIFO worker thread for potentially-slow, ordered background
    work (stem uploads/downloads) that must NOT share a thread with time-sensitive
    liveness (MultiplayerSession's poll loop — its /mp/events heartbeat and the
    relay's 90s lock-lease refresh, supabase/migrations/0001_mp_relay.sql:47 /
    relay/room.py's LOCK_LEASE_S) or with the message thread (a multi-second HTTP
    transfer there freezes the UI — the pre-existing "known limit" this class
    exists to fix).

    Each enqueued Job has two stages:
      - prefetch: runs ON THE WORKER THREAD (may block on HTTP/file I/O). May be
        empty (a job with nothing to prefetch — e.g. mirroring a structural op —
        just omits it).
      - apply: dispatched to the MESSAGE THREAD via the caller-supplied Dispatcher
        (real usage: juce::MessageManager::callAsync) AFTER its own job's prefetch
        completes. May be empty (e.g. the host's "answer a bootstrap_request" job
        has nothing to apply locally — it only uploads stems + publishes).

    Ordering guarantee: ONE worker thread processes the FIFO strictly in enqueue
    order — job N's prefetch does not start until job N-1's prefetch has returned
    AND its apply (if any) has been handed to the dispatcher. Since real usage's
    dispatcher (callAsync) itself preserves FIFO delivery to the message thread,
    this means every job's apply stage runs on the message thread in the SAME
    relative order the jobs were enqueued — even though prefetch durations vary
    per job (a fast structural "job" enqueued after a slow commit upload still
    applies strictly after that commit, never jumping ahead of it).

    Engine-free (no Tracktion/JUCE-URL/HTTP types) so it's Catch2-testable in
    isolation: prefetch/apply are plain closures the caller supplies, and tests can
    substitute a synchronous stand-in Dispatcher (just invoke the function inline)
    to get fully deterministic, message-loop-free assertions.

    Lifecycle: abort() stops accepting new jobs (enqueue() after abort() silently
    drops), drains whatever is still queued (their prefetch NEVER runs — this is
    the "drain-abort" the coordinator asked for: a stale transfer for a session
    that's already been left must not keep running), and joins the worker thread.
    A job whose prefetch was ALREADY IN FLIGHT when abort() was called is expected
    to poll isAborting() itself and return early (this class cannot forcibly kill a
    thread mid-syscall) — its apply stage is then also skipped (an interrupted
    prefetch's incomplete/aborted state must not be applied). Not restartable after
    abort(); construct a fresh instance for a new session. */
class TransferQueue
{
public:
    struct Job
    {
        std::function<void()> prefetch;   // worker thread; may be empty
        std::function<void()> apply;      // handed to the Dispatcher after prefetch; may be empty
    };

    /** Runs `job.apply` — real usage passes juce::MessageManager::callAsync; tests
        can pass a synchronous stand-in ([] (std::function<void()> f) { f(); }). */
    using Dispatcher = std::function<void (std::function<void()>)>;

    explicit TransferQueue (Dispatcher dispatchToMessageThread);
    ~TransferQueue();

    TransferQueue (const TransferQueue&) = delete;
    TransferQueue& operator= (const TransferQueue&) = delete;

    /** Enqueue a job. Silently dropped (a no-op) once abort() has been called. */
    void enqueue (Job job);

    /** Stop accepting new jobs, drain whatever's queued (their prefetch never
        runs), and join the worker thread. Idempotent — safe to call more than
        once (and is called by the destructor if not already called). */
    void abort();

    /** True once abort() has been called. A prefetch closure that may run long
        should poll this periodically and return early rather than complete (or
        keep retrying) doomed work. */
    bool isAborting() const { return aborting_.load(); }

    /** Jobs whose prefetch ran to completion AND (if non-empty) had their apply
        handed to the dispatcher. Test/introspection only. */
    int completedCount() const { return completed_.load(); }

    /** Jobs currently queued (not yet picked up by the worker). Test/introspection. */
    int pending() const;

private:
    void workerLoop();

    Dispatcher dispatch_;
    std::atomic<bool> aborting_ { false };
    std::atomic<int>  completed_ { 0 };

    mutable std::mutex     m_;
    std::condition_variable cv_;
    std::deque<Job>        queue_;

    // Constructed LAST so the worker thread never observes a partially-constructed
    // `this` (dispatch_/queue_/etc. above are all initialised before it starts).
    std::thread worker_;
};

} // namespace mosh
