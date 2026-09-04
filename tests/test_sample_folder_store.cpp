#include <catch2/catch_test_macros.hpp>

#include "files/SampleFolderStore.h"

TEST_CASE ("sample folder places persist once and deduplicate by path")
{
    const auto temp = juce::File::getSpecialLocation (juce::File::tempDirectory)
        .getNonexistentChildFile ("mosh-sample-folder-store", {}, false);
    REQUIRE (temp.createDirectory().wasOk());

    struct Cleanup
    {
        juce::File directory;
        ~Cleanup() { directory.deleteRecursively(); }
    } cleanup { temp };

    const auto storage = temp.getChildFile ("sample-folders.json");
    const auto samples = temp.getChildFile ("My Samples");
    REQUIRE (samples.createDirectory().wasOk());

    mosh::SampleFolderStore store (storage);
    REQUIRE (store.remember (samples, "bookmark-one").wasOk());
    REQUIRE (store.remember (samples, "bookmark-two").wasOk());

    const mosh::SampleFolderStore reopened (storage);
    const auto records = reopened.records();
    REQUIRE (records.size() == 1);
    CHECK (records[0].name == "My Samples");
    CHECK (records[0].path == samples.getFullPathName());
    CHECK (records[0].bookmark == "bookmark-two");
}
