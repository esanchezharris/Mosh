#include <catch2/catch_test_macros.hpp>
#include "RenderLayer.h"

using namespace mosh;

static FingerprintInputs sampleFp (juce::int64 seed = 1)
{
    FingerprintInputs fp;
    fp.upstreamHash = "u1";
    fp.modelAdapter = "fake";
    fp.prompt = "p";
    fp.seed = seed;
    return fp;
}

TEST_CASE ("RenderLayer creates a MOSH_RENDERLAYER tree with defaults", "[renderlayer]")
{
    auto rl = RenderLayer::create ("3");
    REQUIRE (rl.isValid());
    REQUIRE (rl.getId() == "3");
    REQUIRE (rl.getStatus() == RenderStatus::empty);
    REQUIRE (rl.getMode() == "generate");
    REQUIRE_FALSE (rl.getUserKept());
}

TEST_CASE ("RenderLayer round-trips through ValueTree XML (serializes for free)", "[renderlayer]")
{
    auto rl = RenderLayer::create ("7");
    rl.setMode ("reimagine");
    rl.setStatus (RenderStatus::ready);
    rl.setUserKept (true);
    rl.setFingerprint (sampleFp (5));
    rl.setCacheArtifact ("take:9");

    auto xml = rl.getState().toXmlString();
    auto restored = juce::ValueTree::fromXml (xml);
    REQUIRE (restored.isValid());

    RenderLayer rl2 (restored);
    REQUIRE (rl2.getId() == "7");
    REQUIRE (rl2.getMode() == "reimagine");
    REQUIRE (rl2.getStatus() == RenderStatus::ready);
    REQUIRE (rl2.getUserKept());
    REQUIRE (rl2.getCacheArtifact() == "take:9");
    REQUIRE (rl2.getCacheKey() == sampleFp (5).cacheKey());
}

TEST_CASE ("RenderLayer dirty logic keys off the full fingerprint", "[renderlayer]")
{
    auto rl = RenderLayer::create ("1");
    rl.setFingerprint (sampleFp (1));
    rl.setStatus (RenderStatus::ready);

    // Same inputs → clean (cache reusable).
    REQUIRE_FALSE (rl.isDirtyAgainst (sampleFp (1)));
    REQUIRE_FALSE (rl.markDirtyIfChanged (sampleFp (1)));
    REQUIRE (rl.getStatus() == RenderStatus::ready);

    // Any fingerprint input changes → dirty (must re-render).
    REQUIRE (rl.isDirtyAgainst (sampleFp (2)));
    REQUIRE (rl.markDirtyIfChanged (sampleFp (2)));
    REQUIRE (rl.getStatus() == RenderStatus::dirty);
}

TEST_CASE ("RenderLayer enforces the ≤3 ordered color cap (01 §4.4)", "[renderlayer]")
{
    auto rl = RenderLayer::create ("c");
    auto accepted = rl.setColors ({ "grit", "air", "tape", "wow", "flutter" });

    REQUIRE (accepted.size() == maxColors);            // capped at 3
    REQUIRE (accepted[0] == "grit");                   // order preserved
    REQUIRE (accepted[2] == "tape");
    REQUIRE (rl.getColors().size() == 3);
    REQUIRE (rl.getColors()[1] == "air");

    // Re-setting replaces (no accumulation) and re-caps.
    auto again = rl.setColors ({ "x", "y" });
    REQUIRE (again.size() == 2);
    REQUIRE (rl.getColors().size() == 2);
}

TEST_CASE ("RenderLayer stores per-color values + the Lab flag (05 §6)", "[renderlayer]")
{
    auto rl = RenderLayer::create ("c");

    // Names-only overload defaults each value to 100 (explicitly added = full-on).
    rl.setColors ({ "grit", "air" });
    REQUIRE (rl.getColorValues().size() == 2);
    REQUIRE (rl.getColorValues()[0] == 100);

    // Values overload stores them parallel to the names.
    rl.setColors ({ "grit", "air", "epic" }, { 80, 30, 65 });
    REQUIRE (rl.getColors().size() == 3);
    REQUIRE (rl.getColorValues()[0] == 80);
    REQUIRE (rl.getColorValues()[1] == 30);
    REQUIRE (rl.getColorValues()[2] == 65);

    // Lab flag defaults false, round-trips.
    REQUIRE_FALSE (rl.getLab());
    rl.setLab (true);
    REQUIRE (rl.getLab());
}
