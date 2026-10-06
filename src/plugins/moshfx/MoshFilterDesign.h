#pragma once

// The low/high-pass slope's filter design: a Butterworth cascade of order N = slope / 6
// (6..48 dB/oct, N = 1..8), built from JUCE's own IIRCoefficients makers so that the
// 12 dB/oct case IS Tracktion's filter. Header-only and engine-free (juce_audio_basics
// only) so MoshTests can unit-test it; MoshLowPassPlugin runs it.
//
//   N == 2   exactly IIRCoefficients::makeLowPass/makeHighPass (sampleRate, cutoff), the
//            2-argument makers te::LowPassPlugin calls (tracktion_LowPass.cpp,
//            updateFilters), so 12 dB/oct is bit-identical to Tracktion's filter.
//   N != 2   N/2 biquads from the 3-argument makers at the Butterworth Qs
//            Q_k = -1 / (2 cos (pi (2k + N - 1) / (2N))), k = 1..N/2, then, for odd N,
//            one first-order section (juce_dsp's makeFirstOrderLowPass/HighPass formulas,
//            n = tan (pi fc / fs): LP {n, n | n+1, n-1}, HP {1, -1 | n+1, n-1}), built
//            through the 6-argument constructor, which normalises by a0.
//
// The cascade's magnitude is the Butterworth closed form through the bilinear transform
// the makers use: |H(f)|^2 = 1 / (1 + (tan (pi f / fs) / tan (pi fc / fs))^(2N)) for
// low-pass (the ratio inverted for high-pass), so every slope is -3.0103 dB at the
// cutoff. Coefficients are stored as float, as JUCE stores them (at low cutoffs that
// rounding moves the response by up to a few hundredths of a dB; 12 dB/oct included).

#include <juce_audio_basics/juce_audio_basics.h>

#include <cmath>

namespace mosh::moshfx::filterdesign
{
/** The slope range in dB/oct, its step, and Tracktion's own slope (the default). */
inline constexpr int kMinSlope = 6;
inline constexpr int kMaxSlope = 48;
inline constexpr int kSlopeStep = 6;
inline constexpr int kDefaultSlope = 12;
/** Butterworth order at the steepest slope, and the sections that order needs. */
inline constexpr int kMaxOrder = kMaxSlope / kSlopeStep;
inline constexpr int kMaxSections = (kMaxOrder + 1) / 2;

static_assert (kMaxSlope % kSlopeStep == 0 && kMinSlope == kSlopeStep, "the slope grid is 6, 12, ..., 48 dB/oct");
static_assert (kMaxOrder == 8 && kMaxSections == 4, "the cascade has at most 4 sections");

/** A slope request on the grid: clamped to [6, 48] and snapped to the nearest multiple
    of 6 (a tie rounds up, as JavaScript's Math.round does: 9 -> 12, 27 -> 30), anything
    non-finite -> 12. set_plugin_state applies the same rule, and a saved value off the
    grid plays as the snapped one. */
inline int snapSlope (double dB) noexcept
{
    if (! std::isfinite (dB))
        return kDefaultSlope;
    const double clamped = juce::jlimit ((double) kMinSlope, (double) kMaxSlope, dB);
    const int steps = (int) std::floor ((clamped - kMinSlope) / kSlopeStep + 0.5);
    return juce::jlimit (kMinSlope, kMaxSlope, kMinSlope + kSlopeStep * steps);
}

/** The Butterworth order of a slope (after snapping): 1..8. */
inline int orderOf (double slopeDb) noexcept { return snapSlope (slopeDb) / kSlopeStep; }

/** Sections an order-N cascade uses: N/2 biquads plus one first-order section if N is odd. */
constexpr int numSections (int order) noexcept { return order / 2 + (order & 1); }

/** Q of biquad k (1-based, k <= N/2) of an order-N Butterworth low/high-pass. Order 2 is
    the 2-argument makers' own 1/sqrt(2) (the general formula is one ulp away from it). */
inline double butterworthQ (int order, int k) noexcept
{
    if (order == 2)
        return 1.0 / juce::MathConstants<double>::sqrt2;
    return -1.0 / (2.0 * std::cos (juce::MathConstants<double>::pi * (2.0 * k + order - 1.0) / (2.0 * order)));
}

/** juce_dsp's first-order low/high-pass, as audio_basics coefficients (b2 = a2 = 0). */
inline juce::IIRCoefficients firstOrder (bool lowPass, double sampleRate, double cutoff) noexcept
{
    const double n = std::tan (juce::MathConstants<double>::pi * cutoff / sampleRate);
    return lowPass ? juce::IIRCoefficients (n, n, 0.0, n + 1.0, n - 1.0, 0.0)
                   : juce::IIRCoefficients (1.0, -1.0, 0.0, n + 1.0, n - 1.0, 0.0);
}

/** Writes the order-`order` cascade's sections into `out` (room for kMaxSections) and
    returns how many it wrote. `cutoff` is the plugin's float frequency promoted to
    double and `sampleRate` is Plugin::sampleRate, exactly as te::LowPassPlugin passes
    them, so order 2 produces Tracktion's coefficients bit for bit. */
inline int design (bool lowPass, int order, double sampleRate, double cutoff, juce::IIRCoefficients* out) noexcept
{
    order = juce::jlimit (1, kMaxOrder, order);
    if (order == 2)
    {
        out[0] = lowPass ? juce::IIRCoefficients::makeLowPass (sampleRate, cutoff)
                         : juce::IIRCoefficients::makeHighPass (sampleRate, cutoff);
        return 1;
    }
    int written = 0;
    for (int k = 1; k <= order / 2; ++k)
        out[written++] = lowPass ? juce::IIRCoefficients::makeLowPass (sampleRate, cutoff, butterworthQ (order, k))
                                 : juce::IIRCoefficients::makeHighPass (sampleRate, cutoff, butterworthQ (order, k));
    if ((order & 1) != 0)
        out[written++] = firstOrder (lowPass, sampleRate, cutoff);
    return written;
}

/** The cascade's exact magnitude in dB (the Butterworth closed form through the bilinear
    transform), the reference the tests and the UI's curve follow. */
inline double closedFormDb (bool lowPass, int order, double sampleRate, double cutoff, double hz) noexcept
{
    const double t = std::tan (juce::MathConstants<double>::pi * hz / sampleRate);
    const double tc = std::tan (juce::MathConstants<double>::pi * cutoff / sampleRate);
    const double r = lowPass ? t / tc : tc / t;
    return -10.0 * std::log10 (1.0 + std::pow (r, 2.0 * order));
}
}
