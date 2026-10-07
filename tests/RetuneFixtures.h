#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <functional>
#include <vector>

// Deterministic synthetic vocal fixtures with EXACT ground truth, ported from the
// owner's Moshpit M006/M009 TuneFixtures.h and TuneGateTools.h. A harmonic comb
// (20 harmonics, 1/n decay) is shaped by three parallel formant resonators (an
// "ah" vowel), so the tracker and the retuner are graded on vocal-like spectra,
// never on sine waves. These are regression fixtures: passing them says nothing
// about how real voices sound (docs/AUTOTUNE-SCOPE-2026-10-01.md §1).

namespace mosh::tests::retune
{
inline constexpr double kTwoPi = 6.283185307179586476925286766559;

struct VocalFixture
{
    std::vector<float> samples;
    double sampleRate = 48000.0;
    std::function<double (double)> f0At;   // Hz, ground truth
    std::function<bool (double)> voicedAt; // ground truth voicing
};

namespace detail
{
    // RBJ constant-peak bandpass biquad.
    struct Resonator
    {
        double b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
        double z1 = 0, z2 = 0;

        void design (double centreHz, double q, double sampleRate)
        {
            const double omega = kTwoPi * centreHz / sampleRate;
            const double alpha = std::sin (omega) / (2.0 * q);
            const double a0 = 1.0 + alpha;
            b0 = alpha / a0;
            b1 = 0.0;
            b2 = -alpha / a0;
            a1 = -2.0 * std::cos (omega) / a0;
            a2 = (1.0 - alpha) / a0;
        }

        double process (double x)
        {
            const double y = b0 * x + z1;
            z1 = b1 * x - a1 * y + z2;
            z2 = b2 * x - a2 * y;
            return y;
        }
    };

    struct FormantBank
    {
        Resonator low, mid, high;

        explicit FormantBank (double sampleRate)
        {
            low.design (700.0, 6.0, sampleRate);
            mid.design (1200.0, 6.0, sampleRate);
            high.design (2600.0, 6.0, sampleRate);
        }

        double process (double x)
        {
            return low.process (x) + 0.7 * mid.process (x) + 0.4 * high.process (x) + 0.1 * x;
        }
    };

    // Deterministic uniform noise in [-1, 1).
    struct Lcg
    {
        std::uint32_t state;
        explicit Lcg (std::uint32_t seed) : state (seed) {}
        double next()
        {
            state = state * 1664525u + 1013904223u;
            return (double) (state >> 8) / 8388608.0 - 1.0;
        }
    };

