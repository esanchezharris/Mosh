#pragma once
#include <juce_core/juce_core.h>
#include "Fingerprint.h"
#include "RenderLayer.h"
#include <functional>
#include <map>

// ──────────────────────────────────────────────────────────────────────────────
// The generative (Tier-B) orchestration spine (05). Model-NEUTRAL: the
// GenerativeModelAdapter interface is the seam — FakeAdapter (in-process, bring-up)
// and the future StableAudio3Adapter (out-of-process job via the service) both
// implement it. The orchestration above it (render → CACHE BY FULL FINGERPRINT →
// dirty-on-change → accept/reject) is what "FakeAdapter before SA3" proves.
//
// This is pure logic over the spine (no Tracktion/audio/service) so the core
// invariant — reuse keyed by the COMPLETE fingerprint, never source+params — is
// unit-testable anywhere. The job-service transport + Tracktion-take landing are
// layered on top in the engine (Stage 5 continuation).
// ──────────────────────────────────────────────────────────────────────────────
namespace mosh
{
    // What the adapter is asked to render. Built from a RenderLayer's params; the
    // `fingerprint` is the FULL cache key input (01 §4.3 / 05 §5).
    struct RenderRequest
    {
        juce::String      mode;       // "generate" | "reimagine"
        juce::String      prompt;
        juce::StringArray colors;     // ordered, ≤3
        juce::int64       seed = 0;
        double            nl = 0.0;   // re-noise level (reimagine; ≤0.5)
        FingerprintInputs fingerprint;

        juce::String cacheKey() const { return fingerprint.cacheKey(); }
    };

    struct RenderResult
    {
        bool             ok = false;
        juce::String     cacheKey;
        juce::MemoryBlock artifact;   // the rendered audio bytes (a cache payload)
        juce::String     error;       // set when !ok
        juce::String     adapterName;
    };

    using RenderProgress = std::function<void (double pct)>;

    // The model-neutral seam. Implemented by FakeAdapter (here) and, later, by a
    // service-backed StableAudio3Adapter.
    struct GenerativeModelAdapter
    {
        virtual ~GenerativeModelAdapter() = default;
        virtual juce::String name() const = 0;
        virtual RenderResult render (const RenderRequest&, RenderProgress progress = {}) = 0;
    };

    // FakeAdapter — deterministic placeholder for bring-up (05; needs no external
    // deps). The artifact is a stable function of the full fingerprint, so identical
    // inputs yield identical bytes (a real "cache identity") and any input change
    // yields different bytes. Emits a couple of progress ticks.
    class FakeAdapter : public GenerativeModelAdapter
    {
    public:
        juce::String name() const override { return "fake"; }

        RenderResult render (const RenderRequest& req, RenderProgress progress = {}) override
        {
            ++renderCount;
            if (progress) progress (0.0);

            RenderResult r;
            r.adapterName = name();
            r.cacheKey = req.cacheKey();

            // Deterministic placeholder bytes: FNV-1a-stretched from the cache key.
            const auto key = r.cacheKey;
            juce::uint64 h = 1469598103934665603ull;
            for (auto c : key) { h ^= (juce::uint8) c; h *= 1099511628211ull; }
            constexpr int N = 256;
            juce::MemoryBlock mb ((size_t) N);
            auto* bytes = (juce::uint8*) mb.getData();
            for (int i = 0; i < N; ++i)
            {
                h ^= (juce::uint64) i; h *= 1099511628211ull;
                bytes[i] = (juce::uint8) (h >> 24);
            }
            r.artifact = std::move (mb);
            r.ok = true;

            if (progress) progress (1.0);
            return r;
        }

        int renderCount = 0;   // how many real renders happened (cache misses)
    };

    // A render-artifact cache keyed by the full fingerprint cacheKey.
    class RenderCache
    {
    public:
        bool has (const juce::String& key) const { return store.count (key) > 0; }

        const juce::MemoryBlock* get (const juce::String& key) const
        {
            auto it = store.find (key);
            return it == store.end() ? nullptr : &it->second;
        }

        void put (const juce::String& key, juce::MemoryBlock data) { store[key] = std::move (data); }
        int size() const { return (int) store.size(); }
        void clear() { store.clear(); }

    private:
        std::map<juce::String, juce::MemoryBlock> store;
    };

    // Outcome of a render request through the orchestrator.
    struct RenderOutcome
    {
        bool         ok = false;
        bool         fromCache = false;   // true = cache HIT (adapter NOT called)
        juce::String cacheKey;
        juce::String error;
    };

    // The orchestration: build the request from the layer, key by the FULL
    // fingerprint, reuse the cache on a hit, render via the adapter on a miss, and
    // update the layer (cacheKey/status/cacheArtifact). This is the heart of the
    // Tier-B flow the FakeAdapter gate proves.
    inline RenderOutcome renderLayer (RenderLayer& layer,
                                      const RenderRequest& req,
                                      GenerativeModelAdapter& adapter,
                                      RenderCache& cache,
                                      RenderProgress progress = {})
    {
        RenderOutcome out;
        out.cacheKey = req.cacheKey();
        layer.setFingerprint (req.fingerprint);

        if (cache.has (out.cacheKey))
        {
            // Cache HIT — reuse, no adapter call (the point of the full fingerprint).
            out.ok = true;
            out.fromCache = true;
            layer.setStatus (RenderStatus::ready);
            layer.setCacheArtifact ("cache:" + out.cacheKey);
            if (progress) progress (1.0);
            return out;
        }

        layer.setStatus (RenderStatus::rendering);
        auto result = adapter.render (req, std::move (progress));
        if (! result.ok)
        {
            layer.setStatus (RenderStatus::error);
            out.error = result.error;
            return out;
        }

        cache.put (result.cacheKey, result.artifact);
        layer.setStatus (RenderStatus::ready);
        layer.setCacheArtifact ("cache:" + result.cacheKey);
        out.ok = true;
        out.fromCache = false;
        return out;
    }

    // accept/reject = the taste labels (02 §5). accept keeps the render; reject
    // discards the kept flag (and the layer can be re-rendered/cleared upstream).
    inline void acceptRender (RenderLayer& layer, juce::UndoManager* um = nullptr) { layer.setUserKept (true, um); }
    inline void rejectRender (RenderLayer& layer, juce::UndoManager* um = nullptr) { layer.setUserKept (false, um); }
}
