#pragma once

#include <juce_core/juce_core.h>

namespace mosh
{
juce::Array<juce::File> sampleFolderPlaces();

juce::Result rememberSampleFolder (const juce::File& directory);
}
