#pragma once

#include <juce_core/juce_core.h>
#include <optional>

namespace mosh::ui_resource_guard
{
std::optional<juce::String> normalisePath (const juce::String& url);
bool isSafePath (const juce::String& url);
bool isSafePath (const juce::File& uiDir, const juce::String& url);
}
