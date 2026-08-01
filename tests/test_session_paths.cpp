// Session-dir leaf resolution (SLF-CONC-001).
//
// A plain `Mosh --selftest` used a FIXED leaf ("session-selftest") that MoshEngine
// wipes with deleteRecursively() at startup. Two concurrent runs on one host therefore
// deleted each other's exports / saved edit / mosh-log.jsonl mid-test, so a gate's
// result depended on whether another agent or worktree happened to be running.
// (Reproduced: two concurrent plain runs -> 6 and 2 failures across export/save/log
// sections; the same pair with distinct session leaves -> 1281/1281 twice.)
//
// These units pin the pure leaf-resolution rules. The end-to-end proof that two
// concurrent processes no longer collide is scripts/selftest-concurrency-check.sh.

#include <catch2/catch_test_macros.hpp>
#include <juce_core/juce_core.h>

#include "engine/SessionPaths.h"

using namespace mosh::sessionpaths;

TEST_CASE ("an explicit session override is retained for directory validation", "[sessionpaths]")
{
    // The resolver retains the raw value so directory validation can accept a safe
    // _harness path or route every other value to per-process safety storage.
    REQUIRE (resolveSessionLeaf ("session-selftest", "gate-worktree-7", "pid1-aaaa") == "gate-worktree-7");
    REQUIRE (resolveSessionLeaf ("session-run-script", "verify-123", "pid1-aaaa") == "verify-123");

    // Whitespace-only is not an override (matches the existing .trim() handling).
    REQUIRE (resolveSessionLeaf ("session-selftest", "   ", "pid1-aaaa") != "   ");
}

TEST_CASE ("an unset override auto-isolates a headless leaf per process", "[sessionpaths]")
{
    const auto leaf = resolveSessionLeaf ("session-selftest", "", "pid1-aaaa");

    // Must NOT be the shared fixed name -- that is the whole bug.
    REQUIRE (leaf != "session-selftest");
    // Still recognizably derived from the mode, so a human can tell what wrote it.
    REQUIRE (leaf.startsWith ("session-selftest-"));
    REQUIRE (leaf.contains ("pid1-aaaa"));
}

TEST_CASE ("different processes get different auto-isolated leaves", "[sessionpaths]")
{
    const auto a = resolveSessionLeaf ("session-selftest", "", "pid1-aaaa");
    const auto b = resolveSessionLeaf ("session-selftest", "", "pid2-bbbb");
    REQUIRE (a != b);
}

TEST_CASE ("every headless mode auto-isolates, not just --selftest", "[sessionpaths]")
{
    // --selftest-undo, --run-script and the live-audio smoke share the same hazard:
    // a fixed leaf that freshSession wipes. relay/run-mp-selftest.sh even rm -rf's
    // session-selftest-undo directly.
    for (const auto* base : { "session-selftest", "session-selftest-undo",
                              "session-run-script", "session-live-audio-smoke" })
    {
        const auto leaf = resolveSessionLeaf (base, "", "pid1-aaaa");
        REQUIRE (leaf != juce::String (base));
        REQUIRE (leaf.startsWith (juce::String (base) + "-"));
    }
}

TEST_CASE ("the interactive GUI session leaf is never auto-isolated", "[sessionpaths]")
{
    // The GUI passes no harness base name and must keep using the owner's real
    // "session" dir -- auto-isolation there would silently orphan their project.
    REQUIRE (resolveSessionLeaf ("", "", "pid1-aaaa") == "session");
    REQUIRE (resolveSessionLeaf ("session", "", "pid1-aaaa") == "session");
}

TEST_CASE ("only the interactive GUI uses the owner property-storage directory", "[sessionpaths]")
{
    const auto moshDir = juce::File::getSpecialLocation (juce::File::tempDirectory)
                             .getChildFile ("mosh-property-root");
    const auto sessionDir = moshDir.getChildFile ("_harness/audit-run");

    REQUIRE (resolvePropertyStorageDir (moshDir, sessionDir, "pid1-aaaa", true) == moshDir);
    REQUIRE (resolvePropertyStorageDir (moshDir, sessionDir, "pid1-aaaa", false)
             == sessionDir.getChildFile ("_settings/run-pid1-aaaa"));
    REQUIRE (resolvePropertyStorageDir (moshDir, sessionDir, "pid2-bbbb", false)
             == sessionDir.getChildFile ("_settings/run-pid2-bbbb"));
}

