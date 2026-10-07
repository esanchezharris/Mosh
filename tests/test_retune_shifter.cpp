// SpliceShifter behavioural tests: docs/AUTOTUNE-SCOPE-2026-10-01.md section 7.
//
// One test case per required property (1-9), plus a few that pin the pieces the
// properties lean on (period refinement, reset, other sample rates). The pitch,
// timbre and click measurements use a harmonic tone, not a sine: a sine has no formant
// structure to preserve and hides crossfade misalignment.
//
// Run with `-s` to see the measured numbers (each check carries them as INFO).

#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "plugins/moshfx/retune/SpliceShifter.h"

#include <algorithm>
#include <cmath>
#include <complex>
#include <cstdint>
#include <cstring>
#include <limits>
#include <vector>

namespace
{
using mosh::moshfx::retune::SpliceShifter;

constexpr double kPi = 3.14159265358979323846;

double ratioFromCents (double cents) { return std::exp2 (cents / 1200.0); }
double centsBetween (double measured, double expected) { return 1200.0 * std::log2 (measured / expected); }
double toDb (double ratio) { return 20.0 * std::log10 (ratio); }

// 1/n harmonic series, ten harmonics, starting `offset` samples into the waveform. The
// phases are spread (h^2 pi / H) so the waveform is not a plain sawtooth.
std::vector<float> harmonicTone (double f0, double fs, int numSamples, double offset = 0.0, int harmonics = 10,
                                 double gain = 0.2)
{
    std::vector<float> x ((size_t) numSamples);
    std::vector<double> phase ((size_t) harmonics + 1);
    for (int h = 1; h <= harmonics; ++h)
        phase[(size_t) h] = kPi * (double) h * (double) h / (double) harmonics;

    for (int n = 0; n < numSamples; ++n)
    {
        double v = 0.0;
        for (int h = 1; h <= harmonics; ++h)
            v += std::sin (2.0 * kPi * (double) h * f0 * ((double) n + offset) / fs + phase[(size_t) h]) / (double) h;
        x[(size_t) n] = (float) (gain * v);
    }
    return x;
}

std::vector<float> lcgNoise (int numSamples, std::uint32_t seed = 0x12345678u, float gain = 0.3f)
{
    std::vector<float> x ((size_t) numSamples);
    std::uint32_t state = seed;
    for (auto& s : x)
    {
        state = state * 1664525u + 1013904223u;
        s = gain * (float) ((int) ((state >> 8) & 0xffffu) - 32768) / 32768.0f;
    }
    return x;
}

std::vector<float> delayed (const std::vector<float>& x, int delay)
{
    std::vector<float> y (x.size(), 0.0f);
    for (size_t n = (size_t) delay; n < x.size(); ++n)
        y[n] = x[n - (size_t) delay];
    return y;
}

bool bitIdentical (const std::vector<float>& a, const std::vector<float>& b)
{
    return a.size() == b.size() && std::memcmp (a.data(), b.data(), a.size() * sizeof (float)) == 0;
}

bool allFinite (const std::vector<float>& x)
{
    return std::all_of (x.begin(), x.end(), [] (float v) { return std::isfinite (v); });
}

// First index from which `a` and `b` agree bit-for-bit to the end; a.size() if never.
size_t identityFrom (const std::vector<float>& a, const std::vector<float>& b)
{
    size_t from = a.size();
    while (from > 0 && std::memcmp (&a[from - 1], &b[from - 1], sizeof (float)) == 0)
        --from;
    return from;
}

struct Control
{
    int at;          // sample position at which setTarget is called (before that sample)
    double period;   // <= 0 unvoiced
    double ratio;
};

// Feeds `in` through the shifter in blocks of at most `block`, splitting blocks so each
// setTarget lands on its exact sample position whatever the block size.
std::vector<float> render (SpliceShifter& shifter, const std::vector<float>& in,
                           const std::vector<Control>& controls, int block, bool inPlace = false)
{
    const int total = (int) in.size();
    std::vector<float> work (in);
    std::vector<float> out (in.size(), 0.0f);
    size_t next = 0;
    int pos = 0;
    while (pos < total)
    {
        while (next < controls.size() && controls[next].at <= pos)
        {
            shifter.setTarget (controls[next].period, controls[next].ratio);
            ++next;
        }
        int end = std::min (total, pos + block);
        if (next < controls.size())
            end = std::min (end, controls[next].at);
        if (inPlace)
            shifter.process (work.data() + pos, work.data() + pos, end - pos);
        else
            shifter.process (in.data() + pos, out.data() + pos, end - pos);
        pos = end;
    }
    return inPlace ? work : out;
}

// Hann-windowed single-bin DFT: the peak amplitude of a steady sinusoid at `hz`.
std::complex<double> windowedBin (const std::vector<double>& windowed, double hz, double fs)
{
    const std::complex<double> step = std::polar (1.0, -2.0 * kPi * hz / fs);
    std::complex<double> rotor (1.0, 0.0), acc (0.0, 0.0);
    for (size_t k = 0; k < windowed.size(); ++k)
    {
        acc += windowed[k] * rotor;
        rotor *= step;
        if ((k & 1023u) == 1023u)
            rotor /= std::abs (rotor);
    }
    return acc;
}

std::vector<double> hannWindowed (const std::vector<float>& x, size_t start, size_t count, double& windowSum)
{
    std::vector<double> w (count);
    windowSum = 0.0;
    for (size_t k = 0; k < count; ++k)
    {
        const double h = 0.5 * (1.0 - std::cos (2.0 * kPi * ((double) k + 0.5) / (double) count));
        windowSum += h;
        w[k] = h * (double) x[start + k];
    }
    return w;
}

struct Peak
{
    double hz;
    double amplitude;
};

// Peak amplitude of a steady sinusoid at exactly `hz` (Hann-windowed single bin).
double amplitudeAt (const std::vector<float>& x, size_t start, size_t count, double hz, double fs)
{
    double windowSum = 0.0;
    const auto windowed = hannWindowed (x, start, count, windowSum);
    return std::abs (windowedBin (windowed, hz, fs)) * 2.0 / windowSum;
}

// The strongest spectral line within +/- `halfWidthHz` of the guess: a half-bin scan, then
// successive parabolic refinement of the magnitude. Good to a small fraction of a cent over
// a one second segment.
Peak findPeak (const std::vector<float>& x, size_t start, size_t count, double guessHz, double fs, double halfWidthHz)
{
    double windowSum = 0.0;
    const auto windowed = hannWindowed (x, start, count, windowSum);
    auto magnitude = [&] (double hz) { return std::abs (windowedBin (windowed, hz, fs)) * 2.0 / windowSum; };

    const double stepHz = 0.5 * fs / (double) count;  // half a bin
    const int steps = (int) std::ceil (halfWidthHz / stepHz);
    double bestHz = guessHz, bestMag = -1.0;
    for (int i = -steps; i <= steps; ++i)
    {
        const double hz = guessHz + (double) i * stepHz;
        const double m = magnitude (hz);
        if (m > bestMag)
        {
            bestMag = m;
            bestHz = hz;
        }
    }

    double delta = stepHz;
    for (int pass = 0; pass < 8; ++pass)
    {
        const double lo = magnitude (bestHz - delta);
        const double mid = magnitude (bestHz);
        const double hi = magnitude (bestHz + delta);
        const double curvature = lo - 2.0 * mid + hi;
        if (curvature < 0.0)
            bestHz += std::min (std::max (0.5 * (lo - hi) / curvature, -1.0), 1.0) * delta;
        delta *= 0.5;
    }
    return { bestHz, magnitude (bestHz) };
}

// 1 ms RMS envelope, advanced in quarter-window hops so a click cannot hide between
// the sample points.
constexpr size_t kHopsPerWindow = 4;

std::vector<double> rmsEnvelope (const std::vector<float>& x, double fs)
{
    const size_t window = (size_t) std::lround (0.001 * fs);
    const size_t hop = std::max<size_t> (1, window / kHopsPerWindow);
    std::vector<double> cumulative (x.size() + 1, 0.0);
    for (size_t k = 0; k < x.size(); ++k)
        cumulative[k + 1] = cumulative[k] + (double) x[k] * (double) x[k];

    std::vector<double> envelope;
    for (size_t pos = 0; pos + window <= x.size(); pos += hop)
        envelope.push_back (std::sqrt ((cumulative[pos + window] - cumulative[pos]) / (double) window) + 1.0e-9);
    return envelope;
}

struct EnvelopeDeviation
{
    double levelDb = 0.0;  // largest |output - ideal| in the 1 ms RMS level
    double stepDb = 0.0;   // largest |output step - ideal step|, steps taken one window apart
};

// "What the input's envelope does" for a pitch shifter is the input tone replayed at the
// output pitch: the formants move with the pitch, so the natural 1 ms envelope steps of
// the tone scale with it (an ideal shifter turns 6.5 dB at 440 Hz into 8.6 dB at 392 Hz).
// So the reference is the same harmonic series synthesised at the output pitch and
// time-aligned to the output by its fundamental's phase.
EnvelopeDeviation envelopeVersusIdeal (const std::vector<float>& shifted, size_t start, size_t count,
                                       double outputHz, double fs)
{
    const std::vector<float> segment (shifted.begin() + (std::ptrdiff_t) start,
                                      shifted.begin() + (std::ptrdiff_t) (start + count));
    const auto fundamental = [&] (const std::vector<float>& x) {
        double windowSum = 0.0;
        return windowedBin (hannWindowed (x, 0, x.size(), windowSum), outputHz, fs);
    };

    const auto unshifted = harmonicTone (outputHz, fs, (int) count, (double) start);
    const double shiftSamples = (std::arg (fundamental (segment)) - std::arg (fundamental (unshifted)))
                                / (2.0 * kPi * outputHz / fs);
    const auto ideal = harmonicTone (outputHz, fs, (int) count, (double) start + shiftSamples);

    const auto got = rmsEnvelope (segment, fs);
    const auto want = rmsEnvelope (ideal, fs);
    const size_t apart = kHopsPerWindow;  // steps are taken one window apart

    EnvelopeDeviation worst;
    for (size_t m = 0; m < got.size(); ++m)
    {
        worst.levelDb = std::max (worst.levelDb, std::abs (toDb (got[m] / want[m])));
        if (m + apart < got.size())
            worst.stepDb = std::max (worst.stepDb, std::abs (toDb (got[m + apart] / got[m]) - toDb (want[m + apart] / want[m])));
    }
    return worst;
}

// A deliberately naive retuner for the control experiments: the same read-head idea with
// a hard jump (or a plain crossfade) of `stale` x the true period, and no refinement.
std::vector<float> naiveRetune (const std::vector<float>& x, double period, double ratio, double stale,
                                bool equalPowerFade, bool hardJump, int fadeLength)
{
    const int total = (int) x.size();
    std::vector<float> y ((size_t) total, 0.0f);
    auto at = [&] (double pos) {
        if (pos < 0.0)
            return 0.0;
        const int i = (int) pos;
        const double f = pos - (double) i;
        return (1.0 - f) * (double) x[(size_t) i] + f * (double) x[(size_t) std::min (i + 1, total - 1)];
    };

    const double centre = 100.0;
    double d = centre, d2 = 0.0;
    bool fading = false;
    int k = 0;
    for (int n = 0; n < total; ++n)
    {
        if (! fading)
        {
            const bool back = d < centre, forward = d > centre + 1.5 * period;
            if (back || forward)
            {
                d2 = back ? d + period * stale : d - period * stale;
                if (hardJump)
                    d = d2;
                else
                {
                    fading = true;
                    k = 0;
                }
            }
        }
        double v = at ((double) n - d);
        if (fading)
        {
            const double g = 0.5 * (1.0 - std::cos (kPi * (double) k / (double) fadeLength));
            const double b = at ((double) n - d2);
            v = equalPowerFade ? std::sqrt (1.0 - g) * v + std::sqrt (g) * b : (1.0 - g) * v + g * b;
        }
        y[(size_t) n] = (float) v;
        d += 1.0 - ratio;
        if (fading)
        {
            d2 += 1.0 - ratio;
            if (++k >= fadeLength)
            {
                d = d2;
                fading = false;
            }
        }
    }
    return y;
}

struct ShiftedTone
{
    double fs = 48000.0;
    double f0 = 0.0;
    double ratio = 1.0;
    double period = 0.0;
    int latency = 0;
    std::vector<float> in;
    std::vector<float> out;
    size_t settle = 0;  // first sample of the steady segment
    size_t length = 0;  // its length
};

// Harmonic tone at f0 through the shifter, told the true period and `cents`.
ShiftedTone shiftTone (double f0, double cents, double fs = 48000.0, double staleFactor = 1.0, int block = 512)
{
    ShiftedTone t;
    t.fs = fs;
    t.f0 = f0;
    t.ratio = ratioFromCents (cents);
    t.period = fs / f0;

    SpliceShifter shifter;
    shifter.prepare (fs);
    t.latency = shifter.latencySamples();

    const int total = (int) std::lround (1.3 * fs);
    t.in = harmonicTone (f0, fs, total);
    t.out = render (shifter, t.in, { { 0, t.period * staleFactor, t.ratio } }, block);
    t.settle = (size_t) std::lround (0.3 * fs);
    t.length = (size_t) std::lround (1.0 * fs);
    return t;
}

constexpr int kHarmonicsChecked = 8;

struct ToneAnalysis
{
    double measuredHz = 0.0;
    double pitchErrorCents = 0.0;
    double harmonicDeltaDb[kHarmonicsChecked] = {};
    double worstHarmonicDb = 0.0;
};

// Fundamental by peak search, then each of the first eight harmonics at exactly h times it
// (the output is periodic, so its harmonics are exact multiples) against the same harmonic
// of the input at h x f0.
ToneAnalysis analyseTone (const ShiftedTone& t)
{
    ToneAnalysis a;
    const double expectedHz = t.f0 * t.ratio;
    a.measuredHz = findPeak (t.out, t.settle, t.length, expectedHz, t.fs, 0.02 * expectedHz).hz;
    a.pitchErrorCents = centsBetween (a.measuredHz, expectedHz);
    for (int h = 1; h <= kHarmonicsChecked; ++h)
    {
        const double reference = amplitudeAt (t.in, t.settle, t.length, t.f0 * h, t.fs);
        const double shifted = amplitudeAt (t.out, t.settle, t.length, a.measuredHz * h, t.fs);
        a.harmonicDeltaDb[h - 1] = toDb (shifted / reference);
        a.worstHarmonicDb = std::max (a.worstHarmonicDb, std::abs (a.harmonicDeltaDb[h - 1]));
    }
    return a;
}

const double kToneFrequencies[] = { 110.0, 220.0, 440.0 };
const double kToneCents[] = { -200.0, -100.0, -35.0, 35.0, 100.0, 200.0 };
}  // namespace

