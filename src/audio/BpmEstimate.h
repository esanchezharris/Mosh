#pragma once

// Offline tempo estimate for a beat or loop, behind detect_clip_bpm and set_clip_warp's
// detect:true (src/moshops/MoshOps.Clips.cpp). Header-only and JUCE-free so MoshTests can
// unit it (tests/test_bpm_estimate.cpp).
//
// The 2026-11-15 owner check (START-beat) put ten real beats through the previous
// estimator, which autocorrelated the positive difference of a 5 ms full-band RMS
// envelope and took the single best lag. On six of the ten it landed on a ratio no
// half/double tap can fix (142.5 for a ~104 BPM beat): hi-hat rolls, triplets and 808
// tails all made off-beat lags look as periodic as the beat. This version:
//   1. builds an onset envelope from log-compressed spectral flux in 8 log-spaced bands,
//      with a ~0.5 s local mean subtracted, so a sustained 808 or a swell is not an onset;
//   2. scores each tempo by its autocorrelation plus half its 2-beat and a quarter of its
//      4-beat lag, because a real beat period repeats at the half bar and the bar;
//   3. weights that score with a log-normal prior centred on 120 BPM (one octave wide),
//      which settles the half/double choice the way the singer most likely counts.
// Evidence: ~/Library/Mosh/task-evidence/2026-11-15-owner-checks/tempo-fix/.
// Known limit: a pure steady tone (no beat at all) still reports a tempo with high
// confidence, from window-leakage ripple in near-silent bands. Real beats are unaffected.

#include <algorithm>
#include <cmath>
#include <complex>
#include <utility>
#include <vector>

namespace mosh::bpm
{
struct Estimate
{
    double bpm = 0.0;        // 0 when there is no usable pulse
    double confidence = 0.0; // normalised autocorrelation at the chosen beat lag, 0..1
};

constexpr double kMinBpm = 70.0;
constexpr double kMaxBpm = 180.0;
constexpr double kStepBpm = 0.5;
constexpr double kPriorCentreBpm = 120.0;
constexpr int kFftSize = 2048;
constexpr int kBands = 8;

namespace detail
{
inline void fft (std::vector<std::complex<double>>& a)
{
    const size_t n = a.size();
    for (size_t i = 1, j = 0; i < n; ++i)
    {
        size_t bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) std::swap (a[i], a[j]);
    }
    for (size_t len = 2; len <= n; len <<= 1)
    {
        const double ang = -2.0 * M_PI / (double) len;
        const std::complex<double> wl (std::cos (ang), std::sin (ang));
        for (size_t i = 0; i < n; i += len)
        {
            std::complex<double> w (1.0, 0.0);
            for (size_t k = 0; k < len / 2; ++k)
            {
                const auto u = a[i + k], v = a[i + k + len / 2] * w;
                a[i + k] = u + v;
                a[i + k + len / 2] = u - v;
                w *= wl;
            }
        }
    }
}

/** Onset envelope (one value per hop) and its rate in hops per second. */
inline std::vector<double> onsetEnvelope (const float* mono, int numSamples, double sampleRate, double& hopsPerSecond)
{
    const int hop = std::max (1, (int) std::lround (sampleRate / 100.0)); // ~10 ms
    hopsPerSecond = sampleRate / (double) hop;
    if (numSamples < kFftSize) return {};
    const int frames = 1 + (numSamples - kFftSize) / hop;
    if (frames < 16) return {};

    std::vector<double> window ((size_t) kFftSize);
    for (int i = 0; i < kFftSize; ++i)
        window[(size_t) i] = 0.5 - 0.5 * std::cos (2.0 * M_PI * (double) i / (double) (kFftSize - 1));

    // Band b covers bins whose centre frequency is in [edge[b], edge[b+1]): log-spaced 30 Hz..16 kHz.
    const double top = std::min (16000.0, sampleRate / 2.0 - 1.0);
    std::vector<int> bandOf ((size_t) (kFftSize / 2 + 1), -1);
    for (int k = 0; k <= kFftSize / 2; ++k)
    {
        const double hz = (double) k * sampleRate / (double) kFftSize;
        if (hz < 30.0 || hz >= top) continue;
        const int b = (int) std::floor (std::log (hz / 30.0) / std::log (top / 30.0) * (double) kBands);
        bandOf[(size_t) k] = std::clamp (b, 0, kBands - 1);
    }

    std::vector<double> flux ((size_t) frames, 0.0), prev ((size_t) kBands, 0.0), cur ((size_t) kBands, 0.0);
    std::vector<std::complex<double>> buf ((size_t) kFftSize);
    for (int f = 0; f < frames; ++f)
    {
        const float* x = mono + (size_t) f * (size_t) hop;
        for (int i = 0; i < kFftSize; ++i) buf[(size_t) i] = { (double) x[i] * window[(size_t) i], 0.0 };
        fft (buf);
        std::fill (cur.begin(), cur.end(), 0.0);
        for (int k = 0; k <= kFftSize / 2; ++k)
            if (const int b = bandOf[(size_t) k]; b >= 0) cur[(size_t) b] += std::abs (buf[(size_t) k]);
        double sum = 0.0;
        for (int b = 0; b < kBands; ++b)
        {
            const double l = std::log1p (1000.0 * cur[(size_t) b]);
            if (f > 0) sum += std::max (0.0, l - prev[(size_t) b]);
            prev[(size_t) b] = l;
        }
        flux[(size_t) f] = sum;
    }

    // Subtract a ~0.5 s centred moving average (zero-padded at the edges), keep what's above it.
    int k = (int) std::lround (hopsPerSecond * 0.5) | 1;
    const int half = k / 2;
    std::vector<double> prefix ((size_t) frames + 1, 0.0);
    for (int f = 0; f < frames; ++f) prefix[(size_t) f + 1] = prefix[(size_t) f] + flux[(size_t) f];
    std::vector<double> env ((size_t) frames, 0.0);
    for (int f = 0; f < frames; ++f)
    {
        const int lo = std::max (0, f - half), hi = std::min (frames, f + half + 1);
        const double local = (prefix[(size_t) hi] - prefix[(size_t) lo]) / (double) k;
        env[(size_t) f] = std::max (0.0, flux[(size_t) f] - local);
    }
    return env;
}
} // namespace detail