TEST_CASE ("only marker-owned harness sessions can be selected for reset", "[sessionpaths]")
{
    const auto sandbox = juce::File::getSpecialLocation (juce::File::tempDirectory)
                             .getChildFile ("mosh-sessionpaths-ownership-" + juce::Uuid().toString());
    const auto moshDir = sandbox.getChildFile ("Mosh");
    const auto fallback = moshDir.getChildFile ("session-safety-auto-pid1-aaaa");
    REQUIRE (moshDir.createDirectory());

    REQUIRE (resolveSessionDirectory (moshDir, "session", "pid1-aaaa", true, false)
             == moshDir.getChildFile ("session"));
    REQUIRE (resolveSessionDirectory (moshDir, "session", "pid1-aaaa", false, true) == fallback);
    REQUIRE (resolveSessionDirectory (moshDir, "loras", "pid1-aaaa", false, true) == fallback);
    REQUIRE (resolveSessionDirectory (moshDir, "../owner", "pid1-aaaa", false, true) == fallback);

    const auto generated = resolveSessionLeaf ("session-selftest", "", "pid1-aaaa");
    REQUIRE (resolveSessionDirectory (moshDir, generated, "pid1-aaaa", false, false)
             == moshDir.getChildFile (generated));

    const auto unowned = moshDir.getChildFile ("_harness").getChildFile ("collision");
    REQUIRE (unowned.createDirectory());
    const auto precious = unowned.getChildFile ("keep.txt");
    REQUIRE (precious.replaceWithText ("owner data"));
    REQUIRE (resolveSessionDirectory (moshDir, "_harness/collision", "pid1-aaaa", false, true)
             == fallback);
    REQUIRE_FALSE (markOwnedHarnessSession (moshDir, unowned));
    REQUIRE_FALSE (resetOwnedHarnessSession (moshDir, unowned));
    REQUIRE (precious.loadFileAsString() == "owner data");

    const auto empty = moshDir.getChildFile ("_harness").getChildFile ("empty");
    REQUIRE (empty.createDirectory());
    REQUIRE (resolveSessionDirectory (moshDir, "_harness/empty", "pid1-aaaa", false, true)
             == empty);
    REQUIRE (markOwnedHarnessSession (moshDir, empty));
    REQUIRE (isOwnedHarnessSession (moshDir, empty));

    const auto owned = moshDir.getChildFile ("_harness").getChildFile ("owned");
    REQUIRE (owned.createDirectory());
    REQUIRE (markOwnedHarnessSession (moshDir, owned));
    REQUIRE (isOwnedHarnessSession (moshDir, owned));
    REQUIRE (owned.getChildFile ("stale.txt").replaceWithText ("stale harness data"));
    REQUIRE (resolveSessionDirectory (moshDir, "_harness/owned", "pid1-aaaa", false, true)
             == owned);
    REQUIRE (resetOwnedHarnessSession (moshDir, owned));
    REQUIRE_FALSE (owned.exists());

    REQUIRE (sandbox.deleteRecursively());
}

TEST_CASE ("symlinked session and settings ancestors use safety directories", "[sessionpaths]")
{
    const auto sandbox = juce::File::getSpecialLocation (juce::File::tempDirectory)
                             .getChildFile ("mosh-sessionpaths-" + juce::Uuid().toString());
    const auto moshDir = sandbox.getChildFile ("Mosh");
    const auto outside = sandbox.getChildFile ("outside");
    REQUIRE (moshDir.getChildFile ("_harness/audit-run/_settings").createDirectory());
    REQUIRE (outside.createDirectory());

    const auto sessionDir = moshDir.getChildFile ("_harness/audit-run");
    const auto settingsRoot = sessionDir.getChildFile ("_settings");
    REQUIRE (settingsRoot.deleteRecursively());
    REQUIRE (juce::File::createSymbolicLink (settingsRoot,
                                             outside.getFullPathName(), true));
    REQUIRE (resolvePropertyStorageDir (moshDir, sessionDir, "pid1-aaaa", false)
             == moshDir.getChildFile ("session-safety-auto-pid1-aaaa/_settings/run-pid1-aaaa"));

    const auto sessionLink = moshDir.getChildFile ("nested");
    REQUIRE (juce::File::createSymbolicLink (sessionLink,
                                             outside.getFullPathName(), true));
    REQUIRE (resolveSessionDirectory (moshDir, "nested/run", "pid1-aaaa", false, true)
             == moshDir.getChildFile ("session-safety-auto-pid1-aaaa"));

    REQUIRE (sandbox.deleteRecursively());
}

