// The hand-off of a plugin's live meter readings from the audio thread to the 30 Hz
// "plugin_meters" rail (plugins/moshfx/LiveMeter.h): maxima accumulate between takes,
// a reading is shown only while it is current, and nothing is lost or counted twice.

#include <catch2/catch_test_macros.hpp>
#include "plugins/moshfx/LiveMeter.h"

#include <atomic>
#include <limits>
#include <thread>

using mosh::moshfx::LiveMeterLatch;

TEST_CASE ("live meter: nothing is live until a block is published", "[live-meter]")
{
    LiveMeterLatch<2, 1> latch;
    auto reading = latch.take();
    CHECK_FALSE (reading.live);
    CHECK (reading.maxima[0] == 0.0f);

    // Accumulated but not yet published: still not a reading.
    latch.accumulateMax (0, 0.5f);
    reading = latch.take();
    CHECK_FALSE (reading.live);
    CHECK (reading.maxima[0] == 0.0f);

    // ...and the contribution is not lost: it lands in the next live take.
    latch.publish();
    reading = latch.take();
    CHECK (reading.live);
    CHECK (reading.maxima[0] == 0.5f);
}

TEST_CASE ("live meter: maxima accumulate across blocks between takes", "[live-meter]")
{
    LiveMeterLatch<2, 1> latch;
    // Three blocks pass between two 30 Hz takes; the loud one is in the middle.
    latch.accumulateMax (0, 0.2f); latch.accumulateMax (1, 1.0f); latch.setLatest (0, -3.0f); latch.publish();
    latch.accumulateMax (0, 0.9f); latch.accumulateMax (1, 6.0f); latch.setLatest (0, -9.0f); latch.publish();
    latch.accumulateMax (0, 0.1f); latch.accumulateMax (1, 0.5f); latch.setLatest (0, -1.0f); latch.publish();

    const auto reading = latch.take();
    CHECK (reading.live);
    CHECK (reading.maxima[0] == 0.9f);   // the peak of the loud middle block survives
    CHECK (reading.maxima[1] == 6.0f);
    CHECK (reading.latest[0] == -1.0f);  // "latest" is the last block's, not the largest
}

TEST_CASE ("live meter: a take resets the maxima and a second take is stale", "[live-meter]")
{
    LiveMeterLatch<1, 1> latch;
    latch.accumulateMax (0, 0.8f);
    latch.setLatest (0, 2.0f);
    latch.publish();
    CHECK (latch.take().maxima[0] == 0.8f);

    // No block since: the old numbers must not come back as current.
    const auto stale = latch.take();
    CHECK_FALSE (stale.live);
    CHECK (stale.maxima[0] == 0.0f);
    CHECK (stale.latest[0] == 0.0f);

    // The next block starts from zero, not from the previous take's peak.
    latch.accumulateMax (0, 0.3f);
    latch.publish();
    CHECK (latch.take().maxima[0] == 0.3f);
}

TEST_CASE ("live meter: negative, zero and NaN values never raise a maximum", "[live-meter]")
{
    LiveMeterLatch<1, 0> latch;
    latch.accumulateMax (0, -4.0f);
    latch.accumulateMax (0, 0.0f);
    latch.accumulateMax (0, std::numeric_limits<float>::quiet_NaN());
    latch.accumulateMax (5, 9.0f);   // out of range: ignored, not a crash
    latch.publish();
    const auto reading = latch.take();
    CHECK (reading.live);
    CHECK (reading.maxima[0] == 0.0f);
}

TEST_CASE ("live meter: a concurrent writer and reader lose no peak and invent none", "[live-meter]")
{
    // The writer publishes blocks whose peak is the block number; the reader takes as
    // fast as it can. Every take's maximum must be a real block value, and the largest
    // value seen over all takes (including one after the writer stops) must be the very
    // last block: a peak is never lost.
    LiveMeterLatch<1, 1> latch;
    constexpr int blocks = 200000;
    std::atomic<bool> done { false };
    std::thread writer ([&] {
        for (int b = 1; b <= blocks; ++b)
        {
            latch.accumulateMax (0, (float) b);
            latch.setLatest (0, (float) b);
            latch.publish();
        }
        done.store (true, std::memory_order_release);
    });

    float largest = 0.0f;
    bool allValid = true;
    while (! done.load (std::memory_order_acquire))
    {
        const auto r = latch.take();
        if (! r.live) continue;
        const float v = r.maxima[0];
        // A value is a whole block number in range (0 only if every contribution of
        // this take was already drained by a race with the previous one).
        allValid = allValid && v >= 0.0f && v <= (float) blocks && v == (float) (int) v;
        if (v > largest) largest = v;
    }
    writer.join();
    const auto last = latch.take();
    if (last.live && last.maxima[0] > largest) largest = last.maxima[0];

    CHECK (allValid);
    CHECK (largest == (float) blocks);
}
