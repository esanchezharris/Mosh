#include <catch2/catch_test_macros.hpp>
#include "GenerativeJobManager.h"
#include <vector>

// ──────────────────────────────────────────────────────────────────────────────
// Stage 5 (Fake) END-TO-END over the real out-of-process service — the C++↔Python
// generative loop, no Tracktion/WebView/MLX. Spawns the stdlib Python service,
// submits a render job, polls progress to completion, reads the result manifest
// WAV into the cache, and proves CACHE BY FULL FINGERPRINT (hit/miss + dirty).
// Separate target (mosh_service_tests) so the fast unit suite stays pure.
// ──────────────────────────────────────────────────────────────────────────────
using namespace mosh;

#ifndef MOSH_SERVICE_DIR
 #define MOSH_SERVICE_DIR ""
#endif

static RenderRequest makeReq (juce::int64 seed)
{
    RenderRequest r;
    r.mode = "generate";
    r.prompt = "warm grit";
    r.colors = { "grit", "air" };
    r.seed = seed;
    r.fingerprint.upstreamHash = "u1";
    r.fingerprint.modelAdapter = "fake";
    r.fingerprint.modelVersion = "0";
    r.fingerprint.prompt = r.prompt;
    r.fingerprint.colors = r.colors;
    r.fingerprint.seed = seed;
    return r;
}

TEST_CASE ("generative service e2e: submit -> poll -> manifest -> cache (hit/miss/dirty)", "[gservice]")
{
    juce::File serviceDir { juce::String (MOSH_SERVICE_DIR) };
    if (! serviceDir.getChildFile ("server.py").existsAsFile())
    {
        WARN ("service/server.py not found at " << serviceDir.getFullPathName() << " — skipping");
        return;
    }

    GenerativeJobManager mgr (serviceDir, 8786);
    REQUIRE (mgr.ensureServiceRunning());     // spawns py service + waits for /health

    RenderCache cache;
    auto outDir = juce::File::getSpecialLocation (juce::File::tempDirectory).getChildFile ("mosh_gsvc_test");
    outDir.deleteRecursively();
    outDir.createDirectory();

    auto layer = RenderLayer::create ("rl1");

    // First render: MISS → submit job, poll to done, manifest WAV cached.
    std::vector<double> pcts;
    auto out = renderLayerViaService (layer, makeReq (42), mgr, cache, outDir,
                                      [&] (double p) { pcts.push_back (p); });
    REQUIRE (out.ok);
    REQUIRE_FALSE (out.fromCache);
    REQUIRE (layer.getStatus() == RenderStatus::ready);
    REQUIRE (! pcts.empty());
    REQUIRE (layer.getCacheArtifact().startsWith ("file:"));
    juce::File wav { layer.getCacheArtifact().fromFirstOccurrenceOf ("file:", false, false) };
    REQUIRE (wav.existsAsFile());
    REQUIRE (wav.getSize() > 0);
    REQUIRE (cache.size() == 1);

    // Same fingerprint → cache HIT (no job submitted).
    auto out2 = renderLayerViaService (layer, makeReq (42), mgr, cache, outDir);
    REQUIRE (out2.ok);
    REQUIRE (out2.fromCache);
    REQUIRE (cache.size() == 1);

    // Changed seed → dirty → MISS → re-render (second distinct artifact).
    REQUIRE (layer.isDirtyAgainst (makeReq (43).fingerprint));
    auto out3 = renderLayerViaService (layer, makeReq (43), mgr, cache, outDir);
    REQUIRE (out3.ok);
    REQUIRE_FALSE (out3.fromCache);
    REQUIRE (cache.size() == 2);

    mgr.shutdown();
    outDir.deleteRecursively();
}
