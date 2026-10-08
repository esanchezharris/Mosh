#include <catch2/catch_approx.hpp>
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

TEST_CASE ("render_lora_take: a take over a clip reads that clip's own material, no longer than it has", "[lab][render_lora_take]")
{
    using mosh::loratake::sourceRegion;
    // A split recording: the second clip starts 30 s into the file and is 8 s long.
    // The take must read 30..38 s, not the file's first 12 s.
    auto split = sourceRegion (30.0, 8.0, 1.0, 120.0, 12.0);
    CHECK (split.start == 30.0);
    CHECK (split.length == 8.0);
    // A short loop is rendered at its own length, not padded to 12 s of silence.
    auto loop = sourceRegion (0.0, 6.9, 1.0, 6.9, 12.0);
    CHECK (loop.length == Catch::Approx (6.9).margin (1e-9));
    // A long clip is capped at the take's length.
    CHECK (sourceRegion (0.0, 60.0, 1.0, 60.0, 12.0).length == 12.0);
    // Never past the file's end, whatever the clip claims.
    auto pastEnd = sourceRegion (55.0, 20.0, 1.0, 60.0, 12.0);
    CHECK (pastEnd.start == 55.0);
    CHECK (pastEnd.length == 5.0);
    CHECK (sourceRegion (90.0, 8.0, 1.0, 60.0, 12.0).length == 0.0);
    // A clip played at double speed spans twice its length of file.
    CHECK (sourceRegion (0.0, 4.0, 2.0, 60.0, 12.0).length == 8.0);
}

TEST_CASE ("render_lora_take: the cache follows the audio, not the clip id", "[lab][render_lora_take]")
{
    using namespace mosh::loratake;
    const auto stack = stackOf ("keeper", 70.0);
    const juce::var noShas;
    const SourceRegion region { 30.0, 8.0 };
    const auto before = sourceIdentity ("/s/take.wav", 1000, 111, region);
    // Keeping a Re-Imagine, re-recording or undoing changes the file under the same clip.
    CHECK (cacheKey ("p", 7, 8.0, before, 0.4, stack, noShas)
           != cacheKey ("p", 7, 8.0, sourceIdentity ("/s/render.wav", 1000, 111, region), 0.4, stack, noShas));
    CHECK (cacheKey ("p", 7, 8.0, before, 0.4, stack, noShas)
           != cacheKey ("p", 7, 8.0, sourceIdentity ("/s/take.wav", 1000, 222, region), 0.4, stack, noShas));
    // A different region of the same file is a different take.
    CHECK (cacheKey ("p", 7, 8.0, before, 0.4, stack, noShas)
           != cacheKey ("p", 7, 8.0, sourceIdentity ("/s/take.wav", 1000, 111, { 0.0, 8.0 }), 0.4, stack, noShas));
    CHECK (cacheKey ("p", 7, 8.0, before, 0.4, stack, noShas)
           == cacheKey ("p", 7, 8.0, sourceIdentity ("/s/take.wav", 1000, 111, region), 0.4, stack, noShas));
}
