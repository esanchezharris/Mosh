#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "plugins/moshfx/MoshFxDsp.h"

#include <algorithm>
#include <cmath>
#include <numeric>
#include <vector>

namespace
{
    constexpr double kSampleRate = 48000.0;
    constexpr double kPi = 3.14159265358979323846;

    std::vector<float> sine (double hz, int samples, float gain = 0.3f)
    {
        std::vector<float> out ((size_t) samples);
        double phase = 0.0;
        const double inc = 2.0 * kPi * hz / kSampleRate;
        for (auto& s : out)
        {
            s = gain * (float) std::sin (phase);
            phase += inc;
        }
        return out;
    }

    std::vector<float> noise (int samples)
    {
        std::vector<float> out ((size_t) samples);
        uint32_t state = 0x12345678u;
        for (auto& s : out)
        {
            state = state * 1664525u + 1013904223u;
            const auto v = (int) ((state >> 8) & 0xffffu) - 32768;
            s = (float) v / 32768.0f * 0.1f;
        }
        return out;
    }

    double rmsDiff (const std::vector<float>& a, const std::vector<float>& b)
    {
        double sum = 0.0;
        for (size_t i = 0; i < a.size(); ++i)
        {
            const auto d = (double) a[i] - (double) b[i];
            sum += d * d;
        }
        return std::sqrt (sum / (double) a.size());
    }

    double peak (const std::vector<float>& a)
    {
        double p = 0.0;
        for (auto s : a)
            p = std::max (p, std::abs ((double) s));
        return p;
    }
}

// Mosh AutoTune's engine is covered by test_retune_core.cpp and test_retune_shifter.cpp.

TEST_CASE ("Mosh OTT is conservative by default and stronger at high amount", "[moshfx][ott]")
{
    auto input = sine (110.0, 8192, 0.55f);
    for (size_t i = 0; i < input.size(); ++i)
        input[i] *= (i % 512 < 32) ? 1.7f : 0.35f;

    std::vector<float> defaults = input;
    mosh::moshfx::OTTSettings subtle;
    mosh::moshfx::OTTCore subtleCore;
    subtleCore.prepare (kSampleRate);
    subtleCore.processBlock (defaults.data(), (int) defaults.size(), subtle);

    std::vector<float> pushed = input;
    mosh::moshfx::OTTSettings heavy = subtle;
    heavy.amount = 0.85f;
    heavy.downward = 0.8f;
    heavy.upward = 0.6f;
    mosh::moshfx::OTTCore heavyCore;
    heavyCore.prepare (kSampleRate);
    heavyCore.processBlock (pushed.data(), (int) pushed.size(), heavy);

    CHECK (peak (defaults) <= 1.0);
    CHECK (peak (pushed) <= 1.0);
    CHECK (rmsDiff (input, defaults) < 0.08);
    CHECK (rmsDiff (input, pushed) > rmsDiff (input, defaults) * 1.5);
}

namespace
{
    // The OTT band gain law (MoshOTTDsp.cpp ottGainDb) with the static trim removed,
    // restated here so the meter's gainDb is checked against the documented curve.
    double ottDynamicGainDb (double levelDb, double amount, double upward, double downward)
    {
        double g = 0.0;
        if (levelDb > -20.0)
            g += ((-20.0 + (levelDb + 20.0) / 4.0) - levelDb) * downward * amount;
        if (levelDb > -76.0 && levelDb < -38.0)
            g += std::min (18.0, (-38.0 - levelDb) * 0.45) * upward * amount;
        return g;
    }
}

TEST_CASE ("Mosh OTT block meter: a loud band is cut, a quiet band is lifted", "[moshfx][ott][live-meter]")
{
    mosh::moshfx::OTTSettings settings;
    settings.amount = 1.0f;

    // Loud low band: 110 Hz at 0.8 sits well above -20 dB in the low band.
    auto loud = sine (110.0, 48000, 0.8f);
    mosh::moshfx::OTTCore loudCore;
    loudCore.prepare (kSampleRate);
    loudCore.processBlock (loud.data(), (int) loud.size(), settings);
    const auto& lm = loudCore.lastBlockMeter();
    CHECK (lm.dynamicsRan);
    const double loudLevel = 20.0 * std::log10 ((double) lm.peakEnvelope[0]);
    CHECK (loudLevel > -20.0);
    CHECK (lm.gainDb[0] < -1.0);   // downward: a cut
    // The gain at the end of the block follows the band law at the envelope's level
    // (a steady tone: the final envelope sits within its ripple of the block peak).
    CHECK (std::abs (lm.gainDb[0] - ottDynamicGainDb (loudLevel, 1.0, settings.upward, settings.downward)) < 0.6);

    // Quiet low band: 110 Hz at 0.003 (about -50 dB) is inside the upward window.
    auto quiet = sine (110.0, 48000, 0.003f);
    mosh::moshfx::OTTCore quietCore;
    quietCore.prepare (kSampleRate);
    quietCore.processBlock (quiet.data(), (int) quiet.size(), settings);
    const auto& qm = quietCore.lastBlockMeter();
    const double quietLevel = 20.0 * std::log10 ((double) qm.peakEnvelope[0]);
    CHECK (quietLevel < -38.0);
    CHECK (quietLevel > -76.0);
    CHECK (qm.gainDb[0] > 0.5);    // upward: a lift
    CHECK (std::abs (qm.gainDb[0] - ottDynamicGainDb (quietLevel, 1.0, settings.upward, settings.downward)) < 0.6);
    CHECK_FALSE (qm.clipped);
}

