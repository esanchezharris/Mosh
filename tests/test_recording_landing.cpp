#include <catch2/catch_test_macros.hpp>

#include "moshops/RecordingLanding.h"

TEST_CASE ("recording landing reports new clips", "[recording]")
{
    REQUIRE (mosh::recording::didLandClip (false, {}, {}));
    REQUIRE (mosh::recording::didLandClip (false, {}, "new take"));
}

TEST_CASE ("recording landing reports changed capture state", "[recording]")
{
    REQUIRE (mosh::recording::didLandClip (true, "<SEQUENCE/>", "<SEQUENCE><NOTE/></SEQUENCE>"));
    REQUIRE (mosh::recording::didLandClip (true, "<SEQUENCE/>", "<SEQUENCE><CONTROL/></SEQUENCE>"));
    REQUIRE (mosh::recording::didLandClip (true, "wave:0", "wave:1|Take 1"));
}

TEST_CASE ("recording landing ignores unrelated existing clip changes", "[recording]")
{
    REQUIRE_FALSE (mosh::recording::didLandClip (true, {}, {}));
    REQUIRE_FALSE (mosh::recording::didLandClip (true, "<SEQUENCE><NOTE/></SEQUENCE>",
                                                       "<SEQUENCE><NOTE/></SEQUENCE>"));
}

TEST_CASE ("recording landing reports complete and partial multi-track capture", "[recording]")
{
    REQUIRE (mosh::recording::captureApplied (2, 2, false));
    REQUIRE_FALSE (mosh::recording::captureApplied (2, 1, false));
    REQUIRE_FALSE (mosh::recording::captureApplied (1, 0, false));
    REQUIRE (mosh::recording::captureApplied (2, 0, true));
}

TEST_CASE ("recording-ending transport actions finalize the take first", "[recording]")
{
    for (const auto* action : { "stop", "toggle", "record", "to_start" })
        REQUIRE (mosh::recording::shouldFinalizeBeforeTransportAction (true, action));

    for (const auto* action : { "play", "to_end", "" })
        REQUIRE_FALSE (mosh::recording::shouldFinalizeBeforeTransportAction (true, action));

    REQUIRE_FALSE (mosh::recording::shouldFinalizeBeforeTransportAction (false, "stop"));
}
