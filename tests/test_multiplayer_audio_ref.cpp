#include <catch2/catch_test_macros.hpp>
#include "multiplayer/AudioRefValidation.h"

using namespace mosh;

namespace
{
juce::var ref (juce::var hash, juce::var ext)
{
    auto* value = new juce::DynamicObject();
    value->setProperty ("hash", hash);
    value->setProperty ("ext", ext);
    return juce::var (value);
}

juce::var refs (std::initializer_list<juce::var> values)
{
    juce::Array<juce::var> array;
    for (const auto& value : values)
        array.add (value);
    return juce::var (array);
}
}

TEST_CASE ("audio refs preserve absent empty and honest wire values", "[multiplayer][audio-ref]")
{
    const auto lower = juce::String::repeatedString ("a", 64);
    const auto upper = juce::String::repeatedString ("F", 64);

    REQUIRE (audioref::validate (juce::var()).ok());
    REQUIRE (audioref::validate (refs ({})).ok());
    REQUIRE (audioref::validate (refs ({ ref (lower, "wav"), ref (upper, "WAV2") })).ok());
}

TEST_CASE ("audio refs reject malformed raw values as one aggregate", "[multiplayer][audio-ref][malformed]")
{
    const auto hash = juce::String::repeatedString ("a", 64);
    const juce::var invalid[] = {
        7, ref (hash, "wav"), refs ({ 7 }), refs ({ ref (7, "wav") }), refs ({ ref (hash, 7) }),
        refs ({ ref ("", "wav") }), refs ({ ref (juce::String::repeatedString ("a", 63), "wav") }),
        refs ({ ref (juce::String::repeatedString ("a", 65), "wav") }),
        refs ({ ref (hash.dropLastCharacters (1) + "z", "wav") }),
        refs ({ ref (hash, "") }), refs ({ ref (hash, juce::String::repeatedString ("a", 17)) }),
        refs ({ ref (hash, "/") }), refs ({ ref (hash, "\\") }), refs ({ ref (hash, ".") }),
        refs ({ ref (hash, "..") }), refs ({ ref (hash, "x/../../escape") }),
        refs ({ ref (hash, "wav"), ref (hash, "../bad") })
    };

    for (const auto& value : invalid)
        REQUIRE_FALSE (audioref::validate (value).ok());
}

TEST_CASE ("audio ref destination is a strict direct child", "[multiplayer][audio-ref]")
{
    const auto hash = juce::String::repeatedString ("b", 64);
    const auto root = juce::File::getSpecialLocation (juce::File::tempDirectory)
                          .getChildFile ("mosh-c012-unit").getChildFile ("audio").getChildFile ("by-hash");
    const auto good = audioref::resolveContainedDestination (root, ref (hash, "wav"));
    REQUIRE (good.ok());
    REQUIRE (good.destination == root.getChildFile (hash + ".wav"));
    REQUIRE (good.destination.isAChildOf (root));

    REQUIRE_FALSE (audioref::resolveContainedDestination (root, ref (hash, "x/../../escape")).ok());
}
