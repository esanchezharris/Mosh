#pragma once

#include <array>
#include <vector>

namespace mosh::moshfx
{

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

    // What the last processBlock did, for the live meter (MoshOTTPlugin publishes it on
    // the audio thread right after processing; nothing here allocates or locks).
    // Bands are { low, mid, high }.
    struct BlockMeter
    {
        // True when the band dynamics ran. False for an Amount of 0 (the block was only
        // trimmed and limited): the envelopes did not move, so there is no band level.
        bool dynamicsRan = false;
        // The largest band envelope during the block (linear, as the detector sees it).
        std::array<float, 3> peakEnvelope {};
        // Each band's dynamic gain change at the end of the block in dB, EXCLUDING the
        // band's static Low/Mid/High Gain trim: positive is upward lift, negative a cut.
        std::array<float, 3> gainDb {};
        // The output clamp (softLimit, +-0.999) engaged on at least one sample.
        bool clipped = false;
    };
    const BlockMeter& lastBlockMeter() const noexcept { return meter; }

private:
    BlockMeter meter;
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
