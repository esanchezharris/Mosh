#include <catch2/catch_test_macros.hpp>

#include "engine/OwnerCheckpointSave.h"

#if JUCE_MAC || JUCE_LINUX
 #include <sys/stat.h>
#endif

namespace
{
    int modeOf (const juce::File& file)
    {
       #if JUCE_MAC || JUCE_LINUX
        struct stat info {};
        return ::stat (file.getFullPathName().toRawUTF8(), &info) == 0
            ? (int) (info.st_mode & 0777) : -1;
       #else
        juce::ignoreUnused (file);
        return 0600;
       #endif
    }
}

TEST_CASE ("owner checkpoint save commits a private atomic replacement",
           "[owner-checkpoint]")
{
    juce::TemporaryFile fixture;
    const auto root = fixture.getFile().getSiblingFile (
        "mosh-owner-checkpoint-" + juce::Uuid().toString());
    REQUIRE (root.createDirectory());
    const auto target = root.getChildFile ("project.mosh-repair-checkpoint-test.tracktionedit");
    REQUIRE (target.replaceWithText ("old"));
   #if JUCE_MAC || JUCE_LINUX
    REQUIRE (::chmod (target.getFullPathName().toRawUTF8(), 0600) == 0);
   #endif

    REQUIRE (mosh::ownercheckpoint::savePrivateReplacement (
        target, [] (const juce::File& staged) { return staged.replaceWithText ("new"); }));
    CHECK (target.loadFileAsString() == "new");
    CHECK (modeOf (target) == 0600);
    CHECK (root.findChildFiles (juce::File::findDirectories, false,
                                ".mosh-private-save-*").isEmpty());
    root.deleteRecursively();
}

TEST_CASE ("owner checkpoint save leaves the private original on secure-stage failure",
           "[owner-checkpoint]")
{
    juce::TemporaryFile fixture;
    const auto root = fixture.getFile().getSiblingFile (
        "mosh-owner-checkpoint-" + juce::Uuid().toString());
    REQUIRE (root.createDirectory());
    const auto target = root.getChildFile ("project.mosh-repair-checkpoint-test.tracktionedit");
    REQUIRE (target.replaceWithText ("old"));
   #if JUCE_MAC || JUCE_LINUX
    REQUIRE (::chmod (target.getFullPathName().toRawUTF8(), 0600) == 0);
   #endif

    mosh::ownercheckpoint::SaveTestHooks hooks;
    hooks.secureStagedFile = [] (const juce::File&) { return false; };
    CHECK_FALSE (mosh::ownercheckpoint::savePrivateReplacement (
        target, [] (const juce::File& staged) { return staged.replaceWithText ("new"); },
        &hooks));
    CHECK (target.loadFileAsString() == "old");
    CHECK (modeOf (target) == 0600);
    CHECK (root.findChildFiles (juce::File::findDirectories, false,
                                ".mosh-private-save-*").isEmpty());
    root.deleteRecursively();
}