// ---------------------------------------------------------------------------------------
// 1. Identity.
// ---------------------------------------------------------------------------------------
TEST_CASE ("SpliceShifter: unvoiced output is the input delayed by the reported latency", "[retune][shifter]")
{
    for (double fs : { 44100.0, 48000.0, 96000.0 })
    {
        SpliceShifter shifter;
        shifter.prepare (fs);
        const int latency = shifter.latencySamples();

        // The reported latency follows the spec formula, independent of the header's code.
        const int expected = 8 + 1 + (int) std::ceil (0.006 * fs * (std::exp2 (4.0 / 12.0) - 1.0)) + 4;
        INFO ("fs " << fs << " latency " << latency);
        REQUIRE (latency == expected);

        const int total = (int) fs;  // one second
        for (const auto& input : { lcgNoise (total), harmonicTone (180.0, fs, total) })
        {
            // Unvoiced is "no period", and also any period outside [fs/1200, fs/55], with a
            // ratio that must then be ignored.
            const std::vector<Control> controls[] = {
                { { 0, 0.0, 1.0 } },
                { { 0, -5.0, 2.0 } },
                { { 0, fs / 20.0, 1.3 } },
                { { 0, fs / 2000.0, 0.8 } },
            };
            for (const auto& c : controls)
            {
                shifter.reset();
                const auto out = render (shifter, input, c, 480);
                REQUIRE (bitIdentical (out, delayed (input, latency)));
                REQUIRE (shifter.spliceCount() == 0);
                REQUIRE (shifter.recentreCount() == 0);
            }
        }

        // Untouched by setTarget at all (the post-prepare state is unvoiced, d = D).
        shifter.reset();
        const auto noise = lcgNoise (total, 77u);
        REQUIRE (bitIdentical (render (shifter, noise, {}, 333), delayed (noise, latency)));
    }
}

