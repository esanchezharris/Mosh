#include <catch2/catch_test_macros.hpp>
#include <juce_core/juce_core.h>
#include "moshops/LoraTakeRequest.h"

// A LoRA Lab take "over <clip>" used to stage the clip and then render text-to-audio:
// the SA3 adapter re-imagines only when a source arrives WITH an nl, and
// render_lora_take never sent one. The producer graded adapters "over their own
// beat" while hearing prompt-only renders.

namespace
{
    juce::Array<juce::var> stackOf (const juce::String& name, double value)
    {
        auto* lo = new juce::DynamicObject();
        lo->setProperty ("name", name);
        lo->setProperty ("value", value);
        return { juce::var (lo) };
    }
}

TEST_CASE ("render_lora_take: a take over a source clip asks for a re-imagine with an amount", "[lab][render_lora_take]")
{
    const auto stack = stackOf ("keeper", 100.0);

    auto over = mosh::loratake::params ("ambient pad", 42, 12.0, stack, true, mosh::loratake::kDefaultSourceNl);
    CHECK (over.getProperty ("mode", juce::var()).toString() == "reimagine");
    REQUIRE (over.hasProperty ("nl"));
    CHECK ((double) over.getProperty ("nl", 0.0) == 0.4);
    CHECK (over.getProperty ("loras", juce::var()).size() == 1);
    CHECK (over.getProperty ("colors", juce::var()).size() == 0);

    // Without a source it is a text-to-audio take, and says so: no amount at all.
    auto plain = mosh::loratake::params ("ambient pad", 42, 12.0, stack, false, mosh::loratake::kDefaultSourceNl);
    CHECK (plain.getProperty ("mode", juce::var()).toString() == "generate");
    CHECK_FALSE (plain.hasProperty ("nl"));
}

TEST_CASE ("render_lora_take: the cached take's identity includes the amount, but only over a source", "[lab][render_lora_take]")
{
    const auto stack = stackOf ("keeper", 100.0);
    auto* shas = new juce::DynamicObject();
    shas->setProperty ("keeper", "24d37d75601a");
    const juce::var shaByName (shas);

    using mosh::loratake::cacheKey;
    // A take rendered over the clip before this fix (text-to-audio) must not be served
    // as the re-imagine: the amount is in the key, so the old key no longer matches.
    CHECK (cacheKey ("p", 42, 12.0, "clip-1", 0.4, stack, shaByName)
           != cacheKey ("p", 42, 12.0, "clip-1", 0.3, stack, shaByName));
    CHECK (cacheKey ("p", 42, 12.0, "clip-1", 0.4, stack, shaByName)
           == cacheKey ("p", 42, 12.0, "clip-1", 0.4, stack, shaByName));
    // No source: the amount means nothing and does not split the cache.
    CHECK (cacheKey ("p", 42, 12.0, "", 0.4, stack, shaByName)
           == cacheKey ("p", 42, 12.0, "", 0.3, stack, shaByName));
    // A retrained adapter of the same name is a different take.
    auto* other = new juce::DynamicObject();
    other->setProperty ("keeper", "000000000000");
    CHECK (cacheKey ("p", 42, 12.0, "", 0.4, stack, shaByName)
           != cacheKey ("p", 42, 12.0, "", 0.4, stack, juce::var (other)));
}
