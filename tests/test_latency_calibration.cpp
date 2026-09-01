// Measured round-trip latency calibration — the engine-free proofs.
//
// Ported from Moshpit tests/unit/LatencyCalibrationTests.cpp and
// CalibrationLifecycleTests.cpp (commit af8b6b7) into Catch2. Three things
// are pinned here: the detector finds a known offset and REFUSES the cases
// where a wrong number would be worse than none; the session lifecycle never
// leaves a callback registered (quit / reload / device-change shapes); and
// the record maths that decide what Tracktion is told.

#include <catch2/catch_test_macros.hpp>

#include "audio/LatencyCalibration.h"
#include "audio/LatencyCalibrationSession.h"
#include "engine/LatencyCalibrationRecord.h"

#include <algorithm>
#include <cstdlib>
#include <deque>
#include <vector>

using namespace mosh::latency;

namespace
{
std::vector<float> makeStimulus (int frames, double rate)
{
    std::vector<float> data ((std::size_t) frames, 0.0f);
    renderCalibrationStimulus (data.data(), frames, rate);
    return data;
}
} // namespace

TEST_CASE ("latency detector finds a known offset and refuses bad captures", "[latency]")
{
    constexpr auto rate = 8000.0; // small rate keeps the O(N*M) test fast
    const auto stimulusFrames = (int) (rate / 2.0);
    const auto burst = makeStimulus (stimulusFrames, rate);

    SECTION ("the stimulus is nonzero and deterministic")
    {
        auto energy = 0.0;
        for (const auto value : burst)
            energy += double (value) * double (value);
        CHECK (energy > 100.0);
        CHECK (makeStimulus (stimulusFrames, rate) == burst);
    }

    SECTION ("known offsets are detected within two frames under attenuation")
    {
        for (const auto offset : { std::int64_t (0), std::int64_t (411), std::int64_t (1601) })
        {
            std::vector<float> captured ((std::size_t) (rate * 1.6), 0.0f);
            for (int i = 0; i < stimulusFrames; ++i)
                captured[(std::size_t) (offset + i)] += 0.31f * burst[(std::size_t) i];
            const auto measured = measureRoundTripOffset (burst.data(), stimulusFrames,
                                                          captured.data(), (int) captured.size(), rate);
            INFO ("offset " << offset << ": " << measured.error.toStdString());
            REQUIRE (measured.succeeded());
            // Tolerance BELOW the coarse stride (8) so a coarse/fine-seam
            // mis-refinement cannot hide.
            CHECK (std::abs (measured.value->frames - offset) <= 2);
            CHECK (measured.value->confidence > 0.0);
            CHECK (measured.value->confidence <= 1.0);
        }
    }

    SECTION ("silence is refused loudly")
    {
        std::vector<float> silent ((std::size_t) (rate * 1.6), 0.0f);
        const auto refused = measureRoundTripOffset (burst.data(), stimulusFrames,
                                                     silent.data(), (int) silent.size(), rate);
        CHECK_FALSE (refused.succeeded());
        CHECK (refused.error.isNotEmpty());
    }

    SECTION ("an equal-strength distinct echo is refused as ambiguous")
    {
        std::vector<float> echoed ((std::size_t) (rate * 1.6), 0.0f);
        for (int i = 0; i < stimulusFrames; ++i)
        {
            echoed[(std::size_t) (200 + i)] += 0.3f * burst[(std::size_t) i];
            echoed[(std::size_t) (200 + (std::int64_t) (rate * 0.2) + i)] += 0.3f * burst[(std::size_t) i];
        }
        const auto refused = measureRoundTripOffset (burst.data(), stimulusFrames,
                                                     echoed.data(), (int) echoed.size(), rate);
        CHECK_FALSE (refused.succeeded());
    }

    SECTION ("an offset beyond one second is refused")
    {
        std::vector<float> late ((std::size_t) (rate * 1.6), 0.0f);
        const auto lateAt = (std::int64_t) (rate * 1.05);
        for (int i = 0; i < stimulusFrames && lateAt + i < (std::int64_t) late.size(); ++i)
            late[(std::size_t) (lateAt + i)] += 0.3f * burst[(std::size_t) i];
        const auto refused = measureRoundTripOffset (burst.data(), stimulusFrames,
                                                     late.data(), (int) late.size(), rate);
        CHECK_FALSE (refused.succeeded());
    }

    SECTION ("malformed inputs are refused, never dereferenced")
    {
        CHECK_FALSE (measureRoundTripOffset (nullptr, stimulusFrames, burst.data(), 100, rate).succeeded());
        CHECK_FALSE (measureRoundTripOffset (burst.data(), stimulusFrames, burst.data(),
                                             stimulusFrames, rate).succeeded());
        CHECK_FALSE (measureRoundTripOffset (burst.data(), stimulusFrames, burst.data(),
                                             stimulusFrames + 10, 0.0).succeeded());
    }
}

