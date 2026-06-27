#pragma once

#include <array>
#include <vector>

namespace mosh::moshfx
{

enum class ScaleKind
{
    chromatic = 0,
    major = 1,
    minor = 2
};

struct PitchAnalysis
{
    double frequencyHz = 0.0;
    double confidence = 0.0;
    double rms = 0.0;
    bool voiced = false;
};

struct AutoTuneSettings
{
    int rootSemitone = 0;
    ScaleKind scale = ScaleKind::chromatic;
    float retuneMs = 80.0f;
    float amount = 0.35f;
    float maxCorrectionCents = 100.0f;
    float minHz = 80.0f;
    float maxHz = 900.0f;
    float mix = 1.0f;
    float outputDb = 0.0f;
};

struct AutoTuneResult
{
    PitchAnalysis input;
    double targetFrequencyHz = 0.0;
    double correctionCents = 0.0;
    bool corrected = false;
};

PitchAnalysis estimateMonophonicPitch (const float* samples, int numSamples, double sampleRate,
                                       double minHz = 80.0, double maxHz = 900.0);
double nearestScaleFrequency (double frequencyHz, int rootSemitone, ScaleKind scale);
double retuneCoefficient (double blockSeconds, float retuneMs);
AutoTuneResult analyseAutoTuneBlock (const float* input, int numSamples,
                                     double sampleRate, const AutoTuneSettings& settings);
AutoTuneResult processAutoTuneBlock (const std::vector<float>& input, std::vector<float>& output,
                                     double sampleRate, const AutoTuneSettings& settings);
AutoTuneResult processAutoTuneBlock (const float* input, float* output, int numSamples,
                                     double sampleRate, const AutoTuneSettings& settings);

struct OTTSettings
{
    float amount = 0.12f;
    float timeMs = 120.0f;
    float upward = 0.25f;
    float downward = 0.35f;
    float lowGainDb = 0.0f;
    float midGainDb = 0.0f;
    float highGainDb = 0.0f;
    float mix = 1.0f;
    float outputDb = -1.0f;
};

class OTTCore
{
public:
    void prepare (double newSampleRate);
    void reset();
    void processBlock (float* samples, int numSamples, const OTTSettings& settings);

private:
    double sampleRate = 48000.0;
    float lowState = 0.0f;
    float highLpState = 0.0f;
    float lowEnv = 0.0f;
    float midEnv = 0.0f;
    float highEnv = 0.0f;
};

struct FeedbackCandidate
{
    double frequencyHz = 0.0;
    float score = 0.0f;
    float depthDb = 0.0f;
};

struct XFeedbackSettings
{
    float sensitivity = 0.65f;
    int maxCuts = 2;
    float maxDepthDb = 18.0f;
    float releaseMs = 500.0f;
    bool autoSuppress = false;
    float mix = 1.0f;
    float outputDb = 0.0f;
    float minHz = 250.0f;
    float maxHz = 10000.0f;
};

// Fixed-capacity (max 4 cuts) so processBlock returns by value with no heap allocation.
struct XFeedbackState
{
    std::array<FeedbackCandidate, 4> candidates {};
    int numCandidates = 0;
    std::array<FeedbackCandidate, 4> activeCuts {};
    int numActive = 0;
};

// Persistent biquad-notch state so the filter is not re-zeroed every block.
struct NotchState
{
    double x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0;
    double frequencyHz = 0.0;
};

double goertzelMagnitude (const float* samples, int numSamples, double sampleRate, double frequencyHz);

// RT-safe: writes up to maxOut candidates into out[] and returns the count. Allocation-free.
int detectFeedbackCandidates (const float* samples, int numSamples, double sampleRate,
                              const XFeedbackSettings& settings, FeedbackCandidate* out, int maxOut);
// Convenience overload for off-audio-thread callers (preview readout, tests).
std::vector<FeedbackCandidate> detectFeedbackCandidates (const float* samples, int numSamples,
                                                         double sampleRate, const XFeedbackSettings& settings);

class XFeedbackCore
{
public:
    void prepare (double newSampleRate);
    void reset();
    XFeedbackState processBlock (float* samples, int numSamples, const XFeedbackSettings& settings);

private:
    double sampleRate = 48000.0;
    std::array<FeedbackCandidate, 4> activeCuts {};
    int numActiveCuts = 0;
    std::array<NotchState, 4> notches {};
};

}
