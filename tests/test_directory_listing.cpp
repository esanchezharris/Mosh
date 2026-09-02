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

TEST_CASE ("directory listing defaults to Mosh-owned imports instead of the user home")
{
    // Given: a normal session directory with its Mosh-owned imports folder.
    const auto session = juce::File::getSpecialLocation (juce::File::tempDirectory)
        .getNonexistentChildFile ("mosh-directory-default", {}, false);
    const auto imports = session.getChildFile ("imports");
    REQUIRE (imports.createDirectory().wasOk());

    struct Cleanup
    {
        juce::File directory;
        ~Cleanup() { directory.deleteRecursively(); }
    } cleanup { session };

    // When: the browser requests its initial listing without an explicit path.
    const auto data = mosh::directory_listing::buildData (session, juce::var());

    // Then: native code lists only the app-owned location and advertises no protected roots.
    CHECK (data.getProperty ("path", juce::var()).toString() == imports.getFullPathName());
    const auto roots = data.getProperty ("roots", juce::var());
    REQUIRE (roots.isArray());
    REQUIRE (roots.size() == 1);
    CHECK (roots[0].getProperty ("name", juce::var()).toString() == "Imports");
    CHECK (roots[0].getProperty ("path", juce::var()).toString() == imports.getFullPathName());
}
