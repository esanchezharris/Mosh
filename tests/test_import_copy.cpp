#include <catch2/catch_test_macros.hpp>

#include "files/ImportCopy.h"

TEST_CASE ("external audio imports are copied into Mosh-owned storage")
{
    const auto temp = juce::File::getSpecialLocation (juce::File::tempDirectory)
        .getNonexistentChildFile ("mosh-import-copy", {}, false);
    const auto sourceDir = temp.getChildFile ("source");
    const auto imports = temp.getChildFile ("session/imports");
    REQUIRE (sourceDir.createDirectory().wasOk());
    REQUIRE (imports.createDirectory().wasOk());
    const auto source = sourceDir.getChildFile ("loop.wav");
    REQUIRE (source.replaceWithText ("audio fixture"));

    struct Cleanup
    {
        juce::File directory;
        ~Cleanup() { directory.deleteRecursively(); }
    } cleanup { temp };

    const auto first = mosh::copyIntoImports (source, imports);
    REQUIRE (first.error.isEmpty());
    CHECK (first.file.getParentDirectory() == imports);
    CHECK (first.file.loadFileAsString() == "audio fixture");
    CHECK (source.existsAsFile());

    const auto second = mosh::copyIntoImports (source, imports);
    REQUIRE (second.error.isEmpty());
    CHECK (second.file != first.file);
    CHECK (second.file.getParentDirectory() == imports);
}

TEST_CASE ("an audio file already owned by Imports is reused without another copy")
{
    const auto imports = juce::File::getSpecialLocation (juce::File::tempDirectory)
        .getNonexistentChildFile ("mosh-owned-import", {}, false);
    REQUIRE (imports.createDirectory().wasOk());
    const auto source = imports.getChildFile ("owned.wav");
    REQUIRE (source.replaceWithText ("owned"));

    struct Cleanup
    {
        juce::File directory;
        ~Cleanup() { directory.deleteRecursively(); }
    } cleanup { imports };

    const auto result = mosh::copyIntoImports (source, imports);
    REQUIRE (result.error.isEmpty());
    CHECK (result.file == source);
}
