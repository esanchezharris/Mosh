#pragma once

#include <algorithm>
#include <cmath>

namespace mosh
{
    // Pure render-boundary predicate. Unknown source lengths stay on the renderer's
    // existing readable/missing-file path; this guard owns only known-empty source
    // windows. Looping offsets are virtual phases and therefore never compared raw
    // with EOF.
    inline bool hasRenderableAudioSourceWindow (double sourceLengthSeconds,
                                                 double sourceStartSeconds,
                                                 double playedSourceSpanSeconds,
                                                 bool looping) noexcept
    {
        if (looping)
            return true;

        // A non-positive source length is not enough information to diagnose a
        // source-window error. Missing/unreadable media remains on the renderer's
        // existing error path rather than being mislabeled as an EOF trim.
        if (! (sourceLengthSeconds > 0.0))
            return true;

        if (! std::isfinite (sourceLengthSeconds)
            || ! std::isfinite (sourceStartSeconds)
            || ! std::isfinite (playedSourceSpanSeconds)
            || ! (playedSourceSpanSeconds > 0.0))
            return false;

        const double overlapStart = std::max (0.0, sourceStartSeconds);
        const double overlapEnd = std::min (sourceLengthSeconds,
                                            sourceStartSeconds + playedSourceSpanSeconds);
        return overlapEnd - overlapStart > 1.0e-9;
    }
}
