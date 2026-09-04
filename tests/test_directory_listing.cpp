#include <catch2/catch_test_macros.hpp>

#include "files/DirectoryListing.h"

TEST_CASE ("directory listing bounds visible rows and reports truncation")
{
    const auto root = juce::File::getSpecialLocation (juce::File::tempDirectory)
        .getNonexistentChildFile ("mosh-directory-listing", {}, false);
    REQUIRE (root.createDirectory().wasOk());
    const auto imports = root.getChildFile ("imports");
    REQUIRE (imports.createDirectory().wasOk());

    struct Cleanup
    {
        juce::File directory;
        ~Cleanup() { directory.deleteRecursively(); }
    } cleanup { root };

    bool fixtureCreated = true;
    for (int i = 0; i < mosh::directory_listing::kMaxEntries + 1; ++i)
        fixtureCreated = fixtureCreated
            && imports.getChildFile ("folder-" + juce::String (i).paddedLeft ('0', 4))
                   .createDirectory().wasOk();
    REQUIRE (fixtureCreated);

    auto* argsObject = new juce::DynamicObject();
    argsObject->setProperty ("path", imports.getFullPathName());
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

TEST_CASE ("directory listing exposes only imports and explicitly added sample folders")
{
    const auto temp = juce::File::getSpecialLocation (juce::File::tempDirectory)
        .getNonexistentChildFile ("mosh-directory-places", {}, false);
    const auto session = temp.getChildFile ("session");
    const auto imports = session.getChildFile ("imports");
    const auto samples = temp.getChildFile ("Samples");
    const auto nested = samples.getChildFile ("Drums");
    const auto outside = temp.getChildFile ("Private");
    REQUIRE (imports.createDirectory().wasOk());
    REQUIRE (nested.createDirectory().wasOk());
    REQUIRE (outside.createDirectory().wasOk());

    struct Cleanup
    {
        juce::File directory;
        ~Cleanup() { directory.deleteRecursively(); }
    } cleanup { temp };

    const juce::Array<juce::File> places { samples };

    auto* nestedArgs = new juce::DynamicObject();
    nestedArgs->setProperty ("path", nested.getFullPathName());
    const auto nestedData = mosh::directory_listing::buildData (
        session, juce::var (nestedArgs), places);
    REQUIRE ((bool) nestedData.getProperty ("exists", false));
    CHECK (nestedData.getProperty ("parent", juce::var()).toString()
           == samples.getFullPathName());

    const auto roots = nestedData.getProperty ("roots", juce::var());
    REQUIRE (roots.isArray());
    REQUIRE (roots.size() == 2);
    CHECK (roots[0].getProperty ("name", juce::var()).toString() == "Imports");
    CHECK (roots[1].getProperty ("name", juce::var()).toString() == "Samples");

    auto* outsideArgs = new juce::DynamicObject();
    outsideArgs->setProperty ("path", outside.getFullPathName());
    const auto outsideData = mosh::directory_listing::buildData (
        session, juce::var (outsideArgs), places);
    CHECK_FALSE ((bool) outsideData.getProperty ("exists", true));
    CHECK (outsideData.getProperty ("error", juce::var()).toString()
           == "folder not added to Mosh");

    auto* rootArgs = new juce::DynamicObject();
    rootArgs->setProperty ("path", samples.getFullPathName());
    const auto rootData = mosh::directory_listing::buildData (
        session, juce::var (rootArgs), places);
    CHECK (rootData.getProperty ("parent", juce::var()).isVoid());
}
