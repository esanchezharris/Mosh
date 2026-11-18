// The offline tempo estimate behind detect_clip_bpm (src/audio/BpmEstimate.h). Synthetic
// beats at known tempos, built from the patterns that broke the previous estimator on the
// owner's real beats (2026-11-15 START-beat run): 16th hats with 32nd and triplet rolls,
// long 808 tails, a half-time snare, swing, and a long quiet intro. The real-beat check
// lives with the evidence (task-evidence/2026-11-15-owner-checks/tempo-fix), since the
// beats are not ours to commit.
#include <catch2/catch_test_macros.hpp>

#include "audio/BpmEstimate.h"

#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

namespace
{
constexpr double kSr = 44100.0;

struct Noise
{
    uint32_t s = 7;
    float next() // deterministic white noise in [-1, 1)
    {
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        return (float) ((double) s / 2147483648.0 - 1.0);
    }
};

void place (std::vector<float>& y, const std::vector<float>& x, double at)
{
    const auto i0 = (size_t) std::lround (at * kSr);
    for (size_t i = 0; i < x.size() && i0 + i < y.size(); ++i) y[i0 + i] += x[i];
}

std::vector<float> decay (int n, double tau, Noise* noise, double hz, double gain)
{
    std::vector<float> x ((size_t) n);
    double phase = 0.0;
    for (int i = 0; i < n; ++i)
    {
        const double t = (double) i / kSr, e = std::exp (-t / tau);
        if (noise != nullptr) x[(size_t) i] = (float) (gain * noise->next() * e);
        else
        {
            // a kick sweeps down from ~140 Hz; a plain tone (the 808) stays put
            const double f = hz > 0.0 ? hz : 50.0 + 90.0 * std::exp (-t / 0.03);
            phase += 2.0 * M_PI * f / kSr;
            x[(size_t) i] = (float) (gain * std::sin (phase) * e);
        }
    }
    return x;
}

enum class Kind { trap, boomBap, house, sparse };

std::vector<float> beat (Kind kind, double bpm, double seconds = 24.0, double intro = 0.0)
{
    Noise noise;
    std::vector<float> y ((size_t) ((seconds + intro) * kSr), 0.0f);
    for (size_t i = 0; i < (size_t) (intro * kSr); ++i) // a quiet rising pad, no pulse
        y[i] = (float) (0.05 * std::sin (2.0 * M_PI * 220.0 * (double) i / kSr) * (double) i / (intro * kSr));

    const double b = 60.0 / bpm;
    const auto kick = decay ((int) (0.25 * kSr), 0.12, nullptr, 0.0, 1.0);
    const auto snare = decay ((int) (0.2 * kSr), 0.06, &noise, 0.0, 0.6);
    const auto hat = [&] (double g) { return decay ((int) (0.04 * kSr), 0.012, &noise, 0.0, g); };
    const int beats = (int) (seconds / b);
    for (int k = 0; k < beats; ++k)
    {
        const double t0 = intro + k * b;
        const int bar = k % 4;
        switch (kind)
        {
            case Kind::trap:
            {
                if (bar == 0 || (bar == 2 && k % 8 == 6))
                {
                    place (y, kick, t0);
                    place (y, decay ((int) (1.6 * b * kSr), 0.9, nullptr, 45.0, 0.6), t0);
                }
                if (bar == 2) place (y, snare, t0);
                const int sub = k % 8 == 7 ? 6 : (k % 8 == 3 ? 8 : 4); // triplet and 32nd rolls
                for (int s = 0; s < sub; ++s) place (y, hat (s % 2 == 0 ? 0.28 : 0.18), t0 + s * b / sub);
                break;
            }
            case Kind::boomBap:
                if (bar == 0 || k % 8 == 5) place (y, kick, t0);
                if (bar == 1 || bar == 3) place (y, snare, t0);
                for (int s = 0; s < 4; ++s) place (y, hat (0.2), t0 + s * b / 4 + (s % 2 == 1 ? 0.12 * b : 0.0));
                break;
            case Kind::house:
                place (y, kick, t0);
                place (y, hat (0.3), t0 + b / 2);
                if (bar == 1 || bar == 3) place (y, snare, t0);
                break;
            case Kind::sparse:
                place (y, kick, t0);
                break;
        }
    }
    float peak = 0.0f;
    for (float v : y) peak = std::max (peak, std::abs (v));
    for (auto& v : y) v = v / (peak + 1.0e-9f) * 0.9f;
    return y;
}

// The tempo, or the octave a single ÷2/×2 tap on the Start page fixes, within 2.5%.
bool octaveEquivalent (double est, double truth)
{
    for (double m : { 0.5, 1.0, 2.0 })
        if (std::abs (est - m * truth) <= 0.025 * m * truth) return true;
    return false;
}

void requireTempo (Kind kind, double bpm, double intro = 0.0)
{
    const auto y = beat (kind, bpm, 24.0, intro);
    const auto e = mosh::bpm::estimate (y.data(), (int) y.size(), kSr);
    INFO ("truth " << bpm << " BPM, intro " << intro << " s -> estimate " << e.bpm << " (confidence " << e.confidence << ")");
    CHECK (octaveEquivalent (e.bpm, bpm));
    CHECK (e.confidence > 0.0);
}
} // namespace

TEST_CASE ("bpm estimate: trap with hat rolls and 808 tails lands on the beat or its octave", "[bpm]")
{
    requireTempo (Kind::trap, 130.0); // the previous estimator said 174.5 (a 4:3 ratio)
    requireTempo (Kind::trap, 140.0);
    requireTempo (Kind::trap, 150.0);
    requireTempo (Kind::trap, 160.0);
}

TEST_CASE ("bpm estimate: swung boom bap, house and a bare kick", "[bpm]")
{
    requireTempo (Kind::boomBap, 84.0);
    requireTempo (Kind::boomBap, 90.0);
    requireTempo (Kind::boomBap, 96.0);
    requireTempo (Kind::house, 124.0);
    requireTempo (Kind::sparse, 88.0);
}

TEST_CASE ("bpm estimate: a long quiet intro does not move the tempo", "[bpm]")
{
    requireTempo (Kind::trap, 140.0, 12.0);
}

TEST_CASE ("bpm estimate: the reported tempo stays in the scanned range", "[bpm]")
{
    const auto y = beat (Kind::sparse, 60.0);
    const auto e = mosh::bpm::estimate (y.data(), (int) y.size(), kSr);
    CHECK (e.bpm >= mosh::bpm::kMinBpm);
    CHECK (e.bpm <= mosh::bpm::kMaxBpm);
    CHECK (octaveEquivalent (e.bpm, 60.0)); // a 60 BPM beat reads as 120
}

// Not asserted: a pure synthetic sine. Window leakage in bands 60+ dB under it ripples with
// the hop/period beat and reads as a strong pulse; no floor tried fixed it without losing
// quiet real hits (task-evidence/2026-11-15-owner-checks/tempo-fix/delta2.py).
TEST_CASE ("bpm estimate: silence and too little audio give no tempo", "[bpm]")
{
    std::vector<float> silence ((size_t) (10.0 * kSr), 0.0f);
    CHECK (mosh::bpm::estimate (silence.data(), (int) silence.size(), kSr).bpm == 0.0);

    std::vector<float> blip (1000, 0.5f);
    CHECK (mosh::bpm::estimate (blip.data(), (int) blip.size(), kSr).bpm == 0.0);
    CHECK (mosh::bpm::estimate (nullptr, 0, kSr).bpm == 0.0);
}
