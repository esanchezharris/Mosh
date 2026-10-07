// The hand-off of the tuner's pitch reading from the audio thread to the display
// (plugins/moshfx/retune/LivePitch.h): a reading is shown only while it is current.

#include <catch2/catch_test_macros.hpp>
#include "plugins/moshfx/retune/LivePitch.h"

using namespace mosh::moshfx::retune;

TEST_CASE ("live pitch: nothing is live until the audio thread has run", "[live-pitch]")
{
    LivePitchLatch latch;
    const auto reading = latch.take();
    CHECK_FALSE (reading.live);
    CHECK_FALSE (reading.voiced);
    CHECK (reading.inputHz == 0.0);
}

TEST_CASE ("live pitch: a published reading is taken once, then goes stale", "[live-pitch]")
{
    LivePitchLatch latch;
    latch.publish (224.5, 220.0, 0.9f);

    const auto first = latch.take();
    CHECK (first.live);
    CHECK (first.voiced);
    CHECK (first.inputHz == 224.5);
    CHECK (first.targetHz == 220.0);
    CHECK (first.confidence == 0.9f);

    // No block since: a bypassed plugin keeps its last numbers, and they must not be
    // handed out again as if someone were still singing.
    const auto second = latch.take();
    CHECK_FALSE (second.live);
    CHECK_FALSE (second.voiced);
    CHECK (second.inputHz == 0.0);
    CHECK (second.targetHz == 0.0);
}

TEST_CASE ("live pitch: the newest block wins when several pass between takes", "[live-pitch]")
{
    LivePitchLatch latch;
    latch.publish (224.5, 220.0, 0.9f);
    latch.publish (246.0, 246.94, 0.8f);
    const auto reading = latch.take();
    CHECK (reading.live);
    CHECK (reading.inputHz == 246.0);
    CHECK (reading.targetHz == 246.94);
}

TEST_CASE ("live pitch: running but hearing no pitch is live and unvoiced", "[live-pitch]")
{
    LivePitchLatch latch;
    latch.publish (224.5, 220.0, 0.9f);
    (void) latch.take();
    latch.publish (0.0, 0.0, 0.1f);   // a breath, a consonant, silence
    const auto reading = latch.take();
    CHECK (reading.live);
    CHECK_FALSE (reading.voiced);

    // A detected pitch with no target yet is not a reading either.
    latch.publish (224.5, 0.0, 0.5f);
    CHECK_FALSE (latch.take().voiced);
}
