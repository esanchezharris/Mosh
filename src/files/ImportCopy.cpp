#include "ImportCopy.h"

namespace mosh
{
ImportCopyResult copyIntoImports (const juce::File& source,
                                  const juce::File& importsDirectory)
{
    if (! source.existsAsFile())
        return { {}, "file not found: " + source.getFullPathName(), false };

    if (source == importsDirectory || source.isAChildOf (importsDirectory))
        return { source, {}, false };

    if (! importsDirectory.createDirectory().wasOk())
        return { {}, "could not create the Mosh Imports folder", false };

    const auto extension = source.getFileExtension();
    const auto baseName = juce::File::createLegalFileName (
        source.getFileNameWithoutExtension());
    const auto destination = importsDirectory.getNonexistentChildFile (
        baseName, extension, false);
    if (! source.copyFileTo (destination))
        return { {}, "could not copy the selected file into Mosh Imports", false };

    return { destination, {}, true };
}
}
