#include "AsyncRenderPool.h"
#include "DslExecutor.h"   // exec.emit + events::*

namespace mosh
{
    AsyncRenderPool::AsyncRenderPool (DslExecutor& e, GenerativeJobManager& j, RenderCache& c)
        : juce::Thread ("MoshRenderPool"), exec (e), jobs (j), cache (c)
    {
        startThread();
    }

    AsyncRenderPool::~AsyncRenderPool()
    {
        *alive = false;                 // orphaned completions will early-return
        signalThreadShouldExit();
        {
            const juce::ScopedLock sl (lock);
            if (activeJobId.isNotEmpty())
                jobs.cancel (activeJobId);   // stop the Python daemon job too
        }
        wake.signal();
        stopThread (8000);              // > the worker's longest blocking call (warmup/poll)
    }

    void AsyncRenderPool::enqueue (Job job)
    {
        {
            const juce::ScopedLock sl (lock);
            // Idempotent: ignore a duplicate render of a layer already active/queued.
            if (job.layerId == activeLayerId)
                return;
            for (const auto& q : queue)
                if (q.layerId == job.layerId)
                    return;
            cancelRequested.erase (job.layerId);
            queue.push_back (std::move (job));
        }
        wake.signal();
    }

    void AsyncRenderPool::cancel (const juce::String& layerId)
    {
        {
            const juce::ScopedLock sl (lock);
            cancelRequested.insert (layerId);
            for (auto it = queue.begin(); it != queue.end(); )
                it = (it->layerId == layerId) ? queue.erase (it) : std::next (it);
        }
        wake.signal();
    }

    void AsyncRenderPool::cancelAll()
    {
        {
            const juce::ScopedLock sl (lock);
            for (const auto& q : queue)
                cancelRequested.insert (q.layerId);
            if (activeLayerId.isNotEmpty())
                cancelRequested.insert (activeLayerId);
            queue.clear();
        }
        wake.signal();
    }

    bool AsyncRenderPool::isCancelRequested (const juce::String& layerId)
    {
        const juce::ScopedLock sl (lock);
        return cancelRequested.count (layerId) > 0;
    }

    void AsyncRenderPool::run()
    {
        // Proactive warmup: spawn the service early so the (slow, HDD-bound) model
        // load starts at app launch rather than freezing the first render. The 5 s
        // health-wait is < the dtor's stopThread(8000) so shutdown stays responsive;
        // if it times out the service is still spawning and per-job retries confirm it.
        if (! threadShouldExit())
            jobs.ensureServiceRunning (5000);

        while (! threadShouldExit())
        {
            Job job;
            bool have = false;
            {
                const juce::ScopedLock sl (lock);
                if (! queue.empty())
                {
                    job = queue.front();
                    queue.pop_front();
                    activeLayerId = job.layerId;
                    have = true;
                }
            }

            if (! have) { wake.wait (-1); continue; }

            auto clearActive = [this, &job]
            {
                const juce::ScopedLock sl (lock);
                activeLayerId = {};
                activeJobId = {};
                cancelRequested.erase (job.layerId);
            };

            if (isCancelRequested (job.layerId))
            {
                marshalTerminal (job.layerId, RenderStatus::dirty, "idle");
                clearActive();
                continue;
            }

            // Spawn the service + load the model OFF the message thread (the SA3
            // warmup can take minutes from an HDD). The UI shows "rendering" mean-
            // while; if this fails we report an error event rather than blocking.
            if (! jobs.ensureServiceRunning())
            {
                marshalTerminal (job.layerId, RenderStatus::error, "error");
                clearActive();
                continue;
            }

            const auto jobId = jobs.submit (job.req, job.outDir);
            {
                const juce::ScopedLock sl (lock);
                activeJobId = jobId;
            }
            if (jobId.isEmpty())
            {
                marshalTerminal (job.layerId, RenderStatus::error, "error");
                clearActive();
                continue;
            }

            double lastPct = -1.0;
            juce::uint32 lastMs = 0;
            for (;;)
            {
                if (threadShouldExit() || isCancelRequested (job.layerId))
                {
                    jobs.cancel (jobId);
                    marshalTerminal (job.layerId, RenderStatus::dirty, "idle");
                    break;
                }

                const auto st = jobs.poll (jobId);

                // Decimate progress so a long render doesn't flood the event feed.
                const auto now = juce::Time::getMillisecondCounter();
                if (st.progress - lastPct >= 0.01 || now - lastMs >= 250)
                {
                    marshalProgress (job.layerId, st.progress);
                    lastPct = st.progress;
                    lastMs = now;
                }

                if (st.isTerminal())
                {
                    if (st.status == "done" && st.manifest.isObject())
                    {
                        const auto wavPath = st.manifest["wavPath"].toString();
                        juce::MemoryBlock bytes;
                        juce::File wav (wavPath);
                        if (wav.existsAsFile())
                            wav.loadFileAsData (bytes);
                        marshalDone (job.layerId, job.cacheKey, std::move (bytes), wavPath);
                    }
                    else
                    {
                        marshalTerminal (job.layerId, RenderStatus::error, "error");
                    }
                    break;
                }

                juce::Thread::sleep (150);
            }

            clearActive();
        }
    }

    void AsyncRenderPool::marshalProgress (const juce::String& layerId, double pct01)
    {
        auto a = alive;
        juce::MessageManager::callAsync ([this, a, layerId, pct01]
        {
            if (! *a) return;
            exec.emit (events::layerRenderProgress (layerId, pct01 * 100.0, 0.0));
        });
    }

    void AsyncRenderPool::marshalDone (const juce::String& layerId, const juce::String& cacheKey,
                                       juce::MemoryBlock bytes, const juce::String& wavPath)
    {
        auto a = alive;
        juce::MessageManager::callAsync (
            [this, a, layerId, cacheKey, b = std::move (bytes), wavPath]() mutable
        {
            if (! *a) return;
            cache.put (cacheKey, std::move (b));
            if (finalize) finalize (layerId, RenderStatus::ready, "file:" + wavPath);
            exec.emit (events::layerRendered (layerId, "render:" + cacheKey));
            exec.emit (events::layerStatus (layerId, "ready"));
            exec.emit (events::snapshotInvalidated());
        });
    }

    void AsyncRenderPool::marshalTerminal (const juce::String& layerId, RenderStatus status,
                                           const juce::String& uiStatus)
    {
        auto a = alive;
        juce::MessageManager::callAsync ([this, a, layerId, status, uiStatus]
        {
            if (! *a) return;
            if (finalize) finalize (layerId, status, {});
            exec.emit (events::layerStatus (layerId, uiStatus));
            exec.emit (events::snapshotInvalidated());
        });
    }
}