TEST_CASE ("Mosh OTT block meter: clamp and amount-zero reporting", "[moshfx][ott][live-meter]")
{
    mosh::moshfx::OTTSettings settings;
    settings.amount = 0.0f;   // trim and limit only
    settings.outputDb = 0.0f;

    auto hot = sine (440.0, 4800, 1.5f);
    mosh::moshfx::OTTCore core;
    core.prepare (kSampleRate);
    core.processBlock (hot.data(), (int) hot.size(), settings);
    CHECK (core.lastBlockMeter().clipped);
    CHECK_FALSE (core.lastBlockMeter().dynamicsRan);
    CHECK (core.lastBlockMeter().gainDb[0] == 0.0f);
    CHECK (core.lastBlockMeter().peakEnvelope[1] == 0.0f);

    // The next block is metered from scratch: a quiet block does not inherit the clamp.
    auto soft = sine (440.0, 4800, 0.2f);
    core.processBlock (soft.data(), (int) soft.size(), settings);
    CHECK_FALSE (core.lastBlockMeter().clipped);
}

TEST_CASE ("Mosh X-FDBK detects and optionally suppresses a narrowband squeal", "[moshfx][xfeedback]")
{
    auto input = noise (8192);
    auto squeal = sine (2600.0, 8192, 0.35f);
    for (size_t i = 0; i < input.size(); ++i)
        input[i] += squeal[i];

    mosh::moshfx::XFeedbackSettings settings;
    settings.sensitivity = 0.85f;
    settings.maxCuts = 2;
    settings.maxDepthDb = 24.0f;

    const auto candidates = mosh::moshfx::detectFeedbackCandidates (input.data(), (int) input.size(), kSampleRate, settings);
    REQUIRE_FALSE (candidates.empty());
    CHECK (candidates.front().frequencyHz == Catch::Approx (2600.0).margin (80.0));

    std::vector<float> disabled = input;
    mosh::moshfx::XFeedbackCore idle;
    idle.prepare (kSampleRate);
    settings.autoSuppress = false;
    const auto idleState = idle.processBlock (disabled.data(), (int) disabled.size(), settings);
    CHECK (idleState.numActive == 0);
    CHECK (rmsDiff (input, disabled) < 1.0e-6);

    std::vector<float> suppressed = input;
    mosh::moshfx::XFeedbackCore active;
    active.prepare (kSampleRate);
    settings.autoSuppress = true;
    const auto activeState = active.processBlock (suppressed.data(), (int) suppressed.size(), settings);
    REQUIRE (activeState.numActive > 0);
    auto silence = std::vector<float> (2048, 0.0f);
    const auto releasedState = active.processBlock (silence.data(), (int) silence.size(), settings);
    REQUIRE (releasedState.numActive > 0);
    CHECK (releasedState.activeCuts[0].depthDb < activeState.activeCuts[0].depthDb);

    const auto before = mosh::moshfx::goertzelMagnitude (input.data(), (int) input.size(), kSampleRate, 2600.0);
    const auto after = mosh::moshfx::goertzelMagnitude (suppressed.data(), (int) suppressed.size(), kSampleRate, 2600.0);
    CHECK (after < before * 0.45);
    CHECK (peak (suppressed) <= 1.0);
}

TEST_CASE ("Mosh X-FDBK notch state persists across blocks (no per-block reset transient)", "[moshfx][xfeedback]")
{
    // A continuous squeal processed block-by-block. If the notch filter resets its
    // state every block, the start of each block rings up from zero and leaks the
    // tone for the filter's settling time — a periodic transient at the block rate.
    // With persistent state, suppression is uniform across a block.
    const int N = 1024;
    const int blocks = 6;
    auto full = noise (N * blocks);
    auto squeal = sine (2600.0, N * blocks, 0.45f);
    for (size_t i = 0; i < full.size(); ++i)
        full[i] += squeal[i];

    mosh::moshfx::XFeedbackSettings settings;
    settings.sensitivity = 0.9f;
    settings.maxCuts = 1;
    settings.maxDepthDb = 24.0f;
    settings.autoSuppress = true;

    mosh::moshfx::XFeedbackCore core;
    core.prepare (kSampleRate);

    std::vector<float> out (full.begin(), full.end());
    for (int b = 0; b < blocks; ++b)
        core.processBlock (out.data() + (size_t) (b * N), N, settings);

    // Pick a mid-stream block (notch fully converged by now on a correct impl).
    const int base = 3 * N;
    const auto headMag = mosh::moshfx::goertzelMagnitude (out.data() + (size_t) base, 192, kSampleRate, 2600.0);
    const auto midMag = mosh::moshfx::goertzelMagnitude (out.data() + (size_t) (base + 512), 192, kSampleRate, 2600.0);

    // Per-block reset leaks the tone across the head of the block while the notch
    // re-converges; the middle is already suppressed. Persistent state keeps them level.
    CHECK (headMag <= midMag * 2.5);
}
