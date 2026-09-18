#include <catch2/catch_test_macros.hpp>
#include "moshops/PluginParameterReadback.h"

namespace
{
struct ParameterText
{
    juce::String text, label;
    juce::String getCurrentValueAsString() { return text; }
    juce::String getLabel() { return label; }
};
}

TEST_CASE ("parameter readback omits unavailable metadata", "[parameter-readback]")
{
    ParameterText parameter { {}, {} };
    juce::DynamicObject result;
    mosh::addPluginParameterReadback (result, parameter);
    CHECK_FALSE (result.hasProperty ("display"));
    CHECK_FALSE (result.hasProperty ("unit"));
    CHECK_FALSE (result.hasProperty ("min"));
    CHECK_FALSE (result.hasProperty ("max"));
}

TEST_CASE ("parameter readback does not invent a value from a label", "[parameter-readback]")
{
    ParameterText parameter { {}, "Hz" };
    juce::DynamicObject result;
    mosh::addPluginParameterReadback (result, parameter);
    CHECK_FALSE (result.hasProperty ("display"));
    CHECK (result.getProperty ("unit").toString() == "Hz");
}

TEST_CASE ("parameter readback preserves formatted text without a separate unit", "[parameter-readback]")
{
    ParameterText parameter { "180 Hz", {} };
    juce::DynamicObject result;
    mosh::addPluginParameterReadback (result, parameter, juce::Range<float> (10.0f, 22000.0f));
    CHECK (result.getProperty ("display").toString() == "180 Hz");
    CHECK_FALSE (result.hasProperty ("unit"));
    CHECK ((double) result.getProperty ("min") == 10.0);
    CHECK ((double) result.getProperty ("max") == 22000.0);
}

TEST_CASE ("parameter readback appends the host label once", "[parameter-readback]")
{
    ParameterText parameter { "-18.0", "dB" };
    SECTION ("separate label") {}
    SECTION ("label already in text") { parameter.text = "-18.0 dB"; }
    juce::DynamicObject result;
    mosh::addPluginParameterReadback (result, parameter);
    CHECK (result.getProperty ("display").toString() == "-18.0 dB");
    CHECK (result.getProperty ("unit").toString() == "dB");
    CHECK_FALSE (result.hasProperty ("min"));
    CHECK_FALSE (result.hasProperty ("max"));
}

TEST_CASE ("parameter readback never derives physical limits from display text", "[parameter-readback]")
{
    ParameterText parameter { "-6.0 dB", {} };
    juce::DynamicObject result;
    mosh::addPluginParameterReadback (result, parameter);
    CHECK (result.getProperty ("display").toString() == "-6.0 dB");
    CHECK_FALSE (result.hasProperty ("min"));
    CHECK_FALSE (result.hasProperty ("max"));
}

TEST_CASE ("parameter readback uses the parameter formatter for nonlinear values", "[parameter-readback]")
{
    struct NonlinearParameter
    {
        juce::NormalisableRange<float> range {
            10.0f, 1010.0f,
            [] (float start, float end, float norm) { return start + (end - start) * norm * norm; },
            [] (float start, float end, float raw) { return std::sqrt ((raw - start) / (end - start)); }
        };
        float current = range.convertFrom0to1 (0.5f);
        juce::String getCurrentValueAsString() { return juce::String (current, 0); }
        juce::String getLabel() { return "Hz"; }
    } parameter;
    juce::DynamicObject result;
    mosh::addPluginParameterReadback (result, parameter, parameter.range.getRange());
    // The fixture's square mapping gives 260 Hz at 0.5; endpoint interpolation gives 510.
    CHECK (result.getProperty ("display").toString() == "260 Hz");
    CHECK ((double) result.getProperty ("min") == 10.0);
    CHECK ((double) result.getProperty ("max") == 1010.0);
}
