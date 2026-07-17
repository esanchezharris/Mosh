#include "TransferQueue.h"

namespace mosh
{

TransferQueue::TransferQueue (Dispatcher dispatchToMessageThread)
    : dispatch_ (std::move (dispatchToMessageThread))
{
    // Started LAST (after every member above is initialised) so the worker never
    // observes a partially-constructed `this`.
    worker_ = std::thread ([this] { workerLoop(); });
}

TransferQueue::~TransferQueue()
{
    abort();   // idempotent; guarantees the worker thread is joined before we're destroyed
}

void TransferQueue::enqueue (Job job)
{
    {
        const std::lock_guard<std::mutex> lk (m_);
        if (aborting_.load())
            return;   // session already ending -- silently drop rather than queue doomed work
        queue_.push_back (std::move (job));
    }
    cv_.notify_one();
}

void TransferQueue::abort()
{
    if (aborting_.exchange (true))
        return;   // idempotent -- a second call just no-ops
    cv_.notify_all();
    if (worker_.joinable())
        worker_.join();
}

int TransferQueue::pending() const
{
    const std::lock_guard<std::mutex> lk (m_);
    return (int) queue_.size();
}

void TransferQueue::workerLoop()
{
    for (;;)
    {
        Job job;
        {
            std::unique_lock<std::mutex> lk (m_);
            cv_.wait (lk, [this] { return aborting_.load() || ! queue_.empty(); });
            // Checked BEFORE popping: once aborting_ is set, every job still
            // waiting in the queue is dropped without ever running (drain-abort).
            if (aborting_.load())
                return;
            job = std::move (queue_.front());
            queue_.pop_front();
        }

        // An exception escaping this std::thread's entry function calls std::terminate()
        // and takes down the whole app. JUCE's net/file API is non-throwing by
        // convention, but this queue is long-lived infra built to make transfers MORE
        // robust -- a single job that somehow throws must fail like any other failed
        // job, not crash the process. On throw we skip apply (the work is incomplete,
        // nothing coherent to hand the message thread).
        bool prefetchOk = true;
        try
        {
            if (job.prefetch)
                job.prefetch();   // may block (HTTP/file I/O) -- this thread exists so nothing else does
        }
        catch (const std::exception& e)
        {
            prefetchOk = false;
            juce::Logger::writeToLog ("TransferQueue: prefetch threw, job dropped: " + juce::String (e.what()));
        }
        catch (...)
        {
            prefetchOk = false;
            juce::Logger::writeToLog ("TransferQueue: prefetch threw (non-std), job dropped");
        }

        // If abort() fired WHILE this job's prefetch was running, its own
        // isAborting() check is expected to have bailed it out early -- the work
        // is incomplete/interrupted, so don't hand its apply stage to the message
        // thread (nothing coherent to apply). Same reasoning for a prefetch that threw.
        if (prefetchOk && ! aborting_.load() && job.apply && dispatch_)
            dispatch_ (job.apply);

        completed_.fetch_add (1);
    }
}

} // namespace mosh
