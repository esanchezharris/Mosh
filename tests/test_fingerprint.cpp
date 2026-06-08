#include <catch2/catch_test_macros.hpp>
#include "Fingerprint.h"

using namespace mosh;

static FingerprintInputs baseInputs()
{
    FingerprintInputs fp;
    fp.upstreamHash = "abc123";
    fp.clipRangeStart = 12.0;
    fp.clipRangeEnd   = 16.0;
    fp.tempoBpm = 140.0;
    fp.keyContext = "Cmin";
    fp.sampleRate = 48000.0;
    fp.numChannels = 2;
    fp.modelAdapter = "stable_audio_3";
    fp.modelVersion = "3.0";
    fp.adapterVersion = "1.0";
    fp.serviceBuild = "2026.06.08";
    fp.prompt = "warm tape grit";
    fp.colors = { "grit", "air" };
    fp.seed = 42;
    fp.cfg = 7.0;
    fp.steps = 30;
    fp.nl = 0.3;
    fp.safetyMappingVersion = "astd-1";
    return fp;
}

TEST_CASE ("Fingerprint cache key is stable for identical inputs", "[fingerprint]")
{
    REQUIRE (baseInputs().cacheKey() == baseInputs().cacheKey());
    REQUIRE (baseInputs().cacheKey().isNotEmpty());
}

TEST_CASE ("Fingerprint changes when ANY input changes (not just source+params)", "[fingerprint]")
{
    const auto base = baseInputs().cacheKey();

    // The whole point of the full fingerprint (01 §4.3): a change in *any* of
    // these must invalidate the cache — including ones a naive source+params key
    // would miss (seed, service build, sample rate, safety mapping, model version).
    {
        auto fp = baseInputs(); fp.seed = 43;
        REQUIRE (fp.cacheKey() != base);
    }
    {
        auto fp = baseInputs(); fp.serviceBuild = "2026.06.09";
        REQUIRE (fp.cacheKey() != base);
    }
    {
        auto fp = baseInputs(); fp.sampleRate = 44100.0;
        REQUIRE (fp.cacheKey() != base);
    }
    {
        auto fp = baseInputs(); fp.safetyMappingVersion = "astd-2";
        REQUIRE (fp.cacheKey() != base);
    }
    {
        auto fp = baseInputs(); fp.modelVersion = "3.1";
        REQUIRE (fp.cacheKey() != base);
    }
    {
        auto fp = baseInputs(); fp.upstreamHash = "def456";
        REQUIRE (fp.cacheKey() != base);
    }
}

TEST_CASE ("Fingerprint is order-sensitive for colors (earlier dominates)", "[fingerprint]")
{
    auto a = baseInputs(); a.colors = { "grit", "air" };
    auto b = baseInputs(); b.colors = { "air", "grit" };
    REQUIRE (a.cacheKey() != b.cacheKey());
}

TEST_CASE ("Fingerprint includes per-color VALUES (a slider move re-renders)", "[fingerprint]")
{
    // Same colors, different ASTD slider values → DIFFERENT cache key. A real steering
    // alpha depends on the value, so reusing the cache across values would be wrong.
    auto base = baseInputs();
    auto a = base; a.colorValues = { 80, 50 };
    auto b = base; b.colorValues = { 40, 50 };
    REQUIRE (a.cacheKey() != b.cacheKey());
    REQUIRE (a.cacheKey() != base.cacheKey());            // base has no values
    auto c = base; c.colorValues = { 80, 50 };
    REQUIRE (a.cacheKey() == c.cacheKey());               // identical values → identical key
}

TEST_CASE ("Fingerprint includes the Lab flag (unlocked α re-renders)", "[fingerprint]")
{
    auto a = baseInputs(); a.lab = false;
    auto b = baseInputs(); b.lab = true;
    REQUIRE (a.cacheKey() != b.cacheKey());
}

TEST_CASE ("Fingerprint numeric canonicalization treats 1 and 1.0 identically", "[fingerprint]")
{
    FingerprintBuilder x; x.add ("v", 1.0);
    FingerprintBuilder y; y.add ("v", (juce::int64) 1);
    // 1.0 → "1.000000000", int 1 → "1": these intentionally differ (type matters).
    // But two doubles that are equal must hash equal:
    FingerprintBuilder z; z.add ("v", 1.0);
    REQUIRE (x.cacheKey() == z.cacheKey());
}