    inline void normalizeAndShape (std::vector<float>& samples, double sampleRate, float peakTarget)
    {
        const int fade = std::max (1, (int) (sampleRate * 0.030)); // 30 ms attack/release
        const int count = (int) samples.size();
        for (int i = 0; i < count; ++i)
        {
            double gain = 1.0;
            if (i < fade)
                gain = (double) i / fade;
            if (i >= count - fade)
                gain = std::min (gain, (double) (count - 1 - i) / fade);
            samples[(std::size_t) i] = (float) (samples[(std::size_t) i] * gain);
        }
        float peak = 0.0f;
        for (const float s : samples)
            peak = std::max (peak, std::abs (s));
        if (peak > 0.0f)
            for (auto& s : samples)
                s = s * (peakTarget / peak);
    }
}

[[nodiscard]] inline double centsToHz (double baseHz, double cents)
{
    return baseHz * std::pow (2.0, cents / 1200.0);
}

[[nodiscard]] inline double hzToCents (double hz, double refHz)
{
    return 1200.0 * std::log2 (hz / refHz);
}

// Voiced vocal-like tone following f0At; optional noise mixed at noiseDb relative
// to the tone's RMS.
inline VocalFixture renderVocal (double durationSeconds, std::function<double (double)> f0At,
                                 double noiseDb = -1000.0, double sampleRate = 48000.0,
                                 float peakTarget = 0.5f)
{
    VocalFixture fixture;
    fixture.sampleRate = sampleRate;
    fixture.f0At = f0At;
    fixture.voicedAt = [] (double) { return true; };
    const int count = (int) (durationSeconds * sampleRate);
    fixture.samples.resize ((std::size_t) count, 0.0f);
    detail::FormantBank formants (sampleRate);
    double phase = 0.0;
    std::vector<double> raw ((std::size_t) count, 0.0);
    double energy = 0.0;
    for (int i = 0; i < count; ++i)
    {
        const double t = (double) i / sampleRate;
        const double f0 = f0At (t);
        phase += kTwoPi * f0 / sampleRate;
        double sample = 0.0;
        for (int harmonic = 1; harmonic <= 20; ++harmonic)
        {
            if (harmonic * f0 >= 0.45 * sampleRate)
                break;
            sample += std::sin (harmonic * phase) / harmonic;
        }
        const double shaped = formants.process (sample);
        raw[(std::size_t) i] = shaped;
        energy += shaped * shaped;
    }
    const double rms = std::sqrt (energy / std::max (1, count));
    detail::Lcg random (7);
    const double noiseGain = noiseDb > -900.0 ? rms * std::pow (10.0, noiseDb / 20.0) : 0.0;
    detail::FormantBank noiseFormants (sampleRate);
    for (int i = 0; i < count; ++i)
    {
        double value = raw[(std::size_t) i];
        if (noiseGain > 0.0)
            value += noiseGain * noiseFormants.process (random.next()) * 3.0;
        fixture.samples[(std::size_t) i] = (float) value;
    }
    detail::normalizeAndShape (fixture.samples, sampleRate, peakTarget);
    return fixture;
}

// Steady vowel at A3 + 35 cents.
inline VocalFixture steadyDetunedFixture (double seconds = 1.0, double sampleRate = 48000.0)
{
    return renderVocal (seconds, [] (double) { return centsToHz (220.0, 35.0); }, -1000.0, sampleRate);
}

// 5.5 Hz vibrato, +/-50 cents around A3 + 35 cents.
inline VocalFixture vibratoFixture()
{
    return renderVocal (1.0, [] (double t) { return centsToHz (220.0, 35.0 + 50.0 * std::sin (kTwoPi * 5.5 * t)); });
}

// C4 -> E4 linear-in-cents glissando over 0.5 s with holds.
inline VocalFixture glissandoFixture()
{
    return renderVocal (0.7, [] (double t)
    {
        const double progress = std::clamp ((t - 0.1) / 0.5, 0.0, 1.0);
        return centsToHz (261.63, 400.0 * progress);
    });
}

// The steady vowel plus formant-shaped noise at -20 dB.
inline VocalFixture breathyFixture()
{
    return renderVocal (1.0, [] (double) { return centsToHz (220.0, 35.0); }, -20.0);
}

// Vowel / noise burst ("consonant") / vowel; voicing truth marks the burst unvoiced.
inline VocalFixture phraseFixture (double sampleRate = 48000.0)
{
    auto vowelA = renderVocal (0.4, [] (double) { return centsToHz (220.0, 35.0); }, -1000.0, sampleRate);
    auto vowelB = renderVocal (0.4, [] (double) { return centsToHz (220.0, -20.0); }, -1000.0, sampleRate);
    VocalFixture fixture;
    fixture.sampleRate = sampleRate;
    const int burstFrames = (int) (0.12 * sampleRate);
    fixture.samples = vowelA.samples;
    detail::Lcg random (11);
    detail::FormantBank burstFormants (sampleRate);
    for (int i = 0; i < burstFrames; ++i)
        fixture.samples.push_back ((float) (0.15 * burstFormants.process (random.next())));
    fixture.samples.insert (fixture.samples.end(), vowelB.samples.begin(), vowelB.samples.end());
    const double burstStart = 0.4;
    const double burstEnd = burstStart + 0.12;
    fixture.voicedAt = [burstStart, burstEnd] (double t) { return t < burstStart || t >= burstEnd; };
    fixture.f0At = [burstStart, burstEnd] (double t)
    {
        if (t < burstStart)
            return centsToHz (220.0, 35.0);
        if (t >= burstEnd)
            return centsToHz (220.0, -20.0);
        return 0.0;
    };
    return fixture;
}

struct CentsStats
{
    double median = 0.0;
    double p95Abs = 0.0;
    int frames = 0;
};

[[nodiscard]] inline CentsStats centsSeriesStats (const std::vector<double>& cents)
{
    CentsStats stats;
    stats.frames = (int) cents.size();
    if (cents.empty())
        return stats;
    std::vector<double> absSorted;
    for (const double c : cents)
        absSorted.push_back (std::abs (c));
    std::sort (absSorted.begin(), absSorted.end());
    stats.p95Abs = absSorted[std::min (absSorted.size() - 1, (std::size_t) ((double) absSorted.size() * 0.95))];
    auto sorted = cents;
    std::sort (sorted.begin(), sorted.end());
    stats.median = sorted[sorted.size() / 2];
    return stats;
}

// Magnitude of one frequency over a Hann-windowed segment (linear, 1.0 for a
// full-scale sine at that frequency).
[[nodiscard]] inline double toneLevel (const float* samples, int numFrames, double sampleRate, double hz)
{
    double re = 0.0, im = 0.0, windowSum = 0.0;
    for (int i = 0; i < numFrames; ++i)
    {
        const double window = 0.5 * (1.0 - std::cos (kTwoPi * i / (numFrames - 1)));
        const double angle = kTwoPi * hz * i / sampleRate;
        re += window * samples[i] * std::cos (angle);
        im -= window * samples[i] * std::sin (angle);
        windowSum += window;
    }
    return 2.0 * std::sqrt (re * re + im * im) / std::max (windowSum, 1.0e-12);
}
}
