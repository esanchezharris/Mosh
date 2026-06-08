#pragma once
#include <juce_core/juce_core.h>
#include "Generative.h"
#include <functional>

// ──────────────────────────────────────────────────────────────────────────────
// GenerativeJobManager — the C++ side of the Tier-B job (05). Talks to the
// out-of-process Python generative service over local HTTP + files/manifests:
// spawns/detects it, submits jobs, polls status/progress, cancels, reads the
// result manifest. Model-NEUTRAL — the service hosts FakeAdapter now and
// StableAudio3Adapter later; this code never changes.
//
// TIER WALL: this is a JOB (background/service), never a real-time insert. The
// blocking poll loop in renderLayerViaService() is fine for tests; the app drives
// it on a background thread and marshals decimated progress events to the UI.
// juce_core's URL (WinINet/NSURLSession — no curl) + ChildProcess are all we need.
// ──────────────────────────────────────────────────────────────────────────────
namespace mosh
{
    struct ServiceJobStatus
    {
        juce::String status;       // queued|running|done|error|canceled|unknown
        double       progress = 0.0;
        juce::var    manifest;     // object when done (wavPath/manifestPath/cacheKey/…)
        juce::String error;
        bool isTerminal() const { return status == "done" || status == "error" || status == "canceled"; }
    };

    class GenerativeJobManager
    {
    public:
        GenerativeJobManager (juce::File serviceDirToUse, int portToUse = 8765)
            : serviceDir (std::move (serviceDirToUse)), port (portToUse) {}
        ~GenerativeJobManager() { shutdown(); }

        // Spawn the service (if not already healthy) and wait for /health.
        bool ensureServiceRunning (int timeoutMs = 10000);
        bool isHealthy();

        // Submit a render job → jobId ("" on failure). Audio + manifest land in outDir.
        juce::String submit (const RenderRequest&, const juce::File& outDir);
        ServiceJobStatus poll (const juce::String& jobId);
        bool cancel (const juce::String& jobId);

        void shutdown();   // kill the service if we started it

        juce::String baseUrl() const { return "http://127.0.0.1:" + juce::String (port); }
        int getPort() const { return port; }

    private:
        juce::var httpGet (const juce::String& path);
        juce::var httpSend (const juce::String& method, const juce::String& path, const juce::var& body);

        juce::File serviceDir;
        int port;
        std::unique_ptr<juce::ChildProcess> proc;
        bool weStartedIt = false;
    };

    // Service-backed render orchestration — mirrors the in-process renderLayer()
    // (Generative.h) but routes the render through the job service. CACHE BY FULL
    // FINGERPRINT: a hit reuses the cache with no job; a miss submits, polls to
    // completion (reporting progress), reads the manifest WAV into the cache, and
    // points the layer's cacheArtifact at the rendered file. Cooperative cancel.
    RenderOutcome renderLayerViaService (RenderLayer& layer,
                                         const RenderRequest& req,
                                         GenerativeJobManager& manager,
                                         RenderCache& cache,
                                         const juce::File& outDir,
                                         RenderProgress progress = {},
                                         std::function<bool()> shouldCancel = {});
}
