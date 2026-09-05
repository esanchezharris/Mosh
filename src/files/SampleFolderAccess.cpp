#include "SampleFolderAccess.h"

#include "SampleFolderStore.h"

#if JUCE_MAC
 #include "MacFileBookmark.h"
#endif

namespace mosh
{
namespace
{
SampleFolderStore store()
{
    return SampleFolderStore (
        juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
            .getChildFile ("Mosh/sample-folders.json"));
}
}

juce::Array<juce::File> sampleFolderPlaces()
{
    juce::Array<juce::File> result;
    for (const auto& record : store().records())
    {
        juce::File resolved;
       #if JUCE_MAC
        if (record.bookmark.isNotEmpty())
            resolved = mac::resolveFileBookmark (record.bookmark);
       #endif
        if (resolved == juce::File())
            resolved = juce::File (record.path);
        result.addIfNotAlreadyThere (resolved);
    }
    return result;
}

juce::Result rememberSampleFolder (const juce::File& directory)
{
    if (! directory.isDirectory())
        return juce::Result::fail ("the selected item is not a folder");

    juce::String bookmark;
   #if JUCE_MAC
    juce::String error;
    bookmark = mac::createFileBookmark (directory, error);
    if (bookmark.isEmpty())
        return juce::Result::fail (error);
   #endif
    return store().remember (directory, bookmark);
}
}
