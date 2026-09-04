#pragma once

#include <juce_core/juce_core.h>

namespace mosh
{
struct SampleFolderRecord
{
    juce::String name;
    juce::String path;
    juce::String bookmark;
};

class SampleFolderStore
{
public:
    explicit SampleFolderStore (juce::File storageFileToUse);

    juce::Array<SampleFolderRecord> records() const;
    juce::Result remember (const juce::File& directory,
                           const juce::String& bookmark) const;

private:
    juce::File storageFile;
};
}