// ---------------------------------------------------------------------------------------
// 2. Ratio-1 voiced identity.
// ---------------------------------------------------------------------------------------
TEST_CASE ("SpliceShifter: voiced at ratio 1 is bit-exact delayed identity", "[retune][shifter]")
{
    for (double fs : { 44100.0, 48000.0, 96000.0 })
    {
        SpliceShifter shifter;
        shifter.prepare (fs);
        const int latency = shifter.latencySamples();
        const int total = (int) fs;

        for (double f0 : { 56.0, 110.0, 440.0, 1100.0 })
        {
            for (const auto& input : { lcgNoise (total), harmonicTone (f0, fs, total) })
            {
                shifter.reset();
                const auto out = render (shifter, input, { { 0, fs / f0, 1.0 } }, 256);
                INFO ("fs " << fs << " f0 " << f0);
                REQUIRE (bitIdentical (out, delayed (input, latency)));
                REQUIRE (shifter.spliceCount() == 0);
                REQUIRE (shifter.delaySamples() == (double) latency);
            }
        }
    }
}

// ---------------------------------------------------------------------------------------
// 3. Pitch.
// ---------------------------------------------------------------------------------------
TEST_CASE ("SpliceShifter: output pitch is the target ratio times the input pitch", "[retune][shifter]")
{
    double worstCents = 0.0;
    for (double f0 : kToneFrequencies)
    {
        for (double cents : kToneCents)
        {
            const auto t = shiftTone (f0, cents);
            const auto a = analyseTone (t);
            worstCents = std::max (worstCents, std::abs (a.pitchErrorCents));
            INFO ("f0 " << f0 << " Hz, " << cents << " cents: measured " << a.measuredHz << " Hz, expected "
                        << f0 * t.ratio << " Hz, error " << a.pitchErrorCents << " cents");
            CHECK (std::abs (a.pitchErrorCents) <= 3.0);
        }
    }
    INFO ("worst pitch error " << worstCents << " cents");
    CHECK (worstCents <= 3.0);
}

