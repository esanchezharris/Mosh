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

TEST_CASE ("an explicit session override always wins verbatim", "[sessionpaths]")
{
    // The documented MOSH_SELFTEST_SESSION contract: gate.sh / verify.py /
    // installed-app-gate.sh pass a known leaf and then read artifacts back out of it.
    // Auto-isolation must never rewrite an explicitly requested name.
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
