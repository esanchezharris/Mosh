#include <catch2/catch_test_macros.hpp>

#include "moshops/RecordingLanding.h"

TEST_CASE ("recording landing reports new clips", "[recording]")
{
    REQUIRE (mosh::recording::didLandClip (false, false, {}, {}));
    REQUIRE (mosh::recording::didLandClip (false, true, {}, "[]"));
}

TEST_CASE ("recording landing reports changed MIDI notes", "[recording]")
{
    REQUIRE (mosh::recording::didLandClip (true, true, "[]", "[{\"note\":60}]"));
    REQUIRE_FALSE (mosh::recording::didLandClip (true, true, "[]", "[]"));
}

TEST_CASE ("recording landing ignores unrelated existing clip changes", "[recording]")
{
    REQUIRE_FALSE (mosh::recording::didLandClip (true, false, {}, {}));
    REQUIRE_FALSE (mosh::recording::didLandClip (true, true, {}, "[{\"note\":60}]"));
}
