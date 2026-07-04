#include <catch2/catch_test_macros.hpp>
#include "state/RenderLayer.h"
#include "state/Ids.h"

using namespace mosh;

TEST_CASE ("MOSH_RENDERLAYER round-trips through XML (01 §6)", "[stage1][renderlayer]")
{
    auto v = RenderLayer::create ("rl-1", "clip-42", 0.0, 4.0, "stable_audio3");
    v.setProperty (ids::seed, 12345, nullptr);
    auto params = v.getChildWithName (ids::PARAMS);
    params.setProperty (ids::prompt, "warmer tape saturation", nullptr);

    // Add two ASTD colors (≤3 cap enforced elsewhere).
    auto colors = params.getChildWithName (ids::COLORS);
    juce::ValueTree grit (ids::COLOR);
    grit.setProperty (ids::name, "grit", nullptr);
    grit.setProperty (ids::value, 60, nullptr);
    colors.appendChild (grit, nullptr);

    auto back = RenderLayer::roundTripViaXml (v);

    REQUIRE (back.getType() == ids::MOSH_RENDERLAYER);
    REQUIRE (back[ids::id].toString() == "rl-1");
    REQUIRE (back[ids::inputRef].toString() == "clip-42");
    REQUIRE (back[ids::modelAdapter].toString() == "stable_audio3");
    REQUIRE ((int) back[ids::seed] == 12345);
    REQUIRE (back.getChildWithName (ids::PARAMS)[ids::prompt].toString() == "warmer tape saturation");
    REQUIRE (back.getChildWithName (ids::PARAMS).getChildWithName (ids::COLORS).getNumChildren() == 1);
}

TEST_CASE ("full cache fingerprint is sensitive to route/variant/seed (05 §5)", "[stage1][cache]")
{
    auto v = RenderLayer::create ("rl-1", "clip-42", 0.0, 4.0, "stable_audio3");
    v.setProperty (ids::modelVariant, "sa3-medium", nullptr);
    v.setProperty (ids::mode, "reimagine", nullptr);
    v.setProperty (ids::seed, 1, nullptr);

    const auto base = RenderLayer::fingerprint (v, "upstreamHashAAA", "120bpm/Cmaj", 44100, 2, "svc-1");

    SECTION ("same inputs → same key (cache hit)")
    {
        auto same = RenderLayer::fingerprint (v, "upstreamHashAAA", "120bpm/Cmaj", 44100, 2, "svc-1");
        REQUIRE (same == base);
    }
    SECTION ("changing the route (mode) → different key (no wrong-cache reuse)")
    {
        v.setProperty (ids::mode, "inpaint", nullptr);
        REQUIRE (RenderLayer::fingerprint (v, "upstreamHashAAA", "120bpm/Cmaj", 44100, 2, "svc-1") != base);
    }
    SECTION ("changing the model variant → different key")
    {
        v.setProperty (ids::modelVariant, "sa3-small", nullptr);
        REQUIRE (RenderLayer::fingerprint (v, "upstreamHashAAA", "120bpm/Cmaj", 44100, 2, "svc-1") != base);
    }
    SECTION ("changing the upstream audio → different key (dirty)")
    {
        REQUIRE (RenderLayer::fingerprint (v, "upstreamHashBBB", "120bpm/Cmaj", 44100, 2, "svc-1") != base);
    }
    SECTION ("changing the seed → different key")
    {
        v.setProperty (ids::seed, 2, nullptr);
        REQUIRE (RenderLayer::fingerprint (v, "upstreamHashAAA", "120bpm/Cmaj", 44100, 2, "svc-1") != base);
    }
    SECTION ("changing the transform target → different key (Route B)")
    {
        v.getChildWithName (ids::PARAMS).setProperty (ids::target, "violin", nullptr);
        REQUIRE (RenderLayer::fingerprint (v, "upstreamHashAAA", "120bpm/Cmaj", 44100, 2, "svc-1") != base);
    }
    SECTION ("changing the transform strength → different key (Route B)")
    {
        v.getChildWithName (ids::PARAMS).setProperty (ids::strength, 90.0, nullptr);
        REQUIRE (RenderLayer::fingerprint (v, "upstreamHashAAA", "120bpm/Cmaj", 44100, 2, "svc-1") != base);
    }
}

TEST_CASE ("compile_render's transient compiledEnvelope round-trips + does NOT touch the cache key",
           "[stage5][compiler]")
{
    auto v = RenderLayer::create ("rl-1", "clip-42", 0.0, 4.0, "fake");
    const auto base = RenderLayer::fingerprint (v, "up", "120/Cmaj", 44100, 2, "svc-1");

    // The compiler result lands as a JSON-string blob on the node — non-undoable, like
    // lyricProposals — so the UI can show what it chose / surface an honest refusal.
    const juce::String blob =
        R"({"ok":true,"backend":"fake","mode":"reimagine","reasoning":"lo-fi -> grit",)"
        R"("envelope":{"mode":"reimagine","prompt":"lo-fi, gritty","nl":0.42,)"
        R"("colors":[{"name":"grit","value":72}],"lab":false,"seed":7},"say":null})";
    v.setProperty (ids::compiledEnvelope, blob, nullptr);

    auto back = RenderLayer::roundTripViaXml (v);
    REQUIRE (back.hasProperty (ids::compiledEnvelope));
    auto parsed = juce::JSON::parse (back[ids::compiledEnvelope].toString());
    REQUIRE (parsed.getProperty ("mode", "").toString() == "reimagine");
    REQUIRE (parsed.getProperty ("envelope", juce::var())
                   .getProperty ("prompt", "").toString() == "lo-fi, gritty");

    // R2: the transient blob is NOT a cache input — the compiled params flow through
    // PARAMS (already keyed), so stamping the blob must leave the fingerprint unchanged.
    REQUIRE (RenderLayer::fingerprint (v, "up", "120/Cmaj", 44100, 2, "svc-1") == base);
}
