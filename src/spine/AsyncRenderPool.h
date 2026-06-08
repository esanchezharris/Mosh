#pragma once
#include <juce_events/juce_events.h>
#include "Generative.h"             // RenderRequest, RenderCache
#include "GenerativeJobManager.h"   // submit/poll/cancel + ensureServiceRunning
#include "RenderLayer.h"            // RenderStatus
#include <atomic>
#include <deque>
#include <functional>
#include <memory>
#include <set>

// ──────────────────────────────────────────────────────────────────────────────
// AsyncRenderPool — a single owned background worker that runs Tier-B render jobs
// WITHOUT blocking the message thread. The real model (Stable Audio 3, CUDA) loads
// in ~minutes (HDD warmup) and renders in seconds; running the submit/poll loop on
// the message thread would freeze the whole UI (and wedge the single-threaded
// HttpBridge). This pool owns the blocking off-thread and marshals EVERY mutation
// (RenderCache, the Edit/ValueTree via `finalize`) + every event emit back to the
// message thread, so Tracktion's single-thread rule and the cache stay intact.
//
// One worker serializes renders (the bottleneck is one GPU); a FIFO queue lets the
// user fire several ✦ which drain one at a time. `cancel` flags a layer so the
// worker DELETEs its service job. Used only by the app — tests keep the synchronous
// renderLayerViaService path (registerGenerativeEngineCommands with a null pool).
// ──────────────────────────────────────────────────────────────────────────────
namespace mosh
{
    class DslExecutor;

    class AsyncRenderPool : private juce::Thread
    {
    public:
        // Runs ON the message thread: find the layer by id and apply the terminal
        // status (+ cacheArtifact when non-empty). Supplied by the engine (closes
        // over the Edit). Must no-op if the layer was deleted mid-render.
        using FinalizeFn = std::function<void (const juce::String& layerId,
                                               RenderStatus status,
                                               const juce::String& cacheArtifact,
                                               const juce::var& quality)>;

        AsyncRenderPool (DslExecutor& executor, GenerativeJobManager& jobs, RenderCache& cache);
        ~AsyncRenderPool() override;

        void setFinalize (FinalizeFn fn) { finalize = std::move (fn); }

        struct Job
        {
            juce::String  layerId;     // e.g. "layer:7"
            RenderRequest req;
            juce::File    outDir;
            juce::String  cacheKey;
        };

        // All three are called ON the message thread and return immediately.
        void enqueue (Job job);
        void cancel (const juce::String& layerId);
        void cancelAll();

    private:
        void run() override;
        bool isCancelRequested (const juce::String& layerId);
        void marshalProgress (const juce::String& layerId, double pct01);
        void marshalDone (const juce::String& layerId, const juce::String& cacheKey,
                          juce::MemoryBlock bytes, const juce::String& wavPath,
                          juce::var quality);
        void marshalTerminal (const juce::String& layerId, RenderStatus status,
                              const juce::String& uiStatus);
        static juce::var extractQuality (const juce::var& manifest);

        DslExecutor&          exec;
        GenerativeJobManager& jobs;
        RenderCache&          cache;
        FinalizeFn            finalize;

        juce::CriticalSection  lock;
        std::deque<Job>        queue;
        juce::String           activeLayerId, activeJobId;
        std::set<juce::String> cancelRequested;
        juce::WaitableEvent    wake;

        // Set false in the dtor BEFORE the worker is joined; captured by every
        // marshaled lambda so an in-flight completion early-returns during teardown.
        std::shared_ptr<std::atomic<bool>> alive { std::make_shared<std::atomic<bool>> (true) };

        JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (AsyncRenderPool)
    };
}
