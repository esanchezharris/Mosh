#pragma once

#include <algorithm>
#include <cmath>

namespace mosh::moshfx
{
inline constexpr double kPi = 3.14159265358979323846;

inline float clamp01 (float v) { return std::clamp (v, 0.0f, 1.0f); }

inline float dbToGain (float db)
{
    return std::pow (10.0f, db / 20.0f);
}

inline double linToDb (double v)
{
    return 20.0 * std::log10 (std::max (v, 1.0e-8));
}

inline float softLimit (float v)
{
    return std::clamp (v, -0.999f, 0.999f);
}

inline float onePoleCoeff (double cutoff, double sampleRate)
{
    return (float) std::exp (-2.0 * kPi * cutoff / std::max (sampleRate, 1.0));
}
}