namespace
{
struct FakeRegistrar final : public AudioCallbackRegistrar
{
    int adds = 0;
    int removes = 0;
    std::vector<juce::AudioIODeviceCallback*> active;

    void add (juce::AudioIODeviceCallback* callback) override
    {
        ++adds;
        active.push_back (callback);
    }

    void remove (juce::AudioIODeviceCallback* callback) override
    {
        ++removes;
        active.erase (std::remove (active.begin(), active.end(), callback), active.end());
    }
};
} // namespace

TEST_CASE ("calibration session never leaves a callback registered", "[latency]")
{
    SECTION ("destruction deregisters an in-flight calibration (quit)")
    {
        FakeRegistrar registrar;
        {
            CalibrationSession session (registrar);
            REQUIRE (session.start (8000.0));
            CHECK (session.running());
            CHECK (registrar.adds == 1);
            CHECK (registrar.active.size() == 1);
        }
        CHECK (registrar.removes == 1);
        CHECK (registrar.active.empty());
    }

    SECTION ("cancel deregisters and is idempotent (reload / device change)")
    {
        FakeRegistrar registrar;
        CalibrationSession session (registrar);
        REQUIRE (session.start (8000.0));
        session.cancel();
        CHECK_FALSE (session.running());
        CHECK (registrar.active.empty());
        session.cancel();
        CHECK (registrar.adds == 1);
        CHECK (registrar.removes == 1);
    }

    SECTION ("a second start while running is refused")
    {
        FakeRegistrar registrar;
        CalibrationSession session (registrar);
        REQUIRE (session.start (8000.0));
        CHECK_FALSE (session.start (8000.0));
        CHECK (registrar.adds == 1);
        session.cancel();
    }

    SECTION ("completion deregisters and reports loudly on silence")
    {
        FakeRegistrar registrar;
        CalibrationSession session (registrar);
        REQUIRE (session.start (8000.0));
        CHECK_FALSE (session.pollFinished().has_value());

        float left[512] {};
        float right[512] {};
        float* outputs[2] = { left, right };
        juce::AudioIODeviceCallbackContext context {};
        std::optional<CalibrationResult> outcome;
        for (int i = 0; i < 4096 && ! outcome.has_value(); ++i)
        {
            REQUIRE_FALSE (registrar.active.empty());
            registrar.active.front()->audioDeviceIOCallbackWithContext (nullptr, 0, outputs, 2, 512, context);
            outcome = session.pollFinished();
        }
        REQUIRE (outcome.has_value());
        CHECK_FALSE (outcome->succeeded());
        CHECK (registrar.active.empty());
        CHECK (registrar.adds == registrar.removes);
        CHECK_FALSE (session.running());
    }

    SECTION ("a synthetic loopback through the runner measures the round trip")
    {
        // Feed the runner's own output back as its input through a FIFO delay line:
        // a sample emitted at time t arrives at the input at t + delay. The session
        // must report exactly `delay` — the preroll is the runner's business, not the
        // caller's. `delay` exceeds the block size so a block's input is always fully
        // available before that block writes its output (the FIFO never underflows).
        constexpr auto rate = 8000.0;
        constexpr int block = 256;
        constexpr int delay = 333;
        FakeRegistrar registrar;
        CalibrationSession session (registrar);
        REQUIRE (session.start (rate));

        std::deque<float> line ((std::size_t) delay, 0.0f);   // the "room"
        float out[block] {};
        float in[block] {};
        float* outputs[1] = { out };
        const float* inputs[1] = { in };
        juce::AudioIODeviceCallbackContext context {};
        std::optional<CalibrationResult> outcome;
        for (int b = 0; b < 100000 && ! outcome.has_value(); ++b)
        {
            for (int f = 0; f < block; ++f)
            {
                in[f] = line.front();
                line.pop_front();
            }
            registrar.active.front()->audioDeviceIOCallbackWithContext (inputs, 1, outputs, 1, block, context);
            for (int f = 0; f < block; ++f)
                line.push_back (0.4f * out[f]);
            outcome = session.pollFinished();
        }
        REQUIRE (outcome.has_value());
        INFO (outcome->error.toStdString());
        REQUIRE (outcome->succeeded());
        CHECK (std::abs (outcome->value->frames - delay) <= 2);
    }
}

