#include "MoshDelayLinePlugins.h"

#include <cmath>

namespace mosh
{
namespace
{
// Samples of margin above the ceiling: the scaled rate is rounded back by the base.
constexpr double kMarginSamples = 4.0;
}

double MoshDelayPlugin::sizingRate (double sampleRate, int lengthMs) noexcept
{
    if (lengthMs <= 0 || ! (sampleRate > 0.0))
        return sampleRate;
    const int ceilingMs = juce::jmax (kMaxLengthMs, lengthMs);
    const double wanted = std::ceil (ceilingMs * sampleRate / 1000.0) + kMarginSamples;
    return wanted * 1000.0 / lengthMs;
}

void MoshDelayPlugin::initialise (const te::PluginInitialisationInfo& info)
{
    auto sizing = info;
    sizing.sampleRate = sizingRate (info.sampleRate, lengthMs.get());
    te::DelayPlugin::initialise (sizing);
}

int MoshChorusPlugin::lineLengthMs (float depthMs) noexcept
{
    const float delayMs = 20.0f;   // te::ChorusPlugin's fixed base delay
    return 1 + juce::roundToInt (delayMs + depthMs);
}

double MoshChorusPlugin::sizingRate (double sampleRate, float depthMs) noexcept
{
    const int current = lineLengthMs (depthMs);
    if (current <= 0 || ! (sampleRate > 0.0))
        return sampleRate;
    const int ceilingMs = juce::jmax (lineLengthMs (kMaxDepthMs), current);
    const double wanted = std::ceil (ceilingMs * sampleRate / 1000.0) + kMarginSamples;
    return wanted * 1000.0 / current;
}

void MoshChorusPlugin::initialise (const te::PluginInitialisationInfo& info)
{
    auto sizing = info;
    sizing.sampleRate = sizingRate (info.sampleRate, depthMs.get());
    te::ChorusPlugin::initialise (sizing);
}
}
