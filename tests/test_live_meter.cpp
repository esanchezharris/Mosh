// The hand-off of a plugin's live meter readings from the audio thread to the 30 Hz
// "plugin_meters" rail (plugins/moshfx/LiveMeter.h): maxima accumulate between takes,
// a reading is shown only while it is current, and nothing is lost or counted twice.

#include <catch2/catch_test_macros.hpp>
#include "plugins/moshfx/LiveMeter.h"

#include <atomic>
#include <cmath>
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

TEST_CASE ("live meter: an infinite input stays finite on the rail", "[live-meter]")
{
    // Tracktion's PluginNode zeroes NaN but passes +inf from an upstream plugin or a
    // float file. JUCE writes a non-finite double as JSON null, which the UI's number
    // types do not expect, so the latch must never hand one out.
    using Latch = LiveMeterLatch<1, 2>;
    Latch latch;
    latch.accumulateMax (0, std::numeric_limits<float>::infinity());
    latch.setLatest (0, std::numeric_limits<float>::infinity());
    latch.setLatest (1, std::numeric_limits<float>::quiet_NaN());
    latch.publish();
    const auto reading = latch.take();
    CHECK (reading.live);
    CHECK (std::isfinite (reading.maxima[0]));
    CHECK (reading.maxima[0] == Latch::kCeiling);   // as loud as can be, but a number
    CHECK (reading.latest[0] == 0.0f);
    CHECK (reading.latest[1] == 0.0f);

    // A finite value above the ceiling is clamped too; a normal one is untouched.
    latch.accumulateMax (0, 3.0e38f);
    latch.publish();
    CHECK (latch.take().maxima[0] == Latch::kCeiling);
    latch.accumulateMax (0, 0.25f);
    latch.publish();
    CHECK (latch.take().maxima[0] == 0.25f);
}

TEST_CASE ("live meter: a take never mixes the latest slots of two blocks", "[live-meter]")
{
    // The writer has published block B and is part-way through writing block C when the
    // reader takes. Without the seqlock the reader would see C's slot 0 next to B's
    // slots 1-2: a frame no block ever produced.
    LiveMeterLatch<0, 3> latch;
    for (std::size_t i = 0; i < 3; ++i) latch.setLatest (i, 1.0f);
    latch.publish();                                     // block A
    auto a = latch.take();
    CHECK (a.live);
    CHECK ((a.latest[0] == 1.0f && a.latest[1] == 1.0f && a.latest[2] == 1.0f));

    for (std::size_t i = 0; i < 3; ++i) latch.setLatest (i, 2.0f);
    latch.publish();                                     // block B
    latch.setLatest (0, 3.0f);                           // block C, half written
    const auto mid = latch.take();
    CHECK (mid.live);                                    // B was published since the last take
    // Every slot from ONE block: B's slots are being overwritten, so the last whole
    // frame the reader holds (A) is returned rather than a stitched one.
    CHECK (mid.latest[0] == mid.latest[1]);
    CHECK (mid.latest[1] == mid.latest[2]);
    CHECK (mid.latest[0] != 3.0f);

    latch.setLatest (1, 3.0f);
    latch.setLatest (2, 3.0f);
    latch.publish();                                     // block C complete
    const auto c = latch.take();
    CHECK (c.live);
    CHECK ((c.latest[0] == 3.0f && c.latest[1] == 3.0f && c.latest[2] == 3.0f));
}

TEST_CASE ("live meter: concurrent takes always see one block's latest frame", "[live-meter]")
{
    // Block b writes the value b into every latest slot. A torn read would show two
    // different values in one frame.
    LiveMeterLatch<1, 8> latch;
    constexpr int blocks = 200000;
    std::atomic<bool> done { false };
    std::thread writer ([&] {
        for (int b = 1; b <= blocks; ++b)
        {
            for (std::size_t i = 0; i < 8; ++i)
                latch.setLatest (i, (float) b);
            latch.accumulateMax (0, (float) b);
            latch.publish();
        }
        done.store (true, std::memory_order_release);
    });

    bool consistent = true;
    int liveTakes = 0;
    while (! done.load (std::memory_order_acquire))
    {
        const auto r = latch.take();
        if (! r.live) continue;
        ++liveTakes;
        for (std::size_t i = 1; i < 8; ++i)
            consistent = consistent && r.latest[i] == r.latest[0];
    }
    writer.join();
    CHECK (consistent);
    CHECK (liveTakes > 0);

    // Quiescent: one more block, and the take is exactly that block's frame.
    for (std::size_t i = 0; i < 8; ++i)
        latch.setLatest (i, (float) (blocks + 1));
    latch.publish();
    const auto last = latch.take();
    CHECK (last.live);
    bool whole = true;
    for (std::size_t i = 0; i < 8; ++i)
        whole = whole && last.latest[i] == (float) (blocks + 1);
    CHECK (whole);
}