TEST_CASE ("SpliceShifter: pitch, harmonics and envelope hold at 44.1 and 96 kHz", "[retune][shifter]")
{
    for (double fs : { 44100.0, 96000.0 })
    {
        for (double cents : { -200.0, 100.0, 200.0 })
        {
            const auto t = shiftTone (220.0, cents, fs);
            const auto a = analyseTone (t);
            INFO ("fs " << fs << ", " << cents << " cents: pitch error " << a.pitchErrorCents
                        << " cents, worst harmonic delta " << a.worstHarmonicDb << " dB");
            CHECK (std::abs (a.pitchErrorCents) <= 3.0);
            CHECK (a.worstHarmonicDb <= 1.5);

            const auto envelope = envelopeVersusIdeal (t.out, t.settle, t.length, 220.0 * t.ratio, fs);
            INFO ("fs " << fs << ", " << cents << " cents: envelope level " << envelope.levelDb << " dB, step "
                        << envelope.stepDb << " dB from ideal");
            CHECK (envelope.levelDb <= 1.5);
            CHECK (envelope.stepDb <= 1.5);
        }
    }
}

// ---------------------------------------------------------------------------------------
// 4. Timbre: the formants move with the pitch, so harmonic amplitudes are kept by
//    harmonic number.
// ---------------------------------------------------------------------------------------
TEST_CASE ("SpliceShifter: the first eight harmonics keep their level", "[retune][shifter]")
{
    double worstDb = 0.0;
    for (double f0 : kToneFrequencies)
    {
        for (double cents : kToneCents)
        {
            const auto a = analyseTone (shiftTone (f0, cents));
            for (int h = 1; h <= kHarmonicsChecked; ++h)
            {
                INFO ("f0 " << f0 << " Hz, " << cents << " cents, harmonic " << h << ": "
                            << a.harmonicDeltaDb[h - 1] << " dB");
                CHECK (std::abs (a.harmonicDeltaDb[h - 1]) <= 1.5);
            }
            worstDb = std::max (worstDb, a.worstHarmonicDb);
        }
    }
    INFO ("worst harmonic level change " << worstDb << " dB");
    CHECK (worstDb <= 1.5);
}

// ---------------------------------------------------------------------------------------
// 5. No clicks.
// ---------------------------------------------------------------------------------------
TEST_CASE ("SpliceShifter: splices leave no clicks in the 1 ms envelope", "[retune][shifter]")
{
    double worstLevel = 0.0, worstStep = 0.0;
    for (double f0 : kToneFrequencies)
    {
        for (double cents : kToneCents)
        {
            const auto t = shiftTone (f0, cents);
            const auto envelope = envelopeVersusIdeal (t.out, t.settle, t.length, f0 * t.ratio, t.fs);
            worstLevel = std::max (worstLevel, envelope.levelDb);
            worstStep = std::max (worstStep, envelope.stepDb);
            INFO ("f0 " << f0 << " Hz, " << cents << " cents: envelope level " << envelope.levelDb << " dB, step "
                        << envelope.stepDb << " dB from the ideal tone");
            CHECK (envelope.levelDb <= 1.5);
            CHECK (envelope.stepDb <= 1.5);
        }
    }
    INFO ("worst envelope level " << worstLevel << " dB, step " << worstStep << " dB");
    CHECK (worstLevel <= 1.5);
    CHECK (worstStep <= 1.5);
}

