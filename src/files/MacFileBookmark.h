#pragma once

#include <juce_core/juce_core.h>

namespace mosh::mac
{
juce::String createFileBookmark (const juce::File& file, juce::String& error);
juce::File resolveFileBookmark (const juce::String& bookmark);
}