TEST_CASE ("brain identity storage uses the same resolved harness boundary", "[sessionpaths][brain]")
{
    const auto sandbox = juce::File::getSpecialLocation (juce::File::tempDirectory)
                             .getChildFile ("mosh-sessionpaths-identity-" + juce::Uuid().toString());
    const auto moshDir = sandbox.getChildFile ("Mosh");
    REQUIRE (moshDir.createDirectory());

    const auto empty = moshDir.getChildFile ("_harness/identity-empty");
    REQUIRE (empty.createDirectory());
    REQUIRE (resolveIdentitySessionDirectory (moshDir, "_harness/identity-empty", "pid1-aaaa")
             == empty);
    REQUIRE (isOwnedHarnessSession (moshDir, empty));

    const auto unowned = moshDir.getChildFile ("_harness/identity-unowned");
    REQUIRE (unowned.createDirectory());
    REQUIRE (unowned.getChildFile ("keep.txt").replaceWithText ("owner data"));
    REQUIRE (resolveIdentitySessionDirectory (moshDir, "_harness/identity-unowned", "pid2-bbbb")
             == moshDir.getChildFile ("session-safety-auto-pid2-bbbb"));
    REQUIRE_FALSE (unowned.getChildFile ("identity.json").exists());

    REQUIRE (resolveIdentitySessionDirectory (moshDir, "session", "pid3-cccc")
             == moshDir.getChildFile ("session-safety-auto-pid3-cccc"));
    REQUIRE (resolveIdentitySessionDirectory (moshDir, "../outside", "pid4-dddd")
             == moshDir.getChildFile ("session-safety-auto-pid4-dddd"));
    REQUIRE (resolveIdentitySessionDirectory (moshDir, "", "pid5-eeee")
             == moshDir.getChildFile ("session"));

    REQUIRE (sandbox.deleteRecursively());
}

TEST_CASE ("the interactive GUI is never handed a harness session base", "[sessionpaths]")
{
    // REGRESSION (#246 inverted the precedence): Main.cpp's ternary chain fell through
    // to "session-selftest" for EVERY launch, including the plain GUI, and MoshEngine
    // then preferred that name over the GUI "session" leaf. So since 2026-07-07 the
    // interactive app has been living in the harness dir that `--selftest` wipes with
    // deleteRecursively() at startup. Verified on disk: a plain GUI launch bumps
    // ~/Library/Mosh/session-selftest and leaves ~/Library/Mosh/session cold.
    HarnessModes gui {};   // no flags at all
    REQUIRE (harnessSessionBase (gui).isEmpty());

    // ...but a device-free launch is NOT the interactive GUI: it wipes its session dir,
    // so it must keep a harness base or the wipe would land on the owner's project.
    HarnessModes noAudio {};
    noAudio.envNoAudio = true;
    REQUIRE (harnessSessionBase (noAudio) == "session-selftest");
}

TEST_CASE ("each harness mode keeps its own distinct session base", "[sessionpaths]")
{
    HarnessModes selftest {};   selftest.selfTest = true;
    HarnessModes undo {};       undo.undoSelfTest = true;
    HarnessModes script {};     script.runScript = true;
    HarnessModes live {};       live.liveAudioSmoke = true;

    REQUIRE (harnessSessionBase (selftest) == "session-selftest");
    REQUIRE (harnessSessionBase (undo)     == "session-selftest-undo");
    REQUIRE (harnessSessionBase (script)   == "session-run-script");
    REQUIRE (harnessSessionBase (live)     == "session-live-audio-smoke");
}

TEST_CASE ("auto-isolated leaves are identifiable so stale ones can be pruned", "[sessionpaths]")
{
    // The pruner deletes only dirs this scheme created. It must never mistake the
    // owner's GUI "session", an explicitly-named gate leaf, or the legacy fixed
    // names for its own garbage.
    REQUIRE (isAutoIsolatedLeaf (resolveSessionLeaf ("session-selftest", "", "pid1-aaaa")));
    REQUIRE (isAutoIsolatedLeaf (resolveSessionLeaf ("session-run-script", "", "pid9-zzzz")));

    REQUIRE_FALSE (isAutoIsolatedLeaf ("session"));
    REQUIRE_FALSE (isAutoIsolatedLeaf ("session-selftest"));
    REQUIRE_FALSE (isAutoIsolatedLeaf ("session-run-script"));
    REQUIRE_FALSE (isAutoIsolatedLeaf ("gate-worktree-7"));
}

