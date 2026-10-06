// The low/high-pass slope's filter design (src/plugins/moshfx/MoshFilterDesign.h): the
// Butterworth cascade MoshLowPassPlugin runs. Engine-free; the plugin itself (its
// bit-identity to te::LowPassPlugin at 12 dB/oct, the measured attenuation per slope,
// the crossfade) is proven by --selftest (src/app/selftest/PluginPanelsSelfTest.cpp).
#include <catch2/catch_test_macros.hpp>

#include "plugins/moshfx/MoshFilterDesign.h"

#include <cmath>
#include <complex>
#include <cstring>
#include <limits>

namespace
{
namespace fd = mosh::moshfx::filterdesign;

// |H(e^jw)| in dB of one stored (float) section, evaluated in double.
double sectionDb (const juce::IIRCoefficients& c, double hz, double sampleRate)
{
    const double w = juce::MathConstants<double>::twoPi * hz / sampleRate;
    const std::complex<double> z1 (std::cos (w), -std::sin (w)), z2 = z1 * z1;
    const auto num = (double) c.coefficients[0] + (double) c.coefficients[1] * z1 + (double) c.coefficients[2] * z2;
    const auto den = 1.0 + (double) c.coefficients[3] * z1 + (double) c.coefficients[4] * z2;
    return 20.0 * std::log10 (std::abs (num / den));
}

double cascadeDb (bool lowPass, int order, double sampleRate, double cutoff, double hz)
{
    juce::IIRCoefficients sections[fd::kMaxSections];
    const int count = fd::design (lowPass, order, sampleRate, cutoff, sections);
    double total = 0.0;
    for (int s = 0; s < count; ++s)
        total += sectionDb (sections[s], hz, sampleRate);
    return total;
}

bool sameBits (const juce::IIRCoefficients& a, const juce::IIRCoefficients& b)
{
    return std::memcmp (a.coefficients, b.coefficients, sizeof (a.coefficients)) == 0;
}

// The largest |cascade - closed form| over a grid of cutoffs, both modes, every order,
// at points around the cutoff that stay below 0.45 fs and above -60 dB.
double worstDeviationDb (std::initializer_list<double> cutoffs)
{
    double worst = 0.0;
    for (double rate : { 44100.0, 48000.0, 96000.0 })
        for (double fc : cutoffs)
            for (bool lowPass : { true, false })
                for (int order = 1; order <= fd::kMaxOrder; ++order)
                    for (double m : { 0.25, 0.5, 0.8, 1.0, 1.25, 2.0, 4.0 })
                    {
                        const double hz = fc * m;
                        if (hz >= 0.45 * rate)
                            continue;
                        const double expected = fd::closedFormDb (lowPass, order, rate, fc, hz);
                        if (expected < -60.0)
                            continue;
                        worst = std::max (worst, std::abs (cascadeDb (lowPass, order, rate, fc, hz) - expected));
                    }
    return worst;
}
}

TEST_CASE ("filter design: 12 dB/oct is exactly the 2-argument JUCE makers Tracktion calls", "[lowpass-design]")
{
    juce::Random random (20261005);
    int compared = 0;
    for (double rate : { 22050.0, 44100.0, 48000.0, 88200.0, 96000.0, 192000.0 })
        for (int i = 0; i < 200; ++i)
        {
            // The plugin's cutoff is a float parameter (10..22000 Hz) promoted to double.
            const float fc = 10.0f + random.nextFloat() * (float) juce::jmin (21990.0, 0.49 * rate - 10.0);
            juce::IIRCoefficients lp[fd::kMaxSections], hp[fd::kMaxSections];
            REQUIRE (fd::design (true, 2, rate, fc, lp) == 1);
            REQUIRE (fd::design (false, 2, rate, fc, hp) == 1);
            CHECK (sameBits (lp[0], juce::IIRCoefficients::makeLowPass (rate, fc)));
            CHECK (sameBits (hp[0], juce::IIRCoefficients::makeHighPass (rate, fc)));
            ++compared;
        }
    CHECK (compared == 1200);
}