TEST_CASE ("calibration record maths decide what Tracktion is told", "[latency]")
{
    CalibrationRecord r;
    r.frames = 2400;          // 50 ms at 48 kHz
    r.sampleRate = 48000.0;
    r.confidence = 0.9;
    r.inputDevice = "Scarlett";
    r.outputDevice = "Scarlett";

    SECTION ("milliseconds derive from frames at the measured rate")
    {
        CHECK (r.milliseconds() == 50.0);
    }

    SECTION ("the residual subtracts what the device already reports")
    {
        CHECK (residualMs (r, 0) == 50.0);
        CHECK (residualMs (r, 480) == 40.0);           // device reports 10 ms
        CHECK (residualMs (r, 2400) == 0.0);           // device is exactly right
        CHECK (residualMs (r, 4800) == -50.0);         // device over-reports
        CalibrationRecord huge = r;
        huge.frames = 48000 * 2;                       // 2 s, beyond the band
        CHECK (residualMs (huge, 0) == CalibrationRecord::kMaxAdjustmentMs);
    }

    SECTION ("a record is honoured only at its rate on its device pair")
    {
        CHECK (isHonored (r, 48000.0, "Scarlett", "Scarlett"));
        CHECK (isHonored (r, 48000.2, "Scarlett", "Scarlett"));
        CHECK_FALSE (isHonored (r, 44100.0, "Scarlett", "Scarlett"));
        CHECK_FALSE (isHonored (r, 48000.0, "Built-in Microphone", "Scarlett"));
        CHECK_FALSE (isHonored (r, 48000.0, "Scarlett", "Built-in Output"));
        CalibrationRecord anonymous = r;
        anonymous.inputDevice.clear();
        anonymous.outputDevice.clear();
        CHECK (isHonored (anonymous, 48000.0, "Anything", "Anything"));
        CHECK_FALSE (isHonored (r, 0.0, "Scarlett", "Scarlett"));
    }

    SECTION ("round-trips through var and fails closed on junk")
    {
        const auto v = r.toVar();
        const auto back = CalibrationRecord::fromVar (v);
        REQUIRE (back.has_value());
        CHECK (back->frames == r.frames);
        CHECK (back->sampleRate == r.sampleRate);
        CHECK (back->confidence == r.confidence);
        CHECK (back->inputDevice == r.inputDevice);
        CHECK (back->method == "farina-sweep-v1");

        CHECK_FALSE (CalibrationRecord::fromVar (juce::var()).has_value());
        CHECK_FALSE (CalibrationRecord::fromVar (juce::var ("nope")).has_value());
        CHECK_FALSE (CalibrationRecord::fromVar (juce::JSON::parse ("{}")).has_value());
        CHECK_FALSE (CalibrationRecord::fromVar (juce::JSON::parse ("{\"frames\":-1,\"sampleRate\":48000}")).has_value());
        CHECK_FALSE (CalibrationRecord::fromVar (juce::JSON::parse ("{\"frames\":10,\"sampleRate\":0}")).has_value());
        CHECK_FALSE (CalibrationRecord::fromVar (juce::JSON::parse ("{\"frames\":10,\"sampleRate\":48000,\"confidence\":7}")).has_value());
        // Beyond the ±500 ms band Tracktion accepts.
        CHECK_FALSE (CalibrationRecord::fromVar (juce::JSON::parse ("{\"frames\":96000,\"sampleRate\":48000}")).has_value());
        // A persisted JSON string round-trips (the on-disk shape).
        const auto parsed = CalibrationRecord::fromVar (juce::JSON::parse (juce::JSON::toString (v)));
        REQUIRE (parsed.has_value());
        CHECK (parsed->frames == 2400);
    }
}
