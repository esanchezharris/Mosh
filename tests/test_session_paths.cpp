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

#include <cstdlib>
#include <filesystem>

#include "engine/SessionPaths.h"
#include "engine/SessionMaintenance.h"

using namespace mosh::sessionpaths;

TEST_CASE ("test Mosh root override is absolute and opt-in", "[sessionpaths][security]")
{
    const auto requested = juce::File::getSpecialLocation (juce::File::tempDirectory)
                               .getChildFile ("mosh-sessionpaths-test-root");
    REQUIRE (::setenv ("MOSH_TEST_MOSH_DIR",
                       requested.getFullPathName().toRawUTF8(), 1) == 0);
    REQUIRE (::setenv ("MOSH_ENABLE_TEST_MOSH_DIR", "1", 1) == 0);

    REQUIRE (moshDataDirectory (true) == requested);
    REQUIRE (moshDataDirectory (false) != requested);

    ::unsetenv ("MOSH_TEST_MOSH_DIR");
    ::unsetenv ("MOSH_ENABLE_TEST_MOSH_DIR");
}

TEST_CASE ("an explicit session override is retained for directory validation", "[sessionpaths]")
{
    // The resolver retains the raw value so directory validation can accept a safe
    // _harness path or route every other value to per-process safety storage.
    REQUIRE (resolveSessionLeaf ("session-selftest", "gate-worktree-7", "pid1-aaaa") == "gate-worktree-7");
    REQUIRE (resolveSessionLeaf ("session-run-script", "verify-123", "pid1-aaaa") == "verify-123");

    // Whitespace-only is not an override (matches the existing .trim() handling).
    REQUIRE (resolveSessionLeaf ("session-selftest", "   ", "pid1-aaaa") != "   ");
}

TEST_CASE ("a nested secondary engine does not collide with the outer explicit override",
          "[sessionpaths]")
{
    // Bug: a --selftest run with MOSH_SELFTEST_SESSION set constructs several
    // SECONDARY MoshEngine instances in-process (simulated MP host/guest peers).
    // Pre-fix, every one of them resolved to the exact same leaf as the outer
    // engine (the override, verbatim) -- so each one's freshSession reset wiped
    // the others' files, cascading into save() failures later in the run.
    const auto outer  = resolveSessionLeaf ("session-selftest", "_harness/session-mp-selftest-1", "pid1-aaaa");
    const auto host    = resolveSessionLeaf ("session-mp-bootstrap-host",  "_harness/session-mp-selftest-1", "pid1-aaaa", true);
    const auto guest   = resolveSessionLeaf ("session-mp-bootstrap-guest", "_harness/session-mp-selftest-1", "pid1-aaaa", true);

    // The outer engine still lands EXACTLY at the literal override -- gate.sh,
    // verify.py and run-mp-selftest.sh depend on this.
    REQUIRE (outer == "_harness/session-mp-selftest-1");

    // Secondary engines nest under it, keyed by their own purpose name, so they
    // don't collide with the outer engine OR each other.
    REQUIRE (host  != outer);
    REQUIRE (guest != outer);
    REQUIRE (host  != guest);
    REQUIRE (host.startsWith (outer + "/"));
    REQUIRE (guest.startsWith (outer + "/"));
}

TEST_CASE ("nested-engine nesting only applies once an explicit override is set",
          "[sessionpaths]")
{
    // With no MOSH_SELFTEST_SESSION, nestedEngine is a no-op: the per-process
    // auto-isolation formula (baseName already makes secondary engines distinct)
    // is unaffected.
    const auto withFlag    = resolveSessionLeaf ("session-mp-bootstrap-host", "", "pid1-aaaa", true);
    const auto withoutFlag = resolveSessionLeaf ("session-mp-bootstrap-host", "", "pid1-aaaa", false);
    REQUIRE (withFlag == withoutFlag);
}

