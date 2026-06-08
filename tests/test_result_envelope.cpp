#include <catch2/catch_test_macros.hpp>
#include "MoshResult.h"

using namespace mosh;

TEST_CASE ("MoshResult success envelope has the exact 02 §2 shape", "[result]")
{
    juce::StringArray changed;
    changed.add ("track:vocal");
    changed.add ("clip:hook_a");

    auto* d = new juce::DynamicObject();
    d->setProperty ("id", "track:vocal");

    auto r = MoshResult::success ("created", changed, juce::var (d));
    auto v = r.toVar();

    REQUIRE (v.isObject());
    REQUIRE ((bool) v["ok"] == true);
    REQUIRE (v["message"].toString() == "created");

    auto ce = v["changed_entities"];
    REQUIRE (ce.isArray());
    REQUIRE (ce.size() == 2);
    REQUIRE (ce[0].toString() == "track:vocal");

    // error_code must be JSON null on success (the UI keys off `=== null`).
    REQUIRE (v["error_code"].isVoid());
    REQUIRE (v["data"]["id"].toString() == "track:vocal");
}

TEST_CASE ("MoshResult failure carries a stable error_code and no partial data", "[result]")
{
    auto r = MoshResult::failure (error::noSuchTrack, "no track 'ghost'");
    auto v = r.toVar();

    REQUIRE ((bool) v["ok"] == false);
    REQUIRE (v["error_code"].toString() == "NO_SUCH_TRACK");
    REQUIRE (v["message"].toString() == "no track 'ghost'");
    // data is always present as an object even on failure (UI never has to null-check).
    REQUIRE (v["data"].isObject());
}

TEST_CASE ("MoshResult round-trips through JSON unchanged", "[result]")
{
    juce::StringArray changed; changed.add ("track:1");
    auto r = MoshResult::success ("ok", changed);
    auto parsed = juce::JSON::parse (r.toJson());

    REQUIRE ((bool) parsed["ok"] == true);
    REQUIRE (parsed["changed_entities"][0].toString() == "track:1");
    REQUIRE (parsed["error_code"].isVoid());
}
