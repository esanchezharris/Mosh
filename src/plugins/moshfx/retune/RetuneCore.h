#pragma once

#include "PitchTracker.h"
#include "SpliceShifter.h"
#include "TuneCorrection.h"

#include <vector>

// Mosh AutoTune's mono engine (docs/AUTOTUNE-SCOPE-2026-10-01.md §4): pitch
// tracker -> correction decision -> splice shifter, with a latency-matched dry
// path for Mix. JUCE-free. Control lands at the tracker's hop boundaries, which
// are anchored to the absolute sample count, so any chunking of the same input
// and settings yields bit-identical output.

namespace mosh::moshfx::retune
{
struct RetuneSettings
{
    int rootSemitone = 0;              // 0 = C
    int scale = 0;                     // 0 chromatic, 1 major, 2 minor
    float retuneMs = 80.0f;            // at or below kHardRetuneMs means hard tune
    float amount = 1.0f;               // 0..1
    float maxCorrectionCents = 100.0f; // cap on the correction
    float glide = 1.0f;                // 0 snaps onto each new note, 1 eases in
    float mix = 1.0f;                  // 0 dry .. 1 wet (dry is delayed by the latency)
    float outputDb = 0.0f;
};

struct RetuneReadout
{
    double inputHz = 0.0;  // 0 while unvoiced
    double targetHz = 0.0; // 0 while unvoiced
    double correctionCents = 0.0;
    float confidence = 0.0f;
    bool voiced = false;
};

class RetuneCore
{
public:
    // The bottom of the plugin's Retune knob.
    static constexpr float kHardRetuneMs = 5.0f;
    // The top of the plugin's Look-ahead knob. Measured on eleven real vocals, hard
    // tune lands closest to the grid at about 12 ms; beyond that the correction
    // runs ahead of the audio and gets worse again.
    static constexpr float kMaxLookaheadMs = 12.0f;

    // Allocates; never call on the audio thread. Returns false for an unusable rate.
    // Look-ahead starts at zero.
    bool prepare (double sampleRate);
    void reset();

    // Delays the audio into the shifter so each correction is decided from pitch
    // that is as new as the audio it corrects: tighter tuning for added latency.
    // Safe on the audio thread (no allocation); a change clears the audio path.
    void setLookaheadMs (float ms) noexcept;

    // The shifter's own latency plus the look-ahead. Changes only in
    // setLookaheadMs().
    [[nodiscard]] int latencySamples() const noexcept { return latency; }

    // What latencySamples() will be at a rate and look-ahead, without preparing.
    [[nodiscard]] static int latencySamplesFor (double sampleRate, float lookaheadMs);

    // In place. No allocation, locks, logging or IO.
    RetuneReadout process (float* mono, int numSamples, const RetuneSettings& settings);

    // For tests and tooling only.
    [[nodiscard]] const SpliceShifter& shifterForDiagnostics() const noexcept { return shifter; }

private:
    double rate = 0.0;
    int latency = 0;        // shifterLatency + lookahead
    int shifterLatency = 0;
    int lookahead = 0;
    int maxLookahead = 0;
    PitchTracker tracker;
    TuneCorrection correction;
    SpliceShifter shifter;
    std::vector<float> analysis; // the untouched input for the tracker and dry path
    std::vector<float> dryRing; // input history: feeds the look-ahead and the dry path
    int dryMask = 0;
    int dryWrite = 0;
    double heldPeriod = 0.0; // the last voiced period, kept through short dropouts
    RetuneReadout readout;
};

// A plain integer delay, for keeping a stereo side signal aligned with the
// retuned mid.
class SampleDelay
{
public:
    void prepare (int maxDelaySamples);       // allocates; delay starts at zero
    void setDelay (int delaySamples) noexcept; // no allocation; a change clears the line
    void reset() noexcept;
    void process (float* samples, int numSamples);

private:
    std::vector<float> ring;
    int mask = 0;
    int write = 0;
    int delay = 0;
};
}
