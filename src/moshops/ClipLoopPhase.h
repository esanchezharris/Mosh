#pragma once

#include <cmath>

namespace mosh
{
    // Convert Tracktion's virtual looping offset into the literal source position
    // heard at the clip start. This is the floating-point equivalent of the
    // negative-aware sample modulo used by LoopReader.
    inline double materialiseLoopSourceOffset (double offset, double loopStart, double loopLength) noexcept
    {
        if (! (loopLength > 0.0))
            return offset;

        auto phase = std::fmod (offset, loopLength);
        if (phase < 0.0)
            phase += loopLength;
        return loopStart + phase;
    }
}
