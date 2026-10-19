#include "ReImagineConform.h"

#include <cmath>
#include <vector>

// System headers the SoundTouch sources include, pulled in first so their include
// guards are already satisfied inside the namespace below (Tracktion does the same in
// tracktion_engine_timestretch.cpp).
#include <assert.h>
#include <cfloat>
#include <float.h>
#include <limits.h>
#include <math.h>
#include <memory.h>
#include <stddef.h>
#include <stdexcept>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if defined (__i386__) || defined (__x86_64__) || defined (_M_IX86) || defined (_M_X64)
 #include <mmintrin.h>
 #include <xmmintrin.h>
 #if defined (_MSC_VER)
  #include <intrin.h>
 #endif
#endif

#if defined (__clang__)
 #pragma clang diagnostic push
 #pragma clang diagnostic ignored "-Weverything"
#elif defined (__GNUC__)
 #pragma GCC diagnostic push
 #pragma GCC diagnostic ignored "-Wall"
 #pragma GCC diagnostic ignored "-Wextra"
 #pragma GCC diagnostic ignored "-Wshadow"
 #pragma GCC diagnostic ignored "-Wsign-conversion"
 #pragma GCC diagnostic ignored "-Wconversion"
 #pragma GCC diagnostic ignored "-Wpedantic"
 #pragma GCC diagnostic ignored "-Wfloat-equal"
 #pragma GCC diagnostic ignored "-Wzero-as-null-pointer-constant"
 #pragma GCC diagnostic ignored "-Wunused-parameter"
 #pragma GCC diagnostic ignored "-Wunused-variable"
 #pragma GCC diagnostic ignored "-Wunused-but-set-variable"
 #pragma GCC diagnostic ignored "-Wredundant-decls"
 #pragma GCC diagnostic ignored "-Wswitch-enum"
 #pragma GCC diagnostic ignored "-Wcast-align"
#elif defined (_MSC_VER)
 #pragma warning (push, 0)
#endif

// Own namespace: MoshTests also links Tracktion, which compiles the same sources inside
// tracktion::engine, so the symbols must not collide.
namespace mosh::reimagine::vendored
{
#include "AAFilter.cpp"
#undef PI
#include "cpu_detect_x86.cpp"
#include "FIFOSampleBuffer.cpp"
#include "FIRFilter.cpp"
#include "InterpolateCubic.cpp"
#include "InterpolateLinear.cpp"
#include "InterpolateShannon.cpp"
#include "mmx_optimized.cpp"
#include "RateTransposer.cpp"
#include "SoundTouch.cpp"
#include "sse_optimized.cpp"
#include "TDStretch.cpp"
}
#undef max
#undef min

#if defined (__clang__)
 #pragma clang diagnostic pop
#elif defined (__GNUC__)
 #pragma GCC diagnostic pop
#elif defined (_MSC_VER)
 #pragma warning (pop)
#endif

namespace mosh::reimagine
{
bool stretchForConform (const juce::AudioBuffer<float>& input, double sampleRate, double stretchRatio,
                        juce::AudioBuffer<float>& output, juce::String& error,
                        const std::function<bool()>& shouldAbort)
{
    const auto channels = input.getNumChannels();
    const auto frames = input.getNumSamples();
    if (channels <= 0 || channels > 16 || frames <= 0)
        return (error = "nothing to stretch"), false;
    if (! (sampleRate >= 8000.0) || ! std::isfinite (sampleRate))
        return (error = "invalid sample rate"), false;
    if (! std::isfinite (stretchRatio) || stretchRatio < 0.5 || stretchRatio > 2.0)
        return (error = "invalid stretch ratio"), false;

    vendored::soundtouch::SoundTouch stretcher;
    stretcher.setChannels (static_cast<unsigned int> (channels));
    stretcher.setSampleRate (static_cast<unsigned int> (std::lround (sampleRate)));
    // Tracktion's TimeStretcher::soundtouchBetter settings.
    stretcher.setSetting (SETTING_USE_AA_FILTER, 1);
    stretcher.setSetting (SETTING_AA_FILTER_LENGTH, 64);
    stretcher.setSetting (SETTING_USE_QUICKSEEK, 0);
    stretcher.setSetting (SETTING_SEQUENCE_MS, 60);
    stretcher.setSetting (SETTING_SEEKWINDOW_MS, 25);
    stretcher.setTempo (1.0 / stretchRatio);   // tempo < 1 plays slower, so lasts longer

    const auto target = static_cast<int> (std::llround (static_cast<double> (frames) * stretchRatio));
    output.setSize (channels, target, false, true, false);
    output.clear();

    constexpr int chunk = 4096;
    std::vector<float> interleaved (static_cast<size_t> (chunk * channels));
    int written = 0;
    const auto drain = [&]
    {
        for (;;)
        {
            const auto received = static_cast<int> (stretcher.receiveSamples (interleaved.data(), static_cast<unsigned int> (chunk)));
            if (received <= 0)
                return;
            const auto usable = std::min (received, target - written);
            for (int c = 0; c < channels && usable > 0; ++c)
            {
                auto* destination = output.getWritePointer (c, written);
                for (int i = 0; i < usable; ++i)
                    destination[i] = interleaved[static_cast<size_t> (i * channels + c)];
            }
            written += std::max (0, usable);
        }
    };
    for (int start = 0; start < frames; start += chunk)
    {
        if (shouldAbort && shouldAbort())
            return (error = "cancelled"), false;
        const auto count = std::min (chunk, frames - start);
        for (int i = 0; i < count; ++i)
            for (int c = 0; c < channels; ++c)
                interleaved[static_cast<size_t> (i * channels + c)] = input.getSample (c, start + i);
        stretcher.putSamples (interleaved.data(), static_cast<unsigned int> (count));
        drain();
    }
    stretcher.flush();
    drain();
    if (written < target - static_cast<int> (std::ceil (sampleRate * 0.05)))
        return (error = "the stretcher returned too little audio"), false;
    return true;   // any short tail (< 50 ms) stays silent; the length is exact
}
}