// A test that cannot fail proves nothing: the same measurement must flag the failures a
// real splice could have. A hard jump of a stale (4 percent long) period, a plain crossfade
// of that stale period, and an equal-power crossfade of the exact period (a 3 dB bump on
// the correlated copies) all land outside the 1.5 dB budget.
TEST_CASE ("SpliceShifter: the envelope measurement flags naive splices", "[retune][shifter]")
{
    const double fs = 48000.0, f0 = 220.0, period = fs / f0;
    const auto input = harmonicTone (f0, fs, (int) (1.3 * fs));
    const int fade = (int) std::lround (std::min (std::max (period, 0.002 * fs), 0.006 * fs));
    const size_t start = (size_t) (0.3 * fs), count = (size_t) fs;

    for (double cents : { -200.0, 200.0 })
    {
        const double ratio = ratioFromCents (cents);
        struct Case
        {
            const char* name;
            double stale;
            bool equalPower, hard;
        } cases[] = {
            { "hard jump, period 4% long", 1.04, false, true },
            { "crossfade, period 4% long", 1.04, false, false },
            { "equal-power crossfade, exact period", 1.0, true, false },
        };
        for (const auto& c : cases)
        {
            const auto naive = naiveRetune (input, period, ratio, c.stale, c.equalPower, c.hard, fade);
            const auto envelope = envelopeVersusIdeal (naive, start, count, f0 * ratio, fs);
            INFO (c.name << ", " << cents << " cents: level " << envelope.levelDb << " dB, step " << envelope.stepDb
                         << " dB from ideal");
            CHECK ((envelope.levelDb > 1.5 || envelope.stepDb > 1.5));
        }

        // And the control reference itself: a naive retuner with the exact period is clean.
        const auto exact = naiveRetune (input, period, ratio, 1.0, false, false, fade);
        const auto envelope = envelopeVersusIdeal (exact, start, count, f0 * ratio, fs);
        INFO ("exact-period crossfade, " << cents << " cents: level " << envelope.levelDb << " dB");
        CHECK (envelope.levelDb <= 1.5);
    }
}

// ---------------------------------------------------------------------------------------
// 6. Chunking.
// ---------------------------------------------------------------------------------------
namespace
{
// Voiced tone, noise bursts, ratio extremes, unvoiced gaps and period changes: forward
// and backward splices, recentres, and the correlation fallback all occur.
std::vector<float> chunkingInput (double fs)
{
    const int total = 150000;
    auto x = harmonicTone (150.0, fs, total);
    const auto noise = lcgNoise (total, 99u, 0.2f);
    for (int n = 48000; n < 62000; ++n)
        x[(size_t) n] = noise[(size_t) n];
    for (int n = 125000; n < 135000; ++n)
        x[(size_t) n] = noise[(size_t) n];
    return x;
}

std::vector<Control> chunkingControls (double fs)
{
    return {
        { 0, fs / 150.0, ratioFromCents (120.0) },
        { 24037, fs / 150.0, ratioFromCents (-150.0) },
        { 48111, 0.0, 1.0 },
        { 60203, fs / 210.0, ratioFromCents (400.0) },
        { 90001, fs / 210.0, ratioFromCents (-400.0) },
        { 110917, fs / 90.0, 1.0 },
        { 125333, -1.0, 5.0 },
    };
}
}  // namespace

TEST_CASE ("SpliceShifter: output is bit-identical for any block chunking", "[retune][shifter]")
{
    const double fs = 48000.0;
    const auto input = chunkingInput (fs);
    const auto controls = chunkingControls (fs);

    SpliceShifter shifter;
    shifter.prepare (fs);
    const auto reference = render (shifter, input, controls, 1);

    // The schedule must actually exercise splices, recentres and clamped ratios.
    INFO ("splices " << shifter.spliceCount() << ", recentres " << shifter.recentreCount());
    REQUIRE (shifter.spliceCount() > 20);
    REQUIRE (shifter.recentreCount() >= 1);
    REQUIRE (allFinite (reference));
    REQUIRE (! bitIdentical (reference, delayed (input, shifter.latencySamples())));

    for (int block : { 64, 128, 137, 512, 4096 })
    {
        shifter.reset();
        const auto out = render (shifter, input, controls, block);
        INFO ("block " << block);
        REQUIRE (bitIdentical (out, reference));
    }
}

// ---------------------------------------------------------------------------------------
// 7. Bounded delay.
// ---------------------------------------------------------------------------------------
TEST_CASE ("SpliceShifter: read delay stays inside its window and the ring", "[retune][shifter]")
{
    const double fs = 48000.0;
    const double extremes[] = { 4.0, -4.0 };  // semitones: both ends of the ratio range

    for (double f0 : { 55.0, 110.0, 440.0, 1200.0 })
    {
        for (double semitones : extremes)
        {
            const double period = fs / f0;
            SpliceShifter shifter;
            shifter.prepare (fs);
            const int latency = shifter.latencySamples();
            const double upper = (double) latency + 2.6 * period;
            const double lower = (double) SpliceShifter::interpolatorReach();

            // The ring holds the deepest read and the correlation reach (spec ring size).
            REQUIRE ((double) shifter.ringSize() >= (double) latency + 2.6 * (fs / 55.0) + 0.010 * fs + 32.0);

            const int total = (int) (2.0 * fs);
            const auto input = harmonicTone (f0, fs, total);
            shifter.setTarget (period, std::exp2 (semitones / 12.0));

            double lowest = 1.0e9, highest = -1.0e9;
            float sample = 0.0f;
            for (int n = 0; n < total; ++n)
            {
                shifter.process (&input[(size_t) n], &sample, 1);
                lowest = std::min ({ lowest, shifter.delaySamples(), shifter.incomingDelaySamples() });
                highest = std::max ({ highest, shifter.delaySamples(), shifter.incomingDelaySamples() });
            }
            INFO ("f0 " << f0 << " Hz, " << semitones << " semitones: d in [" << lowest << ", " << highest
                        << "], allowed [" << lower << ", " << upper << "], splices " << shifter.spliceCount());
            CHECK (lowest >= lower);
            CHECK (highest <= upper);
            CHECK (shifter.guardTrips() == 0);
            CHECK (shifter.spliceCount() > 3);

            // The window has hysteresis: after a splice the head sits half a period inside
            // the window, so splices come at the rate the ratio dictates (|r - 1| per
            // sample against one period per splice) and never ping-pong.
            const double expected = (double) total * std::abs (std::exp2 (semitones / 12.0) - 1.0) / period;
            INFO ("splices " << shifter.spliceCount() << ", expected about " << expected);
            CHECK (std::abs ((double) shifter.spliceCount() - expected) <= 0.1 * expected + 2.0);
        }
    }
}