TEST_CASE ("nested-engine nesting never applies to the GUI/no-purpose leaf", "[sessionpaths]")
{
    // A nested engine is never constructed for the interactive GUI, but the
    // resolver must not nest an empty/"session" baseName even if asked -- that
    // would mean isolating the owner's real session dir.
    REQUIRE (resolveSessionLeaf ("", "_harness/session-mp-selftest-1", "pid1-aaaa", true)
             == "_harness/session-mp-selftest-1");
    REQUIRE (resolveSessionLeaf ("session", "_harness/session-mp-selftest-1", "pid1-aaaa", true)
             == "_harness/session-mp-selftest-1");
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

    REQUIRE (resolvePropertyStorageDir (moshDir, sessionDir, "pid1-aaaa", true).value() == moshDir);
    REQUIRE (resolvePropertyStorageDir (moshDir, sessionDir, "pid1-aaaa", false).value()
             == sessionDir.getChildFile ("_settings/run-pid1-aaaa"));
    REQUIRE (resolvePropertyStorageDir (moshDir, sessionDir, "pid2-bbbb", false).value()
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
    REQUIRE_FALSE (createOwnedHarnessSession (moshDir, unowned));
    REQUIRE_FALSE (resetOwnedHarnessSession (moshDir, unowned));
    REQUIRE (precious.loadFileAsString() == "owner data");

    const auto empty = moshDir.getChildFile ("_harness").getChildFile ("empty");
    REQUIRE (empty.createDirectory());
    REQUIRE (resolveSessionDirectory (moshDir, "_harness/empty", "pid1-aaaa", false, true)
             == fallback);
    REQUIRE_FALSE (isOwnedHarnessSession (moshDir, empty));
    REQUIRE_FALSE (empty.getChildFile (kHarnessOwnershipFile).exists());

    const auto fresh = moshDir.getChildFile ("_harness").getChildFile ("fresh");
    REQUIRE (createOwnedHarnessSession (moshDir, fresh));
    REQUIRE (isOwnedHarnessSession (moshDir, fresh));

    const auto owned = moshDir.getChildFile ("_harness").getChildFile ("owned");
    REQUIRE (owned.createDirectory());
    REQUIRE (owned.getChildFile (kHarnessOwnershipFile)
                  .replaceWithText (kHarnessOwnershipContents));
    REQUIRE (isOwnedHarnessSession (moshDir, owned));
    REQUIRE (owned.getChildFile ("stale.txt").replaceWithText ("stale harness data"));
    REQUIRE (resolveSessionDirectory (moshDir, "_harness/owned", "pid1-aaaa", false, true)
             == owned);
    REQUIRE (resetOwnedHarnessSession (moshDir, owned));
    REQUIRE_FALSE (owned.exists());
    const auto recoveries = moshDir.getChildFile ("_harness")
                                .findChildFiles (juce::File::findDirectories, false,
                                                 ".mosh-reset-*");
    REQUIRE (recoveries.size() == 1);
    REQUIRE (recoveries[0].getChildFile ("session/stale.txt").loadFileAsString()
             == "stale harness data");

    REQUIRE (sandbox.deleteRecursively());
}

TEST_CASE ("safety session preparation never claims a populated unowned collision", "[sessionpaths]")
{
    const auto sandbox = juce::File::getSpecialLocation (juce::File::tempDirectory)
                             .getChildFile ("mosh-sessionpaths-safety-" + juce::Uuid().toString());
    const auto moshDir = sandbox.getChildFile ("Mosh");
    REQUIRE (moshDir.createDirectory());

    const auto collision = safetySessionDirectory (moshDir, "pid1-aaaa");
    REQUIRE (collision.createDirectory());
    const auto precious = collision.getChildFile ("keep.txt");
    REQUIRE (precious.replaceWithText ("owner data"));

    const auto prepared = prepareSafetySessionDirectory (moshDir, "pid1-aaaa");
    REQUIRE (prepared.has_value());
    REQUIRE (*prepared != collision);
    REQUIRE (precious.loadFileAsString() == "owner data");
    REQUIRE (isOwnedAutoSession (moshDir, *prepared));

    REQUIRE (sandbox.deleteRecursively());
}

TEST_CASE ("ownership creation stays bound to the directory it opened", "[sessionpaths][race]")
{
    const auto sandbox = juce::File::getSpecialLocation (juce::File::tempDirectory)
                             .getChildFile ("mosh-sessionpaths-create-race-" + juce::Uuid().toString());
    const auto root = sandbox.getChildFile ("Mosh");
    const auto target = root.getChildFile ("session-selftest-auto-pid1-aaaa");
    const auto displaced = root.getChildFile ("displaced-created-directory");
    REQUIRE (root.createDirectory());

    IsolationOwnershipTestHooks hooks;
    hooks.afterDirectoryOpened = [&]
    {
        std::filesystem::rename (target.getFullPathName().toStdString(),
                                 displaced.getFullPathName().toStdString());
        REQUIRE (target.createDirectory());
        REQUIRE (target.getChildFile ("keep.txt").replaceWithText ("replacement data"));
    };

    REQUIRE_FALSE (createFreshOwnedIsolationDirectory (root, target, &hooks));
    REQUIRE (target.getChildFile ("keep.txt").loadFileAsString() == "replacement data");
    REQUIRE_FALSE (target.getChildFile (kHarnessOwnershipFile).exists());

    REQUIRE (sandbox.deleteRecursively());
}

TEST_CASE ("ownership reset never deletes a replacement after quarantine verification",
           "[sessionpaths][race]")
{
    const auto sandbox = juce::File::getSpecialLocation (juce::File::tempDirectory)
                             .getChildFile ("mosh-sessionpaths-reset-race-" + juce::Uuid().toString());
    const auto root = sandbox.getChildFile ("Mosh");
    const auto target = root.getChildFile ("session-selftest-auto-pid1-aaaa");
    REQUIRE (root.createDirectory());
    REQUIRE (createFreshOwnedIsolationDirectory (root, target));
    REQUIRE (target.getChildFile ("old.txt").replaceWithText ("owned stale data"));

    juce::File replacement;
    IsolationOwnershipTestHooks hooks;
    hooks.afterQuarantinedDirectoryOpened = [&] (const juce::File& quarantined)
    {
        const auto displaced = quarantined.getSiblingFile ("displaced-owned-directory");
        std::filesystem::rename (quarantined.getFullPathName().toStdString(),
                                 displaced.getFullPathName().toStdString());
        REQUIRE (quarantined.createDirectory());
        replacement = quarantined;
        REQUIRE (replacement.getChildFile ("keep.txt").replaceWithText ("replacement data"));
    };

    REQUIRE_FALSE (resetOwnedIsolationDirectory (root, target, &hooks));
    REQUIRE (replacement.getChildFile ("keep.txt").loadFileAsString() == "replacement data");
    REQUIRE_FALSE (replacement.getChildFile (kHarnessOwnershipFile).exists());

    REQUIRE (sandbox.deleteRecursively());
}

TEST_CASE ("ownership reset retains replaced quarantine children for recovery",
           "[sessionpaths][race]")
{
    const auto sandbox = juce::File::getSpecialLocation (juce::File::tempDirectory)
                             .getChildFile ("mosh-sessionpaths-child-race-" + juce::Uuid().toString());
    const auto root = sandbox.getChildFile ("Mosh");
    const auto target = root.getChildFile ("session-selftest-auto-pid1-aaaa");
    REQUIRE (root.createDirectory());
    REQUIRE (createFreshOwnedIsolationDirectory (root, target));

    const auto staleFile = target.getChildFile ("render.wav");
    const auto staleDirectory = target.getChildFile ("exports");
    REQUIRE (staleFile.replaceWithText ("owned stale file"));
    REQUIRE (staleDirectory.createDirectory());
    REQUIRE (staleDirectory.getChildFile ("old.wav").replaceWithText ("owned stale directory"));

    juce::File quarantined;
    IsolationOwnershipTestHooks hooks;
    hooks.afterQuarantinedDirectoryOpened = [&] (const juce::File& directory)
    {
        quarantined = directory;
        REQUIRE (directory.getChildFile ("render.wav").deleteFile());
        REQUIRE (directory.getChildFile ("render.wav").replaceWithText ("replacement file"));
        REQUIRE (directory.getChildFile ("exports").deleteRecursively());
        REQUIRE (directory.getChildFile ("exports").createDirectory());
        REQUIRE (directory.getChildFile ("exports/keep.wav")
                     .replaceWithText ("replacement directory"));
    };

    REQUIRE (resetOwnedIsolationDirectory (root, target, &hooks));
    REQUIRE_FALSE (target.exists());
    REQUIRE (quarantined.getChildFile ("render.wav").loadFileAsString()
             == "replacement file");
    REQUIRE (quarantined.getChildFile ("exports/keep.wav").loadFileAsString()
             == "replacement directory");

    REQUIRE (sandbox.deleteRecursively());
}

TEST_CASE ("failed safety allocation is explicit and cannot form cwd-relative children",
           "[sessionpaths][security]")
{
    const auto sandbox = juce::File::getSpecialLocation (juce::File::tempDirectory)
                             .getChildFile ("mosh-sessionpaths-allocation-" + juce::Uuid().toString());
    const auto outside = sandbox.getChildFile ("outside");
    const auto linkedRoot = sandbox.getChildFile ("Mosh");
    REQUIRE (outside.createDirectory());
    REQUIRE (juce::File::createSymbolicLink (linkedRoot, outside.getFullPathName(), true));

    const auto prepared = prepareSafetySessionDirectory (linkedRoot, "pid1-aaaa");
    REQUIRE_FALSE (prepared.has_value());
    REQUIRE (outside.findChildFiles (juce::File::findFilesAndDirectories, false).isEmpty());

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
    REQUIRE (resolvePropertyStorageDir (moshDir, sessionDir, "pid1-aaaa", false).value()
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
    REQUIRE (resolveIdentitySessionDirectory (moshDir, "_harness/identity-empty", "pid1-aaaa").value()
             == moshDir.getChildFile ("session-safety-auto-pid1-aaaa"));
    REQUIRE_FALSE (isOwnedHarnessSession (moshDir, empty));
    REQUIRE_FALSE (empty.getChildFile (kHarnessOwnershipFile).exists());

    const auto unowned = moshDir.getChildFile ("_harness/identity-unowned");
    REQUIRE (unowned.createDirectory());
    REQUIRE (unowned.getChildFile ("keep.txt").replaceWithText ("owner data"));
    REQUIRE (resolveIdentitySessionDirectory (moshDir, "_harness/identity-unowned", "pid2-bbbb").value()
             == moshDir.getChildFile ("session-safety-auto-pid2-bbbb"));
    REQUIRE_FALSE (unowned.getChildFile ("identity.json").exists());

    REQUIRE (resolveIdentitySessionDirectory (moshDir, "session", "pid3-cccc").value()
             == moshDir.getChildFile ("session-safety-auto-pid3-cccc"));
    REQUIRE (resolveIdentitySessionDirectory (moshDir, "../outside", "pid4-dddd").value()
             == moshDir.getChildFile ("session-safety-auto-pid4-dddd"));
    REQUIRE (resolveIdentitySessionDirectory (moshDir, "", "pid5-eeee").value()
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

TEST_CASE ("stale auto-session pruning requires the exact ownership marker", "[sessionpaths]")
{
    const auto moshDir = juce::File::getSpecialLocation (juce::File::tempDirectory)
                             .getChildFile ("mosh-sessionpaths-test-" + juce::Uuid().toString());
    moshDir.createDirectory();

    const auto actual = moshDir.getChildFile ("session-selftest-auto-3-cccccccc");
    actual.createDirectory();
    actual.getChildFile (kHarnessOwnershipFile).replaceWithText (kHarnessOwnershipContents);

    const auto unowned = moshDir.getChildFile ("session-selftest-auto-1-aaaaaaaa");
    unowned.createDirectory();
    const auto ownerArtifact = unowned.getChildFile ("session.tracktionedit");
    ownerArtifact.replaceWithText ("<EDIT>not harness-owned</EDIT>");

    const auto owned = moshDir.getChildFile ("session-selftest-auto-2-bbbbbbbb");
    owned.createDirectory();
    owned.getChildFile (kHarnessOwnershipFile).replaceWithText (kHarnessOwnershipContents);
    owned.getChildFile ("mosh-log.jsonl").replaceWithText ("{\"seq\":1}");

    const auto stale = juce::Time::getCurrentTime() - juce::RelativeTime::days (2.0);
    unowned.setLastModificationTime (stale);
    owned.setLastModificationTime (stale);

    publishLatestPointer (moshDir, "session-selftest", actual);

    REQUIRE (ownerArtifact.existsAsFile());
    REQUIRE (ownerArtifact.loadFileAsString() == "<EDIT>not harness-owned</EDIT>");
    REQUIRE_FALSE (owned.exists());
    const auto recoveries = moshDir.findChildFiles (
        juce::File::findDirectories, false, ".mosh-reset-*");
    REQUIRE (recoveries.size() == 1);
    REQUIRE (recoveries[0].getChildFile ("session/mosh-log.jsonl").loadFileAsString()
             == "{\"seq\":1}");

    moshDir.deleteRecursively();
}

TEST_CASE ("an unowned directory at the pointer path is left byte-identical", "[sessionpaths]")
{
    // The regression this guards: SLF-CONC-001 established that since #246 the
    // interactive GUI ALSO resolved to "session-selftest". So a real directory at a
    // legacy harness path can hold the owner's actual project, and publishLatestPointer
    // keys off the directory's NAME -- which says nothing about its CONTENTS. Deleting
    // it (the original behaviour) was silent, permanent data loss on the first ordinary
    // --selftest after upgrading. Relocating it is also mutation: publication must fail
    // closed until the existing pointer is independently proven feature-owned.
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

    REQUIRE (pointer.isDirectory());
    REQUIRE_FALSE (pointer.isSymbolicLink());
    REQUIRE (precious.existsAsFile());
    REQUIRE (precious.loadFileAsString() == "<EDIT>the owner's real project</EDIT>");
    juce::Array<juce::File> rescued;
    moshDir.findChildFiles (rescued, juce::File::findDirectories, false, "session-selftest-legacy-*");
    REQUIRE (rescued.isEmpty());

    moshDir.deleteRecursively();
}

TEST_CASE ("unowned file and symlink pointer collisions are never replaced", "[sessionpaths]")
{
    const auto sandbox = juce::File::getSpecialLocation (juce::File::tempDirectory)
                             .getChildFile ("mosh-sessionpaths-test-" + juce::Uuid().toString());

    for (const bool useSymlink : { false, true })
    {
        const auto moshDir = sandbox.getChildFile (useSymlink ? "symlink" : "file");
        REQUIRE (moshDir.createDirectory());
        const auto actual = moshDir.getChildFile ("session-selftest-auto-999-deadbeef");
        REQUIRE (actual.createDirectory());
        REQUIRE (actual.getChildFile (kHarnessOwnershipFile)
                     .replaceWithText (kHarnessOwnershipContents));

        const auto pointer = moshDir.getChildFile ("session-selftest");
        const auto ownerData = moshDir.getChildFile ("owner-state");
        REQUIRE (ownerData.replaceWithText ("owner data"));
        if (useSymlink)
            REQUIRE (juce::File::createSymbolicLink (
                pointer, ownerData.getFullPathName(), true));
        else
            REQUIRE (pointer.replaceWithText ("owner pointer file"));

        publishLatestPointer (moshDir, "session-selftest", actual);

        if (useSymlink)
        {
            REQUIRE (pointer.isSymbolicLink());
            REQUIRE (pointer.getLinkedTarget() == ownerData);
        }
        else
        {
            REQUIRE (pointer.existsAsFile());
            REQUIRE (pointer.loadFileAsString() == "owner pointer file");
        }
        REQUIRE (ownerData.loadFileAsString() == "owner data");
    }

    REQUIRE (sandbox.deleteRecursively());
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
    oldRun.getChildFile (kHarnessOwnershipFile).replaceWithText (kHarnessOwnershipContents);
    newRun.getChildFile (kHarnessOwnershipFile).replaceWithText (kHarnessOwnershipContents);

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
