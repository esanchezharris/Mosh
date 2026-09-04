#pragma once

#include <juce_core/juce_core.h>

namespace mosh
{
struct ImportCopyResult
{
    juce::File file;
    juce::String error;
    bool copied = false;
};

ImportCopyResult copyIntoImports (const juce::File& source,
                                  const juce::File& importsDirectory);
}