// ---------------------------------------------------------------------------------------
// 8. Transitions.
// ---------------------------------------------------------------------------------------
TEST_CASE ("SpliceShifter: voiced to unvoiced returns to exact delayed identity within 30 ms", "[retune][shifter]")
{
    const double fs = 48000.0;
    const int switchAt = 14400;  // 0.3 s of voiced audio first
    const int total = 48000;

    double worstMs = 0.0;
    for (double cents : { -400.0, -200.0, -35.0, 35.0, 200.0, 400.0 })
    {
        for (int kind = 0; kind < 2; ++kind)
        {
            const auto input = kind == 0 ? harmonicTone (170.0, fs, total) : lcgNoise (total, 5u);
            SpliceShifter shifter;
            shifter.prepare (fs);
            const auto out = render (shifter, input,
                                     { { 0, fs / 170.0, ratioFromCents (cents) }, { switchAt, 0.0, 1.0 } }, 128);
            REQUIRE (allFinite (out));

            const auto expected = delayed (input, shifter.latencySamples());
            const size_t from = identityFrom (out, expected);
            const double ms = 1000.0 * ((double) from - (double) switchAt) / fs;
            worstMs = std::max (worstMs, ms);
            INFO ("cents " << cents << (kind == 0 ? " tone" : " noise") << ": identity restored " << ms
                           << " ms after the switch, splices " << shifter.spliceCount() << ", recentres "
                           << shifter.recentreCount());
            CHECK (ms <= 30.0);
            CHECK (shifter.guardTrips() == 0);
        }
    }
    INFO ("slowest recovery " << worstMs << " ms");
    CHECK (worstMs <= 30.0);
}

TEST_CASE ("SpliceShifter: output stays finite and bounded under erratic control", "[retune][shifter]")
{
    const double fs = 48000.0;
    const int total = (int) (3.0 * fs);
    const auto input = lcgNoise (total, 321u, 0.5f);

    // Random period / ratio / voicing every few milliseconds, including nonsense values.
    std::vector<Control> controls;
    std::uint32_t state = 0xdeadbeefu;
    auto uniform = [&state] {
        state = state * 1664525u + 1013904223u;
        return (double) (state >> 8) / 16777216.0;
    };
    for (int at = 0; at < total; at += 100 + (int) (uniform() * 700.0))
    {
        const double pick = uniform();
        double period = fs / (50.0 + uniform() * 1200.0);  // mostly valid, edges rejected
        double ratio = std::exp2 ((uniform() * 16.0 - 8.0) / 12.0);
        if (pick < 0.15)
            period = 0.0;
        else if (pick < 0.20)
            ratio = std::numeric_limits<double>::quiet_NaN();
        else if (pick < 0.25)
            period = std::numeric_limits<double>::infinity();
        controls.push_back ({ at, period, ratio });
    }

    SpliceShifter shifter;
    shifter.prepare (fs);
    const auto out = render (shifter, input, controls, 64);
    REQUIRE (allFinite (out));

    float peak = 0.0f;
    for (float v : out)
        peak = std::max (peak, std::abs (v));
    INFO ("peak " << peak << " (input peak 0.5), splices " << shifter.spliceCount() << ", recentres "
                  << shifter.recentreCount() << ", guard trips " << shifter.guardTrips());
    CHECK (peak <= 1.5f);
    CHECK (shifter.spliceCount() > 50);
    CHECK (shifter.guardTrips() == 0);
    CHECK (shifter.delaySamples() >= (double) SpliceShifter::interpolatorReach());
    CHECK (shifter.delaySamples() <= (double) shifter.ringSize());
}

// ---------------------------------------------------------------------------------------
// 9. In place.
// ---------------------------------------------------------------------------------------
TEST_CASE ("SpliceShifter: in-place processing matches out-of-place", "[retune][shifter]")
{
    const double fs = 48000.0;
    const auto input = chunkingInput (fs);
    const auto controls = chunkingControls (fs);

    for (int block : { 1, 137, 4096 })
    {
        SpliceShifter apart, inPlace;
        apart.prepare (fs);
        inPlace.prepare (fs);
        const auto expected = render (apart, input, controls, block, false);
        const auto actual = render (inPlace, input, controls, block, true);
        INFO ("block " << block << ", splices " << inPlace.spliceCount());
        REQUIRE (inPlace.spliceCount() > 20);
        REQUIRE (bitIdentical (actual, expected));
    }
}

// ---------------------------------------------------------------------------------------
// Pieces the properties lean on.
// ---------------------------------------------------------------------------------------

