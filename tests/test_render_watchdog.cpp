// Offline-render watchdog: stalled vs slow. See src/moshops/RenderWatchdog.h.
#include <catch2/catch_test_macros.hpp>

#include "moshops/RenderWatchdog.h"

using mosh::RenderWatchdog;
using Verdict = RenderWatchdog::Verdict;

namespace
{
    // 44.1 kHz / 256-sample blocks: Tracktion pre-rolls (44100 / 2) / 256 + 1 = 87 blocks.
    constexpr int preRollBlocks = 87;
    constexpr int blockSamples = 256;
    const int allowance = RenderWatchdog::preRollCallAllowance (44100.0, blockSamples);
    const std::uint32_t deadline = RenderWatchdog::deadlineMsFor (3.0);
}

TEST_CASE ("pre-roll allowance covers Tracktion's pre-roll twice over", "[render][watchdog]")
{
    CHECK (allowance == 2 * preRollBlocks + 64);
    CHECK (RenderWatchdog::preRollCallAllowance (48000.0, 512) == 2 * 47 + 64);
    // Unknown device values fall back to 44.1 kHz / 512 rather than dividing by zero.
    CHECK (RenderWatchdog::preRollCallAllowance (0.0, 0) == 2 * 44 + 64);
}

TEST_CASE ("deadline floor is ten minutes and scales with the rendered span", "[render][watchdog]")
{
    CHECK (RenderWatchdog::deadlineMsFor (0.0) == 600000u);
    CHECK (RenderWatchdog::deadlineMsFor (-5.0) == 600000u);
    CHECK (RenderWatchdog::deadlineMsFor (3.0) == 624000u);
    CHECK (RenderWatchdog::deadlineMsFor (600.0) == 5400000u);
    CHECK (RenderWatchdog::deadlineMsFor (1.0e9) == 4000000000u);
}

TEST_CASE ("a starved pre-roll longer than the stall window is not a stall", "[render][watchdog]")
{
    // The gate failure: every pre-roll block takes 250 ms of wake-up latency, so the
    // pre-roll alone lasts 21.75 s with nothing written. The old progress-float watchdog
    // called this stalled at 20 s.
    RenderWatchdog w (0, allowance, deadline);
    std::uint32_t now = 0;

    for (int i = 0; i < preRollBlocks; ++i)
    {
        now += 250;
        REQUIRE (w.afterCall (now, 0) == Verdict::running);
    }
    CHECK (now > RenderWatchdog::stallMs);

    // Then the real blocks, just as slow, each writing 256 samples.
    std::int64_t written = 0;
    for (int i = 0; i < 400; ++i)
    {
        now += 250;
        written += blockSamples;
        REQUIRE (w.afterCall (now, written) == Verdict::running);
    }
}

TEST_CASE ("a leaf that never becomes ready still stalls after about 20 s", "[render][watchdog]")
{
    // A not-ready leaf makes runJob() return at once; poll every millisecond.
    RenderWatchdog w (0, allowance, deadline);
    std::uint32_t now = 0;
    Verdict v = Verdict::running;

    while (v == Verdict::running && now < 60000)
        v = w.afterCall (++now, 0);

    CHECK (v == Verdict::stalled);
    // The allowance buys only `allowance` polls (milliseconds here), then the window runs.
    CHECK (now > RenderWatchdog::stallMs);
    CHECK (now <= RenderWatchdog::stallMs + (std::uint32_t) allowance + 1);
}

TEST_CASE ("once audio is written, the pre-roll allowance no longer counts", "[render][watchdog]")
{
    RenderWatchdog w (0, allowance, deadline);
    REQUIRE (w.afterCall (10, 0) == Verdict::running);
    REQUIRE (w.afterCall (20, blockSamples) == Verdict::running);

    // Writing stops mid-render (a later source is unreadable): polls without writes must
    // not reset the window even though most of the allowance is unused.
    CHECK (w.afterCall (20 + RenderWatchdog::stallMs, blockSamples) == Verdict::running);
    CHECK (w.afterCall (21 + RenderWatchdog::stallMs, blockSamples) == Verdict::stalled);
}

TEST_CASE ("a single slow call that then writes is not a stall", "[render][watchdog]")
{
    RenderWatchdog w (0, 0, deadline);
    // One runJob() took 25 s but wrote its block: progress is judged after the call.
    CHECK (w.afterCall (25000, blockSamples) == Verdict::running);
    CHECK (w.afterCall (50000, 2 * blockSamples) == Verdict::running);
}

TEST_CASE ("the deadline bounds a render that keeps writing", "[render][watchdog]")
{
    RenderWatchdog w (0, allowance, 1000);
    CHECK (w.afterCall (500, blockSamples) == Verdict::running);
    CHECK (w.afterCall (1000, 2 * blockSamples) == Verdict::running);
    CHECK (w.afterCall (1001, 3 * blockSamples) == Verdict::timedOut);
}

TEST_CASE ("the millisecond counter may wrap mid-render", "[render][watchdog]")
{
    const std::uint32_t start = 0xFFFFFF00u;
    RenderWatchdog w (start, allowance, deadline);
    CHECK (w.afterCall (start + 0x80u, blockSamples) == Verdict::running);
    CHECK (w.afterCall (start + 0x200u, 2 * blockSamples) == Verdict::running);   // wrapped past zero
    CHECK (w.afterCall (start + 0x200u + RenderWatchdog::stallMs + 1, 2 * blockSamples) == Verdict::stalled);
}
