#include <catch2/catch_test_macros.hpp>

#include "files/DirectoryListing.h"

TEST_CASE ("directory listing bounds visible rows and reports truncation")
{
    const auto root = juce::File::getSpecialLocation (juce::File::tempDirectory)
        .getNonexistentChildFile ("mosh-directory-listing", {}, false);
    REQUIRE (root.createDirectory().wasOk());

    struct Cleanup
    {
        juce::File directory;
        ~Cleanup() { directory.deleteRecursively(); }
    } cleanup { root };

    bool fixtureCreated = true;
    for (int i = 0; i < mosh::directory_listing::kMaxEntries + 1; ++i)
        fixtureCreated = fixtureCreated
            && root.getChildFile ("folder-" + juce::String (i).paddedLeft ('0', 4))
                   .createDirectory().wasOk();
    REQUIRE (fixtureCreated);

    auto* argsObject = new juce::DynamicObject();
    argsObject->setProperty ("path", root.getFullPathName());
    const auto data = mosh::directory_listing::buildData (root, juce::var (argsObject));

    REQUIRE ((bool) data.getProperty ("exists", false));
    CHECK (data.getProperty ("entries", juce::var()).size()
           == mosh::directory_listing::kMaxEntries);
    CHECK ((bool) data.getProperty ("truncated", false));
    CHECK ((int) data.getProperty ("limit", 0) == mosh::directory_listing::kMaxEntries);
    CHECK ((int) data.getProperty ("visited", 0)
           <= mosh::directory_listing::kMaxVisitedEntries);
}