namespace
{
// Per-sample record of a ramp driven through the shifter one sample at a time. The state
// is the one the sample was read with (before process()).
struct Trace
{
    std::vector<double> d, dIncoming;
    std::vector<char> fading;
    std::vector<std::uint32_t> recentres;
    std::vector<float> out;
};

constexpr double kRampSlope = 1.0e-5, kRampOffset = 0.25;

Trace traceRamp (SpliceShifter& shifter, const std::vector<Control>& controls, int total)
{
    Trace t;
    size_t next = 0;
    for (int n = 0; n < total; ++n)
    {
        while (next < controls.size() && controls[next].at <= n)
        {
            shifter.setTarget (controls[next].period, controls[next].ratio);
            ++next;
        }
        t.d.push_back (shifter.delaySamples());
        t.dIncoming.push_back (shifter.incomingDelaySamples());
        t.fading.push_back (shifter.isSplicing() ? 1 : 0);
        t.recentres.push_back (shifter.recentreCount());

        const float x = (float) (kRampOffset + kRampSlope * (double) n);
        float y = 0.0f;
        shifter.process (&x, &y, 1);
        t.out.push_back (y);
    }
    return t;
}

struct CrossfadeEvent
{
    bool recentre = false;
    bool back = false;
    int length = 0;               // samples, counting the first one (gain 0)
    double jump = 0.0;            // |incoming delay - outgoing delay|
    double incomingAtStart = 0.0;
    double worstGainError = 0.0;  // against 0.5 (1 - cos (pi k / length))
};

// A crossfade starts in a sample whose pre-state is not fading and whose successor's is
// (that sample has gain 0); the samples that follow, up to the last fading one, carry
// k = 1, 2, ... Both heads move together, so a and b are the ramp at the two read points
// and g = (out - a) / (b - a).
std::vector<CrossfadeEvent> crossfadeEvents (const Trace& t, size_t ignoreBefore)
{
    std::vector<CrossfadeEvent> events;
    for (size_t start = ignoreBefore; start + 1 < t.d.size(); ++start)
    {
        if (t.fading[start] || ! t.fading[start + 1])
            continue;
        size_t last = start + 1;
        while (last + 1 < t.d.size() && t.fading[last + 1])
            ++last;
        if (last + 1 >= t.d.size())
            break;  // ran off the end mid-fade

        CrossfadeEvent e;
        e.recentre = t.recentres[start + 1] != t.recentres[start];
        e.length = (int) (last - start) + 1;
        e.jump = std::abs (t.dIncoming[start + 1] - t.d[start + 1]);
        e.back = t.dIncoming[start + 1] > t.d[start + 1];
        e.incomingAtStart = t.dIncoming[start + 1];
        for (size_t n = start + 1; n <= last; ++n)
        {
            const double a = kRampOffset + kRampSlope * ((double) n - t.d[n]);
            const double b = kRampOffset + kRampSlope * ((double) n - t.dIncoming[n]);
            const double g = ((double) t.out[n] - a) / (b - a);
            const double k = (double) (n - start);
            e.worstGainError = std::max (e.worstGainError, std::abs (g - 0.5 * (1.0 - std::cos (kPi * k / (double) e.length))));
        }
        events.push_back (e);
        start = last;
    }
    return events;
}
}  // namespace

TEST_CASE ("SpliceShifter: every splice is an equal-gain raised-cosine crossfade of the specified length",
           "[retune][shifter]")
{
    const double fs = 48000.0;
    struct Case
    {
        double f0, cents;
    };

    for (const Case c : { Case { 150.0, 120.0 }, Case { 150.0, -120.0 }, Case { 55.0, 400.0 }, Case { 55.0, -400.0 },
                          Case { 900.0, 200.0 }, Case { 220.0, -200.0 } })
    {
        const double period = fs / c.f0;
        SpliceShifter shifter;
        shifter.prepare (fs);
        const auto trace = traceRamp (shifter, { { 0, period, ratioFromCents (c.cents) } }, 100000);
        const auto events = crossfadeEvents (trace, 6000);

        const int expectedLength = std::min (std::max ((int) std::lround (period), (int) std::lround (0.002 * fs)),
                                             (int) std::lround (0.006 * fs));
        double worstGain = 0.0;
        for (const auto& e : events)
            worstGain = std::max (worstGain, e.worstGainError);
        INFO ("f0 " << c.f0 << " Hz, " << c.cents << " cents: " << events.size() << " crossfades, expected length "
                    << expectedLength << ", worst gain error " << worstGain);
        REQUIRE (events.size() >= 3);
        for (const auto& e : events)
        {
            CHECK (e.length == expectedLength);
            CHECK (! e.recentre);
            CHECK (e.back == (c.cents > 0.0));  // raising the pitch splices back, lowering splices forward
            CHECK (e.jump >= 0.9 * period - 1.5);  // a ramp has a flat correlation, so the parabola can sit on the edge
            CHECK (e.jump <= 1.1 * period + 1.5);
            CHECK (e.worstGainError <= 2.0e-3);
        }
    }

    // The unvoiced recentre is a 4 ms raised-cosine crossfade to exactly d = D.
    {
        SpliceShifter shifter;
        shifter.prepare (fs);
        const auto trace = traceRamp (shifter, { { 0, fs / 150.0, ratioFromCents (150.0) }, { 20000, 0.0, 1.0 } }, 40000);
        const auto events = crossfadeEvents (trace, 6000);
        int recentres = 0;
        for (const auto& e : events)
        {
            if (! e.recentre)
                continue;
            ++recentres;
            INFO ("recentre length " << e.length << ", gain error " << e.worstGainError);
            CHECK (e.length == (int) std::lround (0.004 * fs));
            CHECK (e.incomingAtStart == (double) shifter.latencySamples());
            CHECK (e.worstGainError <= 2.0e-3);
        }
        CHECK (recentres == 1);
    }
}

