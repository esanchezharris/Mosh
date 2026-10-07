#pragma once

#include <algorithm>
#include <cstdint>

namespace mosh
{
    // Decides when a synchronous offline render loop (te::Renderer::RenderTask::runJob()
    // called until it finishes) has STALLED, as opposed to running slowly on a starved
    // machine. Pure and engine-free so tests/test_render_watchdog.cpp can drive it with a
    // synthetic clock; the engine glue that feeds it is runBoundedRender (BoundedRender.h).
    //
    // Why not Tracktion's getCurrentTaskProgress(): it reads 0 through the render's
    // pre-roll and 1.0 through the end-allowance tail, so a healthy render can report no
    // progress for as long as the machine takes to get through them. The pre-roll is
    // (sampleRate / 2) / blockSize + 1 blocks and each one sleeps for a block's duration,
    // so it is dominated by wake-up latency: on a starved process each sleep measured
    // ~200 ms, putting a 1-second export's pre-roll at ~18 s (0.44 s idle) against the old
    // fixed 20 s no-progress window, which the native gate crossed at load 30-200.
    //
    // Forward progress is counted instead from two honest signals:
    //   - samples written: every block that reaches the file, tail included, and
    //   - pre-roll calls: before the first block is written, each runJob() call that
    //     returns counts, up to preRollCallAllowance().
    // A leaf node that can never become ready (an unreadable source, a proxy that was
    // never started) makes runJob() return at once without writing anything, so it burns
    // the allowance in milliseconds and then hits the same 20 s stall window as before.
    // Known limit: a render that first polls a source that is still being generated (a
    // warp proxy mid-render) spends the allowance the same way, so if the pre-roll that
    // follows is slower than the window it still reads as stalled. Callers that can,
    // wait for such sources before rendering.
    class RenderWatchdog
    {
    public:
        enum class Verdict { running, stalled, timedOut };

        // No forward progress for this long => the render is stuck.
        static constexpr std::uint32_t stallMs = 20000;

        // runJob() calls that may pass before the first written block: Tracktion's
        // pre-roll, twice over, plus room for plugin-latency compensation, which drops
        // whole blocks without writing them.
        static int preRollCallAllowance (double sampleRate, int blockSize) noexcept
        {
            const double sr = sampleRate > 0.0 ? sampleRate : 44100.0;
            const int bs = blockSize > 0 ? blockSize : 512;
            const int preRollBlocks = (int) ((sr / 2.0) / bs) + 1;
            return 2 * preRollBlocks + 64;
        }

        // Absolute backstop. A render that keeps writing blocks always finishes (its
        // stream position only moves toward a fixed end), so this bounds only failure
        // modes the stall rule cannot see. The old 60 s floor failed healthy 1-second
        // exports under gate load, so the floor is ten minutes; the per-second term keeps
        // long realtime renders (which run at 1x) inside it.
        static std::uint32_t deadlineMsFor (double renderSpanSeconds) noexcept
        {
            const double span = std::max (0.0, renderSpanSeconds);
            return (std::uint32_t) std::min (span * 8000.0 + 600000.0, 4.0e9);
        }

        RenderWatchdog (std::uint32_t startMs, int preRollCalls, std::uint32_t deadlineMs) noexcept
            : start (startMs), lastAdvance (startMs), deadline (deadlineMs),
              preRollCallsLeft (std::max (0, preRollCalls))
        {
        }

        // Call after every runJob() that asked to run again, with the total samples
        // written so far. Millisecond arithmetic is unsigned, so a counter wrap is harmless.
        Verdict afterCall (std::uint32_t nowMs, std::int64_t samplesWritten) noexcept
        {
            bool advanced = false;

            if (samplesWritten > lastWritten)
            {
                lastWritten = samplesWritten;
                advanced = true;
            }
            else if (lastWritten == 0 && preRollCallsLeft > 0)
            {
                --preRollCallsLeft;
                advanced = true;
            }

            if (advanced)
                lastAdvance = nowMs;

            if (nowMs - lastAdvance > stallMs)
                return Verdict::stalled;

            if (nowMs - start > deadline)
                return Verdict::timedOut;

            return Verdict::running;
        }

    private:
        std::uint32_t start, lastAdvance, deadline;
        int preRollCallsLeft;
        std::int64_t lastWritten = 0;
    };
}
