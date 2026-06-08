#include <catch2/catch_test_macros.hpp>
#include "Generative.h"

using namespace mosh;

static RenderRequest makeReq (juce::int64 seed = 1, juce::String prompt = "warm grit")
{
    RenderRequest r;
    r.mode = "generate";
    r.prompt = prompt;
    r.colors = { "grit", "air" };
    r.seed = seed;
    r.fingerprint.upstreamHash = "u1";
    r.fingerprint.modelAdapter = "fake";
    r.fingerprint.modelVersion = "0";
    r.fingerprint.prompt = prompt;
    r.fingerprint.colors = r.colors;
    r.fingerprint.seed = seed;
    return r;
}

TEST_CASE ("generative: first render is a cache MISS and stores the artifact", "[generative]")
{
    FakeAdapter adapter;
    RenderCache cache;
    auto layer = RenderLayer::create ("rl1");

    auto out = renderLayer (layer, makeReq(), adapter, cache);
    REQUIRE (out.ok);
    REQUIRE_FALSE (out.fromCache);
    REQUIRE (adapter.renderCount == 1);
    REQUIRE (cache.size() == 1);
    REQUIRE (layer.getStatus() == RenderStatus::ready);
    REQUIRE (layer.getCacheKey() == makeReq().cacheKey());
}

TEST_CASE ("generative: identical fingerprint is a cache HIT (adapter NOT called)", "[generative]")
{
    FakeAdapter adapter;
    RenderCache cache;
    auto layer = RenderLayer::create ("rl1");

    renderLayer (layer, makeReq(), adapter, cache);          // miss
    auto out = renderLayer (layer, makeReq(), adapter, cache); // same → hit

    REQUIRE (out.ok);
    REQUIRE (out.fromCache);
    REQUIRE (adapter.renderCount == 1);   // NOT re-rendered
    REQUIRE (cache.size() == 1);
}

TEST_CASE ("generative: any fingerprint change → dirty → cache MISS → re-render", "[generative]")
{
    FakeAdapter adapter;
    RenderCache cache;
    auto layer = RenderLayer::create ("rl1");

    renderLayer (layer, makeReq (1), adapter, cache);
    REQUIRE (adapter.renderCount == 1);

    // Changing the seed (a fingerprint input a naive source+params key might miss)
    // must mark the layer dirty and force a re-render.
    REQUIRE (layer.markDirtyIfChanged (makeReq (2).fingerprint));
    REQUIRE (layer.getStatus() == RenderStatus::dirty);

    auto out = renderLayer (layer, makeReq (2), adapter, cache);
    REQUIRE (out.ok);
    REQUIRE_FALSE (out.fromCache);
    REQUIRE (adapter.renderCount == 2);
    REQUIRE (cache.size() == 2);          // two distinct cache entries
}

TEST_CASE ("generative: FakeAdapter output is deterministic per fingerprint", "[generative]")
{
    FakeAdapter a;
    auto r1 = a.render (makeReq (5));
    auto r2 = a.render (makeReq (5));      // same inputs
    auto r3 = a.render (makeReq (6));      // different seed

    REQUIRE (r1.ok);
    REQUIRE (r1.artifact == r2.artifact);  // deterministic
    REQUIRE_FALSE (r1.artifact == r3.artifact);
}

TEST_CASE ("generative: progress is reported and accept/reject set the taste label", "[generative]")
{
    FakeAdapter adapter;
    RenderCache cache;
    auto layer = RenderLayer::create ("rl1");

    std::vector<double> pcts;
    renderLayer (layer, makeReq(), adapter, cache, [&] (double p) { pcts.push_back (p); });
    REQUIRE (! pcts.empty());
    REQUIRE (pcts.back() == 1.0);

    REQUIRE_FALSE (layer.getUserKept());
    acceptRender (layer);
    REQUIRE (layer.getUserKept());
    rejectRender (layer);
    REQUIRE_FALSE (layer.getUserKept());
}