TEST_CASE ("a populated legacy dir at the pointer path is PRESERVED, never deleted", "[sessionpaths]")
{
    // The regression this guards: SLF-CONC-001 established that since #246 the
    // interactive GUI ALSO resolved to "session-selftest". So a real directory at a
    // legacy harness path can hold the owner's actual project, and publishLatestPointer
    // keys off the directory's NAME -- which says nothing about its CONTENTS. Deleting
    // it (the original behaviour) was silent, permanent data loss on the first ordinary
    // --selftest after upgrading. RED-proof: swap preserveLegacyDir back for
    // deleteRecursively() and the "survives" REQUIREs below fail.
    const auto moshDir = juce::File::getSpecialLocation (juce::File::tempDirectory)
                             .getChildFile ("mosh-sessionpaths-test-" + juce::Uuid().toString());
    moshDir.createDirectory();

    const auto pointer = moshDir.getChildFile ("session-selftest");
    pointer.createDirectory();
    const auto precious = pointer.getChildFile ("session.tracktionedit");
    precious.replaceWithText ("<EDIT>the owner's real project</EDIT>");
    const auto actual = moshDir.getChildFile ("session-selftest-auto-999-deadbeef");
    actual.createDirectory();

    publishLatestPointer (moshDir, "session-selftest", actual);

    // The project survived, byte-for-byte, under a clearly-labelled name.
    REQUIRE_FALSE (precious.existsAsFile());          // it MOVED (not still under the pointer)
    juce::Array<juce::File> rescued;
    moshDir.findChildFiles (rescued, juce::File::findDirectories, false, "session-selftest-legacy-*");
    REQUIRE (rescued.size() == 1);
    const auto survivor = rescued[0].getChildFile ("session.tracktionedit");
    REQUIRE (survivor.existsAsFile());
    REQUIRE (survivor.loadFileAsString() == "<EDIT>the owner's real project</EDIT>");

    // ...and the pointer still does its job.
    REQUIRE (pointer.isSymbolicLink());
    REQUIRE (pointer.getLinkedTarget() == actual);

    // A rescued dir must NOT look like prunable garbage, or the next run deletes it anyway.
    REQUIRE_FALSE (isAutoIsolatedLeaf (rescued[0].getFileName()));

    moshDir.deleteRecursively();
}

TEST_CASE ("a stale symlink at the pointer path is just replaced, not preserved", "[sessionpaths]")
{
    // The complement: our OWN pointer from a previous run IS disposable. If this
    // took the preserve path it would litter a -legacy- dir on every single run.
    const auto moshDir = juce::File::getSpecialLocation (juce::File::tempDirectory)
                             .getChildFile ("mosh-sessionpaths-test-" + juce::Uuid().toString());
    moshDir.createDirectory();

    const auto oldRun = moshDir.getChildFile ("session-selftest-auto-1-aaaaaaaa");
    const auto newRun = moshDir.getChildFile ("session-selftest-auto-2-bbbbbbbb");
    oldRun.createDirectory();
    newRun.createDirectory();

    // Populate the old run so "replaced" can be told apart from "followed". An empty
    // target would pass this test even if the pointer were cleared with a symlink-
    // following recursive delete.
    const auto oldArtifact = oldRun.getChildFile ("mosh-log.jsonl");
    oldArtifact.replaceWithText ("{\"seq\":1}");

    const auto pointer = moshDir.getChildFile ("session-selftest");
    juce::File::createSymbolicLink (pointer, oldRun.getFullPathName(), true);

    publishLatestPointer (moshDir, "session-selftest", newRun);

    REQUIRE (pointer.getLinkedTarget() == newRun);
    juce::Array<juce::File> littered;
    moshDir.findChildFiles (littered, juce::File::findDirectories, false, "session-selftest-legacy-*");
    REQUIRE (littered.isEmpty());

    // Unlinking the pointer must not reach THROUGH it: the previous run's dir is a real
    // directory that a concurrent run may still be writing to.
    REQUIRE (oldArtifact.existsAsFile());
    REQUIRE (oldArtifact.loadFileAsString() == "{\"seq\":1}");

    moshDir.deleteRecursively();
}