TEST_CASE ("SpliceShifter: the interpolator has unity gain at every fractional delay", "[retune][shifter]")
{
    // A constant must come out unchanged however the read head moves: each phase of the
    // kernel sums to one, and so does every linear blend of two phases.
    double worst = 0.0;
    for (double fs : { 44100.0, 48000.0, 96000.0 })
    {
        for (double cents : { -400.0, -35.0, 77.0, 400.0 })
        {
            SpliceShifter shifter;
            shifter.prepare (fs);
            const int total = (int) (0.6 * fs);
            const std::vector<float> dc ((size_t) total, 0.25f);
            const auto out = render (shifter, dc, { { 0, fs / 200.0, ratioFromCents (cents) } }, 256);
            double deviation = 0.0;
            for (size_t n = (size_t) (0.1 * fs); n < out.size(); ++n)
                deviation = std::max (deviation, std::abs ((double) out[n] - 0.25));
            worst = std::max (worst, deviation);
            INFO ("fs " << fs << ", " << cents << " cents: worst deviation " << deviation);
            CHECK (deviation <= 1.0e-6);
        }
    }
    INFO ("worst deviation from the constant " << worst);
    CHECK (worst <= 1.0e-6);
}
namespace
{
// Length of every splice jump after the first 0.2 s (the ring starts empty), read off the
// two heads right after each splice begins.
std::vector<double> spliceJumps (SpliceShifter& shifter, const std::vector<float>& input,
                                 const std::vector<Control>& controls, int ignoreBefore)
{
    std::vector<double> jumps;
    size_t next = 0;
    for (int n = 0; n < (int) input.size(); ++n)
    {
        while (next < controls.size() && controls[next].at <= n)
        {
            shifter.setTarget (controls[next].period, controls[next].ratio);
            ++next;
        }
        const auto before = shifter.spliceCount();
        float y = 0.0f;
        shifter.process (&input[(size_t) n], &y, 1);
        if (shifter.spliceCount() != before && n >= ignoreBefore)
            jumps.push_back (std::abs (shifter.incomingDelaySamples() - shifter.delaySamples()));
    }
    return jumps;
}
}  // namespace

TEST_CASE ("SpliceShifter: the splice jump is the period measured on the audio, not the tracker's", "[retune][shifter]")
{
    // The tone's true period is fs / f0, not an integer. Whatever the tracker reports (4 and
    // 5 percent either side is well inside the 10 percent search range), every jump must land
    // on the true period.
    double worstError = 0.0;
    for (double fs : { 44100.0, 48000.0, 96000.0 })
    {
        for (double f0 : { 110.0, 220.0, 440.0 })
        {
            for (double stale : { 0.95, 1.0, 1.04 })
            {
                for (double cents : { -120.0, 120.0 })
                {
                    SpliceShifter shifter;
                    shifter.prepare (fs);
                    const auto tone = harmonicTone (f0, fs, (int) (0.8 * fs));
                    const double truePeriod = fs / f0;
                    const auto jumps = spliceJumps (shifter, tone, { { 0, truePeriod * stale, ratioFromCents (cents) } },
                                                    (int) (0.2 * fs));
                    REQUIRE (jumps.size() >= 3);
                    double worst = 0.0;
                    for (double jump : jumps)
                        worst = std::max (worst, std::abs (jump - truePeriod));
                    worstError = std::max (worstError, worst);
                    INFO ("fs " << fs << ", f0 " << f0 << " Hz, tracker period x" << stale << ", " << cents
                                << " cents: true period " << truePeriod << ", worst jump error " << worst
                                << " samples over " << jumps.size() << " splices");
                    CHECK (worst <= 0.05);
                }
            }
        }
    }
    INFO ("worst jump error " << worstError << " samples");
    CHECK (worstError <= 0.05);
}

TEST_CASE ("SpliceShifter: with no periodicity in the audio the jump is the tracker's period", "[retune][shifter]")
{
    // White noise correlates below 0.5 at every lag, so the refinement must stand down.
    for (double fs : { 48000.0, 96000.0 })
    {
        for (double cents : { -150.0, 150.0 })
        {
            SpliceShifter shifter;
            shifter.prepare (fs);
            const double period = fs / 137.3;
            const auto noise = lcgNoise ((int) (0.8 * fs), 31u);
            const auto jumps = spliceJumps (shifter, noise, { { 0, period, ratioFromCents (cents) } }, (int) (0.2 * fs));
            REQUIRE (jumps.size() >= 3);
            for (double jump : jumps)
                CHECK (jump == Catch::Approx (period).margin (1.0e-9));
        }
    }
}

TEST_CASE ("SpliceShifter: the splice length is refined against the audio when the period is stale", "[retune][shifter]")
{
    // A tracker period several percent off the true one must not spoil the output: the
    // jump is measured on the audio itself. Without refinement a 4 percent error would
    // misalign the tenth harmonic by 0.4 of a cycle.
    for (double stale : { 0.96, 1.04 })
    {
        for (double cents : { -150.0, 120.0 })
        {
            const auto t = shiftTone (150.0, cents, 48000.0, stale);
            const auto a = analyseTone (t);
            const double expectedHz = 150.0 * t.ratio;
            const double error = a.pitchErrorCents;
            const double worstDb = a.worstHarmonicDb;
            const auto envelope = envelopeVersusIdeal (t.out, t.settle, t.length, expectedHz, t.fs);
            INFO ("period x" << stale << ", " << cents << " cents: pitch error " << error << " cents, harmonic delta "
                             << worstDb << " dB, envelope level " << envelope.levelDb << " dB, step "
                             << envelope.stepDb << " dB");
            CHECK (std::abs (error) <= 3.0);
            CHECK (worstDb <= 1.5);
            CHECK (envelope.levelDb <= 1.5);
            CHECK (envelope.stepDb <= 1.5);
        }
    }
}

TEST_CASE ("SpliceShifter: reset returns to the unvoiced initial state", "[retune][shifter]")
{
    const double fs = 48000.0;
    const auto input = chunkingInput (fs);
    const auto controls = chunkingControls (fs);

    SpliceShifter fresh;
    fresh.prepare (fs);
    const auto expected = render (fresh, input, controls, 512);

    SpliceShifter reused;
    reused.prepare (fs);
    render (reused, lcgNoise (30000, 4u), { { 0, fs / 120.0, ratioFromCents (300.0) } }, 512);
    REQUIRE (reused.spliceCount() > 0);

    reused.reset();
    REQUIRE (reused.spliceCount() == 0);
    REQUIRE (reused.delaySamples() == (double) reused.latencySamples());
    REQUIRE (reused.currentRatio() == 1.0);
    REQUIRE (bitIdentical (render (reused, input, controls, 512), expected));
}
