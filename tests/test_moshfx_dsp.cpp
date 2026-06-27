#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "plugins/moshfx/MoshFxDsp.h"

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

// These drive mosh::moshfx::AutoTuneCore — the SAME stateful sine-resynthesis
// core the live plugin runs (MoshAutoTunePlugin::applyToBuffer), so the green
// tests actually cover production. (The old [autotune] tests exercised a
// divergent linear-resampler free function the plugin never called.)

TEST_CASE ("Mosh AutoTune core pulls a near-note sine toward the scale target", "[moshfx][autotune]")
{
    auto input = sine (448.985916, 8192);
    std::vector<float> output (input);

    mosh::moshfx::AutoTuneSettings settings;
    settings.rootSemitone = 0;
    settings.scale = mosh::moshfx::ScaleKind::chromatic;
    settings.retuneMs = 5.0f;
    settings.amount = 1.0f;
    settings.maxCorrectionCents = 100.0f;
    settings.mix = 1.0f;

    const auto before = mosh::moshfx::estimateMonophonicPitch (input.data(), (int) input.size(), kSampleRate);

    mosh::moshfx::AutoTuneCore core;
    core.prepare (kSampleRate);
    const auto result = core.processBlock (output.data(), (int) output.size(), settings);

    const auto after = mosh::moshfx::estimateMonophonicPitch (output.data(), (int) output.size(), kSampleRate);

    REQUIRE (before.voiced);
    REQUIRE (result.corrected);
    REQUIRE (after.voiced);
    CHECK (std::abs (after.frequencyHz - 440.0) < std::abs (before.frequencyHz - 440.0));
    CHECK (after.frequencyHz == Catch::Approx (440.0).margin (4.0));
}

TEST_CASE ("Mosh AutoTune leaves low-confidence noise stable", "[moshfx][autotune]")
{
    auto input = noise (8192);
    std::vector<float> output (input);

    mosh::moshfx::AutoTuneSettings settings;
    settings.amount = 1.0f;
    settings.mix = 1.0f;

    mosh::moshfx::AutoTuneCore core;
    core.prepare (kSampleRate);
    const auto result = core.processBlock (output.data(), (int) output.size(), settings);

    CHECK_FALSE (result.corrected);
    REQUIRE (output.size() == input.size());
    CHECK (rmsDiff (input, output) < 1.0e-6);
}

TEST_CASE ("Mosh AutoTune retune time changes correction speed", "[moshfx][autotune]")
{
    auto input = sine (448.985916, 4096);

    mosh::moshfx::AutoTuneSettings settings;
    settings.amount = 1.0f;
    settings.maxCorrectionCents = 100.0f;
    settings.mix = 1.0f;

    std::vector<float> fast (input);
    settings.retuneMs = 5.0f;
    mosh::moshfx::AutoTuneCore fastCore;
    fastCore.prepare (kSampleRate);
    const auto fastResult = fastCore.processBlock (fast.data(), (int) fast.size(), settings);

    std::vector<float> slow (input);
    settings.retuneMs = 250.0f;
    mosh::moshfx::AutoTuneCore slowCore;
    slowCore.prepare (kSampleRate);
    const auto slowResult = slowCore.processBlock (slow.data(), (int) slow.size(), settings);

    REQUIRE (fastResult.corrected);
    REQUIRE (slowResult.corrected);
    CHECK (std::abs (fastResult.correctionCents) > std::abs (slowResult.correctionCents) * 3.0);

    // A faster retune pulls the synthesized pitch closer to the 440 Hz target
    // within the same single block.
    const auto fastPitch = mosh::moshfx::estimateMonophonicPitch (fast.data(), (int) fast.size(), kSampleRate);
    const auto slowPitch = mosh::moshfx::estimateMonophonicPitch (slow.data(), (int) slow.size(), kSampleRate);
    CHECK (std::abs (fastPitch.frequencyHz - 440.0) < std::abs (slowPitch.frequencyHz - 440.0));
}

TEST_CASE ("Mosh AutoTune corrects the whole block past 8192 samples", "[moshfx][autotune]")
{
    // An offline render can hand the plugin a single block longer than 8192
    // samples. The entire block must be corrected — not just the first 8192,
    // with the tail left as the unprocessed (un-gained, un-tuned) dry signal.
    const int n = 12000;
    auto input = sine (448.985916, n);
    std::vector<float> output (input);

    mosh::moshfx::AutoTuneSettings settings;
    settings.scale = mosh::moshfx::ScaleKind::chromatic;
    settings.retuneMs = 5.0f;
    settings.amount = 1.0f;
    settings.maxCorrectionCents = 100.0f;
    settings.mix = 1.0f;

    mosh::moshfx::AutoTuneCore core;
    core.prepare (kSampleRate);
    core.processBlock (output.data(), n, settings);

    // The tail [8192, n) must be pulled toward 440 too. Under the old cap it
    // passed through as the original ~449 Hz.
    const int tailStart = 8192;
    const auto tail = mosh::moshfx::estimateMonophonicPitch (output.data() + tailStart,
                                                             n - tailStart, kSampleRate);
    REQUIRE (tail.voiced);
    CHECK (tail.frequencyHz == Catch::Approx (440.0).margin (4.0));
}

TEST_CASE ("Mosh AutoTune fades the synth out across a voiced boundary (no pop)", "[moshfx][autotune]")
{
    // When a voiced phrase ends, the resynthesized tone must fade out instead of
    // snapping to silence — a hard cut on the voiced->unvoiced transition is an
    // audible click. After several voiced blocks (synth fully engaged), the first
    // slice of the following unvoiced (silent) block must still carry the decaying
    // tone; a hard cut leaves it at ~0.
    mosh::moshfx::AutoTuneSettings settings;
    settings.scale = mosh::moshfx::ScaleKind::chromatic;
    settings.retuneMs = 5.0f;
    settings.amount = 1.0f;
    settings.maxCorrectionCents = 100.0f;
    settings.mix = 1.0f;

    mosh::moshfx::AutoTuneCore core;
    core.prepare (kSampleRate);

    const int block = 2048;
    for (int b = 0; b < 4; ++b)
    {
        auto voiced = sine (448.985916, block);
        core.processBlock (voiced.data(), block, settings);
    }

    std::vector<float> silent (block, 0.0f);   // unvoiced -> synth should fade, not cut
    core.processBlock (silent.data(), block, settings);

    auto sliceRms = [] (const float* d, int count)
    {
        double s = 0.0;
        for (int i = 0; i < count; ++i)
            s += (double) d[i] * (double) d[i];
        return std::sqrt (s / (double) count);
    };

    const auto head = sliceRms (silent.data(), 64);     // ~1.3 ms after the boundary
    const auto bodyEnd = sliceRms (silent.data() + block - 64, 64);
    CHECK (head > 0.05);            // tone still present right after the boundary
    CHECK (bodyEnd < head * 0.5);   // and it has decayed away by the end of the block
}

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
