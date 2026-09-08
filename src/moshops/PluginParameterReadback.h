#pragma once

#include <juce_core/juce_core.h>
#include <optional>

namespace mosh
{
template <typename Parameter>
void addPluginParameterReadback (juce::DynamicObject& result, Parameter& parameter,
                                std::optional<juce::Range<float>> physicalRange = std::nullopt)
{
    auto text = parameter.getCurrentValueAsString();
    const auto label = parameter.getLabel();
    if (text.isNotEmpty())
    {
        if (label.isNotEmpty() && ! text.endsWith (label))
            text += " " + label;
        result.setProperty ("display", text);
    }
    if (label.isNotEmpty())
        result.setProperty ("unit", label);
    if (physicalRange.has_value())
    {
        result.setProperty ("min", physicalRange->getStart());
        result.setProperty ("max", physicalRange->getEnd());
    }
}
}