TEST_CASE ("filter design: Butterworth Qs", "[lowpass-design]")
{
    CHECK (fd::butterworthQ (2, 1) == 1.0 / juce::MathConstants<double>::sqrt2);
    // The general formula at N = 2 lands within an ulp of the makers' constant.
    const double formula = -1.0 / (2.0 * std::cos (juce::MathConstants<double>::pi * 3.0 / 4.0));
    CHECK (std::abs (formula - fd::butterworthQ (2, 1)) <= 2.0 * std::numeric_limits<double>::epsilon());

    const struct { int order; double qs[4]; } table[] = {
        { 3, { 1.0 } },
        { 4, { 1.306563, 0.541196 } },
        { 5, { 1.618034, 0.618034 } },
        { 6, { 1.931852, 0.707107, 0.517638 } },
        { 7, { 2.246980, 0.801938, 0.554958 } },
        { 8, { 2.562915, 0.899976, 0.601345, 0.509796 } },
    };
    for (const auto& row : table)
        for (int k = 1; k <= row.order / 2; ++k)
        {
            INFO ("order " << row.order << ", biquad " << k);
            CHECK (std::abs (fd::butterworthQ (row.order, k) - row.qs[k - 1]) < 1.0e-6);
        }
}

TEST_CASE ("filter design: section counts", "[lowpass-design]")
{
    const int expected[] = { 0, 1, 1, 2, 2, 3, 3, 4, 4 };
    for (int order = 1; order <= fd::kMaxOrder; ++order)
    {
        juce::IIRCoefficients sections[fd::kMaxSections];
        CHECK (fd::numSections (order) == expected[order]);
        CHECK (fd::design (true, order, 48000.0, 1000.0, sections) == expected[order]);
        CHECK (fd::design (false, order, 48000.0, 1000.0, sections) == expected[order]);
    }
    CHECK (fd::numSections (fd::kMaxOrder) == fd::kMaxSections);
}

TEST_CASE ("filter design: the cascade is the Butterworth closed form", "[lowpass-design]")
{
    // Above ~0.5 kHz the stored float coefficients follow the closed form to 1e-3 dB.
    CHECK (worstDeviationDb ({ 700.0, 1000.0, 2000.0, 4000.0, 8000.0, 15000.0 }) < 1.0e-3);
    // Low cutoffs: float coefficients (as JUCE stores them, 12 dB/oct included) move the
    // response by a few hundredths of a dB around the cutoff.
    CHECK (worstDeviationDb ({ 50.0, 100.0, 180.0, 440.0 }) < 0.1);

    // -3.0103 dB at the cutoff for every slope.
    for (double rate : { 44100.0, 48000.0, 96000.0 })
        for (double fc : { 50.0, 180.0, 1000.0, 4000.0, 15000.0 })
            for (bool lowPass : { true, false })
                for (int order = 1; order <= fd::kMaxOrder; ++order)
                {
                    INFO ((lowPass ? "LP " : "HP ") << fc << " Hz at " << rate << ", order " << order);
                    CHECK (std::abs (cascadeDb (lowPass, order, rate, fc, fc) + 3.0103) < 1.0e-3);
                }

    // The steady-state numbers the selftest measures: LP 1 kHz at 48 kHz, a 2 kHz sine.
    const double atTwiceFc[] = { -7.020, -12.375, -18.240, -24.248, -30.294, -36.349, -42.406, -48.464 };
    for (int order = 1; order <= fd::kMaxOrder; ++order)
    {
        INFO ("order " << order);
        CHECK (std::abs (fd::closedFormDb (true, order, 48000.0, 1000.0, 2000.0) - atTwiceFc[order - 1]) < 1.0e-3);
        CHECK (std::abs (cascadeDb (true, order, 48000.0, 1000.0, 2000.0) - atTwiceFc[order - 1]) < 1.0e-3);
    }
}

TEST_CASE ("filter design: slope snapping", "[lowpass-design]")
{
    CHECK (fd::snapSlope (12) == 12);
    CHECK (fd::snapSlope (6) == 6);
    CHECK (fd::snapSlope (48) == 48);
    CHECK (fd::snapSlope (25) == 24);
    CHECK (fd::snapSlope (27) == 30);    // a tie rounds up
    CHECK (fd::snapSlope (9) == 12);
    CHECK (fd::snapSlope (21) == 24);
    CHECK (fd::snapSlope (45) == 48);
    CHECK (fd::snapSlope (44.9) == 42);
    CHECK (fd::snapSlope (0) == 6);
    CHECK (fd::snapSlope (-100) == 6);
    CHECK (fd::snapSlope (100) == 48);
    CHECK (fd::snapSlope (1.0e300) == 48);
    CHECK (fd::snapSlope (std::numeric_limits<double>::quiet_NaN()) == 12);
    CHECK (fd::snapSlope (std::numeric_limits<double>::infinity()) == 12);
    CHECK (fd::snapSlope (-std::numeric_limits<double>::infinity()) == 12);
    CHECK (fd::orderOf (6) == 1);
    CHECK (fd::orderOf (12) == 2);
    CHECK (fd::orderOf (48) == 8);
    CHECK (fd::orderOf (1000) == 8);
}
