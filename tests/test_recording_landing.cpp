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
    // "continue" is Shift+Space (Live's Continue Playback). While recording the transport is
    // playing, so cmdSetTransport's wantsStop takes it as a stop -- and a stop that skips the
    // finalize lands a Booth pass unstamped (review of PR #730, 2026-09-23).
    for (const auto* action : { "stop", "toggle", "record", "to_start", "continue" })
        REQUIRE (mosh::recording::shouldFinalizeBeforeTransportAction (true, action));

    for (const auto* action : { "play", "to_end", "" })
        REQUIRE_FALSE (mosh::recording::shouldFinalizeBeforeTransportAction (true, action));

    REQUIRE_FALSE (mosh::recording::shouldFinalizeBeforeTransportAction (false, "stop"));
    REQUIRE_FALSE (mosh::recording::shouldFinalizeBeforeTransportAction (false, "continue"));   // a continue-START
}

TEST_CASE ("loop_stop ends whatever is recording", "[recording]")
{
    using mosh::recording::LoopStopRoute;
    using mosh::recording::loopStopRoute;

    // A pass the loop started is finalized as a pass: stamped, a Part, lastId moved.
    REQUIRE (loopStopRoute (true, true, true) == LoopStopRoute::finalizePass);

    // A recording the loop did NOT start (TopBar Record, then the Booth's or the phone's Stop
    // pad) is landed as an ordinary take. It used to go to the pass finalize, which returns at
    // once with no pass in flight, so the transport kept recording under a "Stopped before
    // recording began" receipt (review of PR #730, round 3, 2026-09-23).
    REQUIRE (loopStopRoute (true, false, true) == LoopStopRoute::landTake);

    REQUIRE (loopStopRoute (false, false, true) == LoopStopRoute::stopPlayback);
    REQUIRE (loopStopRoute (false, false, false) == LoopStopRoute::nothing);
}

TEST_CASE ("loop_stop's receipt says what the stop did", "[recording]")
{
    using mosh::recording::loopStopDetail;

    REQUIRE (loopStopDetail (/*wasRecording*/ true, /*stillRecording*/ false, /*landed*/ true) == "Stopped");
    REQUIRE (loopStopDetail (true, false, false) == "Stopped before recording began");   // the count-in
    REQUIRE (loopStopDetail (false, false, false) == "Stopped");                         // playback, or idle

    // Never "Stopped" while the transport is still recording: that is the receipt the old
    // route gave a take it left rolling.
    const auto stuck = loopStopDetail (true, true, false);
    REQUIRE (stuck.startsWith ("Still recording"));
    REQUIRE_FALSE (stuck.startsWith ("Stopped"));
}