/** Tempo of a mono signal. Analyse a bounded window (the caller decides how much). */
inline Estimate estimate (const float* mono, int numSamples, double sampleRate)
{
    if (mono == nullptr || numSamples <= 0 || sampleRate <= 0.0) return {};
    double hopsPerSecond = 0.0;
    auto env = detail::onsetEnvelope (mono, numSamples, sampleRate, hopsPerSecond);
    const int n = (int) env.size();
    if (n < 16) return {};

    double mean = 0.0;
    for (double v : env) mean += v;
    mean /= (double) n;
    if (mean <= 1.0e-6) return {}; // digital silence: no onsets at all
    double var0 = 0.0;
    for (auto& v : env) { v -= mean; var0 += v * v; }
    var0 /= (double) n;
    if (var0 <= 1.0e-12) return {}; // silence or a steady tone

    auto autocorr = [&] (double lag) -> double
    {
        // Linear-interpolated, normalised autocorrelation at a fractional lag in hops.
        if (lag < 1.0 || lag >= (double) (n - 2)) return 0.0;
        const int L = (int) std::floor (lag);
        const double frac = lag - (double) L;
        const int m = n - L - 1;
        double acc = 0.0;
        for (int i = 0; i < m; ++i)
            acc += env[(size_t) i] * (env[(size_t) (i + L)] * (1.0 - frac) + env[(size_t) (i + L + 1)] * frac);
        return acc / (double) m / var0;
    };

    Estimate best;
    double bestScore = -1.0e30;
    for (double bpm = kMinBpm; bpm <= kMaxBpm + 1.0e-9; bpm += kStepBpm)
    {
        const double lag = 60.0 / bpm * hopsPerSecond;
        const double raw = autocorr (lag);
        const double comb = raw + 0.5 * autocorr (2.0 * lag) + 0.25 * autocorr (4.0 * lag);
        const double octaves = std::log2 (bpm / kPriorCentreBpm);
        const double score = comb * std::exp (-0.5 * octaves * octaves);
        if (score > bestScore)
        {
            bestScore = score;
            best = { bpm, std::clamp (raw, 0.0, 1.0) };
        }
    }
    if (bestScore <= 0.0) return {};
    return best;
}
} // namespace mosh::bpm
