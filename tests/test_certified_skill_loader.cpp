// Skill Foundry Task 4 — CertifiedSkillLoader (src/agent/CertifiedSkillLoader.{h,cpp}).
//
// Pure, engine-free filesystem-admission units, same posture as test_agent_memory.cpp for
// AgentMemoryStore.h: juce_core + juce_data_structures + juce_cryptography only, no
// tracktion_engine, no live packaged app. Every fixture lives under a fresh scratch
// directory unique per test — never $MOSH_AGENT_DIR / ~/Library/Mosh, and every call below
// passes an explicit root/override so resolveAgentRoot()'s env-reading default path is
// exercised only by its own narrow, non-filesystem-touching test.
//
// KNOWN GAP (documented rather than silently skipped): the "wrong uid" rejection branch
// (CertifiedSkillLoader.cpp's isSafeOwnedRootFd -> ownedByCurrentUser) cannot be exercised
// by an unprivileged test process — chown()ing a fixture to a DIFFERENT uid requires root.
// The positive case below (a directory the test creates, hence owned by the current user)
// exercises the SAME comparison's "equal" branch; the "not equal" branch is reviewed, not
// independently proven by this file. Flagged explicitly per this repo's own
// vacuous-verification discipline rather than left as a silent hole.
//
// DEFERRED THIS SESSION: this file is written but NOT compiled or run (see the run's
// memory-preflight gate). Every assertion below is a real, specific expectation — nothing
// here is a "cannot fail" placeholder — but it has not yet been RED/GREEN proven against the
// real implementation. See the task's final report for the exact command that will prove it.

#include <catch2/catch_test_macros.hpp>
#include <juce_core/juce_core.h>
#include <juce_data_structures/juce_data_structures.h>

#include "agent/CertifiedSkillLoader.h"

#include <cstdlib>

#if ! JUCE_WINDOWS
 #include <fcntl.h>
 #include <sys/stat.h>
 #include <unistd.h>
#endif

using namespace mosh;
using juce::var;
using juce::String;
using juce::File;

namespace
{
    // A fresh scratch dir under the system temp dir, unique per call — mirrors
    // test_agent_memory.cpp's scratchDir() exactly (same rationale: never touch the real
    // ~/Library/Mosh, drive the loader's pure functions with explicit File args).
    File scratchDir (const String& leaf)
    {
        auto d = File::getSpecialLocation (File::tempDirectory)
                    .getChildFile ("mosh-skillloader-test-" + juce::Uuid().toString().substring (0, 8) + "-" + leaf);
        d.deleteRecursively();
        d.createDirectory();
        return d;
    }

    void writeText (const File& f, const String& content)
    {
        f.getParentDirectory().createDirectory();
        f.replaceWithText (content);
    }

    // Deliberately tiny, non-empty, syntactically-plausible JSON — the loader does NOT
    // parse JSON (that's TypeScript's job), so content shape doesn't matter to it, only
    // byte count / UTF-8 validity / exact bytes-in-bytes-out.
    String minimalJson (const String& tag) { return "{\"tag\":\"" + tag + "\"}"; }

    int countDiagnosticsWithCode (const var& diagnostics, const String& code)
    {
        int n = 0;
        if (auto* arr = diagnostics.getArray())
            for (auto& d : *arr)
                if (d.getProperty ("code", var()).toString() == code)
                    ++n;
        return n;
    }

    juce::StringArray directoryNamesOf (const var& packages)
    {
        juce::StringArray out;
        if (auto* arr = packages.getArray())
            for (auto& p : *arr)
                out.add (p.getProperty ("directoryName", var()).toString());
        return out;
    }

    // Mirrors tests/test_brain_proxy.cpp / tests/test_generative_jobmanager.cpp's ScopedEnv
    // exactly: sets an env var for the scope, restores the prior value (or unsets) on exit.
    // Used ONLY by the readFromEnvironment()/readSourceStatusFromEnvironment() test below —
    // this repo's own --selftest machinery also reads $MOSH_AGENT_DIR (see CLAUDE.md), so
    // it must never leak a value past its one TEST_CASE.
    struct ScopedEnv
    {
        const char* key;
        juce::String prev;
        bool had = false;
        ScopedEnv (const char* k, const juce::String& v) : key (k)
        {
            if (auto* p = std::getenv (k)) { prev = p; had = true; }
           #if JUCE_WINDOWS
            _putenv_s (k, v.toRawUTF8());
           #else
            ::setenv (k, v.toRawUTF8(), 1);
           #endif
        }
        ~ScopedEnv()
        {
           #if JUCE_WINDOWS
            _putenv_s (key, had ? prev.toRawUTF8() : "");
           #else
            if (had) ::setenv (key, prev.toRawUTF8(), 1); else ::unsetenv (key);
           #endif
        }
    };

#if ! JUCE_WINDOWS
    void chmodOwnerOnly (const File& f)
    {
        ::chmod (f.getFullPathName().toRawUTF8(), 0700);
    }

    void chmodWorldWritable (const File& f)
    {
        ::chmod (f.getFullPathName().toRawUTF8(), 0777);
    }

    void writeOwnerPackage (const File& certifiedDir, const String& id, const String& version,
                            const String& skillContent = {})
    {
        auto pkg = certifiedDir.getChildFile (id + "@" + version);
        writeText (pkg.getChildFile ("skill.json"), skillContent.isEmpty() ? minimalJson ("skill") : skillContent);
        writeText (pkg.getChildFile ("certification.json"), minimalJson ("certification"));
        writeText (pkg.getChildFile ("approval.json"), minimalJson ("approval"));
        writeText (pkg.getChildFile ("release.json"), minimalJson ("release"));
    }

    void writeNativePackage (const File& resourcesRoot, const String& id, const String& version)
    {
        auto pkg = resourcesRoot.getChildFile (id + "@" + version);
        writeText (pkg.getChildFile ("payload.json"), minimalJson ("payload"));
        writeText (pkg.getChildFile ("certification.json"), minimalJson ("certification"));
        writeText (pkg.getChildFile ("approval.json"), minimalJson ("approval"));
        writeText (pkg.getChildFile ("bundle-entry.json"), minimalJson ("bundle-entry"));
    }

    // A ready-to-read owner root: <root>/skills/certified/, all three levels 0700
    // (owner-only, group/world-unwritable) — the loader's baseline "safe" shape.
    File makeSafeAgentRoot (const File& root)
    {
        root.getChildFile ("skills").getChildFile ("certified").createDirectory();
        chmodOwnerOnly (root);
        chmodOwnerOnly (root.getChildFile ("skills"));
        chmodOwnerOnly (root.getChildFile ("skills").getChildFile ("certified"));
        return root;
    }
#endif
}

// ───────────────────────────── resolveAgentRoot ─────────────────────────────

TEST_CASE ("resolveAgentRoot: an override wins verbatim; empty falls back to ~/Library/Mosh/agent",
           "[skillfoundry][loader]")
{
    REQUIRE (CertifiedSkillLoader::resolveAgentRoot ("/tmp/some-override").getFullPathName() == "/tmp/some-override");

    const auto fallback = CertifiedSkillLoader::resolveAgentRoot ("");
    REQUIRE (fallback.getFileName() == "agent");
    REQUIRE (fallback.getParentDirectory().getFileName() == "Mosh");
}

#if ! JUCE_WINDOWS

// ───────────────────────────── read(): baseline + root safety ─────────────────────────────

TEST_CASE ("read: a single valid package is admitted with exact bytes and a verified sha256",
           "[skillfoundry][loader]")
{
    auto root = scratchDir ("valid-package");
    makeSafeAgentRoot (root);
    auto certifiedDir = root.getChildFile ("skills").getChildFile ("certified");
    writeOwnerPackage (certifiedDir, "owner-safe", "1.0.0", "{\"tag\":\"skill\"}");

    auto result = CertifiedSkillLoader::read (root);
    REQUIRE ((bool) result.getProperty ("ok", false));

    auto packages = result.getProperty ("packages", var());
    REQUIRE (packages.size() == 1);

    auto pkg = packages[0];
    REQUIRE (pkg.getProperty ("directoryName", var()).toString() == "owner-safe@1.0.0");
    REQUIRE (pkg.getProperty ("skillIdFromDirectory", var()).toString() == "owner-safe");
    REQUIRE (pkg.getProperty ("versionFromDirectory", var()).toString() == "1.0.0");

    auto skillFile = pkg.getProperty ("files", var()).getProperty ("skill", var());
    REQUIRE ((int) skillFile.getProperty ("bytes", 0) == 15);   // printf '{"tag":"skill"}' | wc -c
    REQUIRE (skillFile.getProperty ("sha256", var()).toString()
             == "8c023a5816fd23882e8da91ef413a9be026fd88e326dceb86894452e8a30b283");   // verified: shasum -a 256
    REQUIRE (skillFile.getProperty ("utf8", var()).toString() == "{\"tag\":\"skill\"}");
}

// NOTE: this used to call CertifiedSkillLoader::read (File ("relative/agent/dir")) directly.
// That cannot exercise the "relative" contract: juce::File's constructor (parseAbsolutePath)
// silently resolves a relative string against the process CWD, so by the time read() sees a
// juce::File it is ALREADY absolute — the isAbsolutePath guard inside read() is structurally
// unreachable through that seam. The real (and only) place a relative $MOSH_AGENT_DIR is still
// observable as relative is the raw environment-variable STRING, before any juce::File is
// constructed from it — i.e. inside readFromEnvironment()/readSourceStatusFromEnvironment().
// This test now exercises that real seam. ScopedEnv save/restores $MOSH_AGENT_DIR so no other
// test (or this repo's own --selftest machinery, which also reads $MOSH_AGENT_DIR) observes it.
TEST_CASE ("readFromEnvironment: a relative $MOSH_AGENT_DIR override fails closed with zero packages",
           "[skillfoundry][loader]")
{
    ScopedEnv env ("MOSH_AGENT_DIR", "relative/agent/dir");

    auto result = CertifiedSkillLoader::readFromEnvironment();
    REQUIRE_FALSE ((bool) result.getProperty ("ok", true));
    REQUIRE (result.getProperty ("packages", var()).size() == 0);
    REQUIRE (countDiagnosticsWithCode (result.getProperty ("diagnostics", var()), "root_not_absolute") == 1);
}

TEST_CASE ("readSourceStatusFromEnvironment: a relative $MOSH_AGENT_DIR override fails closed",
           "[skillfoundry][loader]")
{
    ScopedEnv env ("MOSH_AGENT_DIR", "relative/agent/dir");

    auto result = CertifiedSkillLoader::readSourceStatusFromEnvironment();
    REQUIRE_FALSE ((bool) result.getProperty ("ok", true));
    REQUIRE (countDiagnosticsWithCode (result.getProperty ("diagnostics", var()), "root_not_absolute") == 1);
}

TEST_CASE ("read: a missing root is benign — ok:true, zero packages, no diagnostics",
           "[skillfoundry][loader]")
{
    auto root = scratchDir ("missing-root");
    root.deleteRecursively();   // scratchDir() creates it; remove it again for this case

    auto result = CertifiedSkillLoader::read (root);
    REQUIRE ((bool) result.getProperty ("ok", false));
    REQUIRE (result.getProperty ("packages", var()).size() == 0);
    REQUIRE (result.getProperty ("diagnostics", var()).size() == 0);
}

TEST_CASE ("read: a missing skills/ subdirectory under an otherwise-safe root is also benign",
           "[skillfoundry][loader]")
{
    auto root = scratchDir ("no-skills-dir");
    chmodOwnerOnly (root);

    auto result = CertifiedSkillLoader::read (root);
    REQUIRE ((bool) result.getProperty ("ok", false));
    REQUIRE (result.getProperty ("packages", var()).size() == 0);
}

TEST_CASE ("read: a symlinked root fails closed", "[skillfoundry][loader]")
{
    auto real = scratchDir ("symlink-root-real");
    makeSafeAgentRoot (real);
    writeOwnerPackage (real.getChildFile ("skills").getChildFile ("certified"), "owner-safe", "1.0.0");

    auto linkPath = scratchDir ("symlink-root-link");
    linkPath.deleteRecursively();
    REQUIRE (::symlink (real.getFullPathName().toRawUTF8(), linkPath.getFullPathName().toRawUTF8()) == 0);

    auto result = CertifiedSkillLoader::read (linkPath);
    REQUIRE_FALSE ((bool) result.getProperty ("ok", true));
    REQUIRE (result.getProperty ("packages", var()).size() == 0);
    REQUIRE (countDiagnosticsWithCode (result.getProperty ("diagnostics", var()), "unsafe_root") == 1);
}

TEST_CASE ("read: a group/world-writable root fails closed", "[skillfoundry][loader]")
{
    auto root = scratchDir ("writable-root");
    makeSafeAgentRoot (root);
    writeOwnerPackage (root.getChildFile ("skills").getChildFile ("certified"), "owner-safe", "1.0.0");
    chmodWorldWritable (root);

    auto result = CertifiedSkillLoader::read (root);
    REQUIRE_FALSE ((bool) result.getProperty ("ok", true));
    REQUIRE (result.getProperty ("packages", var()).size() == 0);
}

TEST_CASE ("read: a symlinked skills/certified fails closed even though the root itself is safe",
           "[skillfoundry][loader]")
{
    auto root = scratchDir ("symlink-certified-root");
    chmodOwnerOnly (root);
    root.getChildFile ("skills").createDirectory();
    chmodOwnerOnly (root.getChildFile ("skills"));

    auto realCertified = scratchDir ("symlink-certified-target");
    chmodOwnerOnly (realCertified);
    writeOwnerPackage (realCertified, "owner-safe", "1.0.0");

    const auto certifiedLink = root.getChildFile ("skills").getChildFile ("certified");
    REQUIRE (::symlink (realCertified.getFullPathName().toRawUTF8(), certifiedLink.getFullPathName().toRawUTF8()) == 0);

    auto result = CertifiedSkillLoader::read (root);
    REQUIRE_FALSE ((bool) result.getProperty ("ok", true));
    REQUIRE (result.getProperty ("packages", var()).size() == 0);
}

// ───────────────────────────── read(): per-package quarantine ─────────────────────────────

TEST_CASE ("read: invalid UTF-8 in one leaf quarantines only that package", "[skillfoundry][loader]")
{
    auto root = scratchDir ("invalid-utf8");
    makeSafeAgentRoot (root);
    auto certifiedDir = root.getChildFile ("skills").getChildFile ("certified");
    writeOwnerPackage (certifiedDir, "owner-bad", "1.0.0");
    writeOwnerPackage (certifiedDir, "owner-good", "1.0.0");

    // Overwrite owner-bad's skill.json with an invalid UTF-8 byte sequence: a lone
    // continuation byte (0x80) can never start a valid sequence.
    juce::MemoryBlock bad;
    const unsigned char invalid[] = { 0x7B, 0x80, 0x7D };   // '{' 0x80 '}'
    bad.append (invalid, sizeof (invalid));
    certifiedDir.getChildFile ("owner-bad@1.0.0").getChildFile ("skill.json").replaceWithData (bad.getData(), bad.getSize());

    auto result = CertifiedSkillLoader::read (root);
    REQUIRE ((bool) result.getProperty ("ok", false));
    REQUIRE (directoryNamesOf (result.getProperty ("packages", var())) == juce::StringArray { "owner-good@1.0.0" });
    REQUIRE (countDiagnosticsWithCode (result.getProperty ("diagnostics", var()), "invalid_utf8") == 1);
}

TEST_CASE ("read: a hard-linked leaf quarantines its package with the hard_linked code",
           "[skillfoundry][loader]")
{
    auto root = scratchDir ("hard-link");
    makeSafeAgentRoot (root);
    auto certifiedDir = root.getChildFile ("skills").getChildFile ("certified");
    writeOwnerPackage (certifiedDir, "owner-linked", "1.0.0");

    // The second name lives OUTSIDE the package directory (a sibling "elsewhere" dir),
    // so the package directory's own entry COUNT stays exactly 4 -- this isolates
    // st_nlink>1 as the ONLY anomaly, specifically exercising readGuardedLeafFile's
    // hard_linked rejection rather than readPackageDirectory's unexpected_entry_count
    // (a second name INSIDE the package directory would trip that check first instead,
    // as proven by the "extra file" test above -- a different code path).
    auto skillFile = certifiedDir.getChildFile ("owner-linked@1.0.0").getChildFile ("skill.json");
    auto elsewhere = root.getChildFile ("elsewhere");
    elsewhere.createDirectory();
    auto secondName = elsewhere.getChildFile ("skill.json.other-name");
    REQUIRE (::link (skillFile.getFullPathName().toRawUTF8(), secondName.getFullPathName().toRawUTF8()) == 0);

    auto result = CertifiedSkillLoader::read (root);
    REQUIRE ((bool) result.getProperty ("ok", false));
    REQUIRE (result.getProperty ("packages", var()).size() == 0);
    REQUIRE (countDiagnosticsWithCode (result.getProperty ("diagnostics", var()), "hard_linked") == 1);
}

TEST_CASE ("read: a FIFO in place of a leaf file quarantines the package and never blocks",
           "[skillfoundry][loader]")
{
    auto root = scratchDir ("fifo-leaf");
    makeSafeAgentRoot (root);
    auto certifiedDir = root.getChildFile ("skills").getChildFile ("certified");
    auto pkgDir = certifiedDir.getChildFile ("owner-fifo@1.0.0");
    pkgDir.createDirectory();
    writeText (pkgDir.getChildFile ("certification.json"), minimalJson ("certification"));
    writeText (pkgDir.getChildFile ("approval.json"), minimalJson ("approval"));
    writeText (pkgDir.getChildFile ("release.json"), minimalJson ("release"));
    REQUIRE (::mkfifo (pkgDir.getChildFile ("skill.json").getFullPathName().toRawUTF8(), 0600) == 0);

    // The whole point of this test: it must COMPLETE (the O_NONBLOCK open in
    // readGuardedLeafFile is what prevents a hang here — a plain O_RDONLY open of a
    // FIFO with no writer blocks forever).
    auto result = CertifiedSkillLoader::read (root);
    REQUIRE ((bool) result.getProperty ("ok", false));
    REQUIRE (result.getProperty ("packages", var()).size() == 0);
    REQUIRE (countDiagnosticsWithCode (result.getProperty ("diagnostics", var()), "not_regular_file") == 1);
}

TEST_CASE ("read: an extra file in a package directory quarantines it", "[skillfoundry][loader]")
{
    auto root = scratchDir ("extra-file");
    makeSafeAgentRoot (root);
    auto certifiedDir = root.getChildFile ("skills").getChildFile ("certified");
    writeOwnerPackage (certifiedDir, "owner-extra", "1.0.0");
    writeText (certifiedDir.getChildFile ("owner-extra@1.0.0").getChildFile ("extra.json"), minimalJson ("extra"));

    auto result = CertifiedSkillLoader::read (root);
    REQUIRE ((bool) result.getProperty ("ok", false));
    REQUIRE (result.getProperty ("packages", var()).size() == 0);
    REQUIRE (countDiagnosticsWithCode (result.getProperty ("diagnostics", var()), "unexpected_entry_count") == 1);
}

TEST_CASE ("read: a missing file in a package directory quarantines it", "[skillfoundry][loader]")
{
    auto root = scratchDir ("missing-file");
    makeSafeAgentRoot (root);
    auto certifiedDir = root.getChildFile ("skills").getChildFile ("certified");
    auto pkgDir = certifiedDir.getChildFile ("owner-incomplete@1.0.0");
    writeText (pkgDir.getChildFile ("skill.json"), minimalJson ("skill"));
    writeText (pkgDir.getChildFile ("certification.json"), minimalJson ("certification"));
    writeText (pkgDir.getChildFile ("approval.json"), minimalJson ("approval"));
    // release.json intentionally absent.

    auto result = CertifiedSkillLoader::read (root);
    REQUIRE ((bool) result.getProperty ("ok", false));
    REQUIRE (result.getProperty ("packages", var()).size() == 0);
    REQUIRE (countDiagnosticsWithCode (result.getProperty ("diagnostics", var()), "unexpected_entry_count") == 1);
}

TEST_CASE ("read: a nested directory instead of a package's flat 4 files quarantines it",
           "[skillfoundry][loader]")
{
    auto root = scratchDir ("nested-dir");
    makeSafeAgentRoot (root);
    auto certifiedDir = root.getChildFile ("skills").getChildFile ("certified");
    auto pkgDir = certifiedDir.getChildFile ("owner-nested@1.0.0");
    writeText (pkgDir.getChildFile ("skill.json"), minimalJson ("skill"));
    writeText (pkgDir.getChildFile ("certification.json"), minimalJson ("certification"));
    writeText (pkgDir.getChildFile ("approval.json"), minimalJson ("approval"));
    // A SUBDIRECTORY where release.json should be, instead of the file itself.
    pkgDir.getChildFile ("release.json").createDirectory();

    auto result = CertifiedSkillLoader::read (root);
    REQUIRE ((bool) result.getProperty ("ok", false));
    REQUIRE (result.getProperty ("packages", var()).size() == 0);
    // The entry named "release.json" IS present (it is a directory, not a file), so the
    // count is 4 and the loader proceeds to try reading it as a leaf -- opening a
    // directory via the leaf-file O_NOFOLLOW path fails as "not_regular_file".
    REQUIRE (countDiagnosticsWithCode (result.getProperty ("diagnostics", var()), "not_regular_file") == 1);
}

TEST_CASE ("read: an invalid <id>@<version> directory name quarantines it without crashing",
           "[skillfoundry][loader]")
{
    auto root = scratchDir ("invalid-dirname");
    makeSafeAgentRoot (root);
    auto certifiedDir = root.getChildFile ("skills").getChildFile ("certified");
    // A package directory with no '@' at all -- written directly rather than through
    // writeOwnerPackage() (which always appends "@<version>").
    auto pkgDir = certifiedDir.getChildFile ("ownernoatatall");
    writeText (pkgDir.getChildFile ("skill.json"), minimalJson ("skill"));
    writeText (pkgDir.getChildFile ("certification.json"), minimalJson ("certification"));
    writeText (pkgDir.getChildFile ("approval.json"), minimalJson ("approval"));
    writeText (pkgDir.getChildFile ("release.json"), minimalJson ("release"));

    auto result = CertifiedSkillLoader::read (root);
    REQUIRE ((bool) result.getProperty ("ok", false));
    REQUIRE (result.getProperty ("packages", var()).size() == 0);
    REQUIRE (countDiagnosticsWithCode (result.getProperty ("diagnostics", var()), "invalid_directory_name") == 1);
}

TEST_CASE ("read: a leaf file over its exact byte cap quarantines the package", "[skillfoundry][loader]")
{
    auto root = scratchDir ("oversized-leaf");
    makeSafeAgentRoot (root);
    auto certifiedDir = root.getChildFile ("skills").getChildFile ("certified");
    // manifestBytes cap is 65536 -- one byte over.
    writeOwnerPackage (certifiedDir, "owner-huge", "1.0.0", String::repeatedString ("a", 65537));

    auto result = CertifiedSkillLoader::read (root);
    REQUIRE ((bool) result.getProperty ("ok", false));
    REQUIRE (result.getProperty ("packages", var()).size() == 0);
    REQUIRE (countDiagnosticsWithCode (result.getProperty ("diagnostics", var()), "too_large") == 1);
}

TEST_CASE ("read: a leaf file exactly AT its byte cap is admitted (boundary, not one-over)",
           "[skillfoundry][loader]")
{
    auto root = scratchDir ("exact-cap-leaf");
    makeSafeAgentRoot (root);
    auto certifiedDir = root.getChildFile ("skills").getChildFile ("certified");
    writeOwnerPackage (certifiedDir, "owner-exact", "1.0.0", String::repeatedString ("a", 65536));

    auto result = CertifiedSkillLoader::read (root);
    REQUIRE ((bool) result.getProperty ("ok", false));
    REQUIRE (result.getProperty ("packages", var()).size() == 1);
}

// ───────────────────────────── read(): counts, order, caps ─────────────────────────────

TEST_CASE ("read: packages are admitted in ASCII-sorted directory-name order", "[skillfoundry][loader]")
{
    auto root = scratchDir ("sort-order");
    makeSafeAgentRoot (root);
    auto certifiedDir = root.getChildFile ("skills").getChildFile ("certified");
    writeOwnerPackage (certifiedDir, "zzz-last", "1.0.0");
    writeOwnerPackage (certifiedDir, "aaa-first", "1.0.0");
    writeOwnerPackage (certifiedDir, "mmm-middle", "1.0.0");

    auto result = CertifiedSkillLoader::read (root);
    REQUIRE (directoryNamesOf (result.getProperty ("packages", var()))
             == juce::StringArray { "aaa-first@1.0.0", "mmm-middle@1.0.0", "zzz-last@1.0.0" });
}

TEST_CASE ("read: exactly 64 packages admit; a 65th is capacity_exceeded and omitted",
           "[skillfoundry][loader]")
{
    auto root = scratchDir ("package-count-cap");
    makeSafeAgentRoot (root);
    auto certifiedDir = root.getChildFile ("skills").getChildFile ("certified");
    for (int i = 0; i < 65; ++i)
    {
        auto id = "owner-" + String::formatted ("%03d", i);
        writeOwnerPackage (certifiedDir, id, "1.0.0");
    }

    auto result = CertifiedSkillLoader::read (root);
    REQUIRE ((bool) result.getProperty ("ok", false));
    REQUIRE (result.getProperty ("packages", var()).size() == 64);
    REQUIRE (countDiagnosticsWithCode (result.getProperty ("diagnostics", var()), "capacity_exceeded") == 1);
}

TEST_CASE ("read: the total admitted package byte cap (8 MiB) stops admission before the count cap does",
           "[skillfoundry][loader]")
{
    auto root = scratchDir ("byte-cap");
    makeSafeAgentRoot (root);
    auto certifiedDir = root.getChildFile ("skills").getChildFile ("certified");

    // 34 packages x ~262KB certification.json (the largest single-file cap) crosses the
    // 8 MiB (8388608-byte) startup cap well before the 64-package count cap would.
    const auto certificationFiller = String::repeatedString ("a", 262144);
    for (int i = 0; i < 34; ++i)
    {
        auto id = "owner-" + String::formatted ("%03d", i);
        auto pkg = certifiedDir.getChildFile (id + "@1.0.0");
        writeText (pkg.getChildFile ("skill.json"), minimalJson ("skill"));
        writeText (pkg.getChildFile ("certification.json"), certificationFiller);
        writeText (pkg.getChildFile ("approval.json"), minimalJson ("approval"));
        writeText (pkg.getChildFile ("release.json"), minimalJson ("release"));
    }

    auto result = CertifiedSkillLoader::read (root);
    REQUIRE ((bool) result.getProperty ("ok", false));
    const auto admitted = result.getProperty ("packages", var()).size();
    REQUIRE (admitted < 34);
    REQUIRE ((juce::int64) (double) result.getProperty ("totalBytes", 0.0) <= 8388608);
    REQUIRE (countDiagnosticsWithCode (result.getProperty ("diagnostics", var()), "capacity_exceeded") >= 1);
}

// ───────────────────────────── active.json / source-status.json ─────────────────────────────

TEST_CASE ("read: active.json bytes are returned verbatim as activeIndex", "[skillfoundry][loader]")
{
    auto root = scratchDir ("active-index");
    makeSafeAgentRoot (root);
    auto certifiedDir = root.getChildFile ("skills").getChildFile ("certified");
    writeText (certifiedDir.getChildFile ("active.json"), "{\"entries\":[]}");

    auto result = CertifiedSkillLoader::read (root);
    REQUIRE ((bool) result.getProperty ("ok", false));
    auto activeIndex = result.getProperty ("activeIndex", var());
    REQUIRE_FALSE (activeIndex.isVoid());
    REQUIRE (activeIndex.getProperty ("utf8", var()).toString() == "{\"entries\":[]}");
}

TEST_CASE ("read() and readSourceStatus() report the SAME source-status.json bytes",
           "[skillfoundry][loader]")
{
    auto root = scratchDir ("source-status-parity");
    makeSafeAgentRoot (root);
    writeText (root.getChildFile ("skills").getChildFile ("source-status.json"), "{\"sources\":[]}");

    auto fullResult = CertifiedSkillLoader::read (root);
    auto statusResult = CertifiedSkillLoader::readSourceStatus (root);

    auto fromRead = fullResult.getProperty ("sourceStatusIndex", var());
    auto fromNarrow = statusResult.getProperty ("statusIndex", var());
    REQUIRE_FALSE (fromRead.isVoid());
    REQUIRE_FALSE (fromNarrow.isVoid());
    REQUIRE (fromRead.getProperty ("sha256", var()).toString() == fromNarrow.getProperty ("sha256", var()).toString());
    REQUIRE (fromRead.getProperty ("utf8", var()).toString() == "{\"sources\":[]}");
}

TEST_CASE ("readSourceStatus: a missing source-status.json is benign (ok:true, null statusIndex)",
           "[skillfoundry][loader]")
{
    auto root = scratchDir ("no-source-status");
    makeSafeAgentRoot (root);

    auto result = CertifiedSkillLoader::readSourceStatus (root);
    REQUIRE ((bool) result.getProperty ("ok", false));
    REQUIRE (result.getProperty ("statusIndex", var()).isVoid());
    REQUIRE (result.getProperty ("diagnostics", var()).size() == 0);
}

// ───────────────────────────── readBundledNative ─────────────────────────────

TEST_CASE ("readBundledNative: a valid index.json plus one 4-file package is admitted",
           "[skillfoundry][loader]")
{
    auto resourcesRoot = scratchDir ("native-resources");
    writeText (resourcesRoot.getChildFile ("index.json"), "{\"entries\":[\"builtin-x@1.0.0\"]}");
    writeNativePackage (resourcesRoot, "builtin-x", "1.0.0");

    auto result = CertifiedSkillLoader::readBundledNative (resourcesRoot);
    REQUIRE ((bool) result.getProperty ("ok", false));
    REQUIRE (result.getProperty ("packages", var()).size() == 1);
    auto pkg = result.getProperty ("packages", var())[0];
    auto files = pkg.getProperty ("files", var());
    REQUIRE_FALSE (files.getProperty ("payload", var()).isVoid());
    REQUIRE_FALSE (files.getProperty ("bundleEntry", var()).isVoid());

    // The build envelope is always present, even in a hermetic test build (degrading
    // undefined macros to "unknown" per buildIdentityVar()'s own contract).
    auto build = result.getProperty ("build", var());
    REQUIRE_FALSE (build.getProperty ("moshBuildIdentity", var()).toString().isEmpty());
}

TEST_CASE ("readBundledNative: a missing index.json is benign (ok:true, zero packages)",
           "[skillfoundry][loader]")
{
    auto resourcesRoot = scratchDir ("native-no-index");

    auto result = CertifiedSkillLoader::readBundledNative (resourcesRoot);
    REQUIRE ((bool) result.getProperty ("ok", false));
    REQUIRE (result.getProperty ("packages", var()).size() == 0);
}

TEST_CASE ("readBundledNative: a missing resources root is a HARD failure (unlike the owner root)",
           "[skillfoundry][loader]")
{
    auto missing = scratchDir ("native-missing-root");
    missing.deleteRecursively();

    auto result = CertifiedSkillLoader::readBundledNative (missing);
    REQUIRE_FALSE ((bool) result.getProperty ("ok", true));
    REQUIRE (result.getProperty ("packages", var()).size() == 0);
    REQUIRE (countDiagnosticsWithCode (result.getProperty ("diagnostics", var()), "root_unreachable") == 1);
}

TEST_CASE ("readBundledNative: a relative root is a hard failure", "[skillfoundry][loader]")
{
    auto result = CertifiedSkillLoader::readBundledNative (File ("relative/resources/dir"));
    REQUIRE_FALSE ((bool) result.getProperty ("ok", true));
    REQUIRE (countDiagnosticsWithCode (result.getProperty ("diagnostics", var()), "root_unreachable") == 1);
}

#else // JUCE_WINDOWS

// No admission path exists yet on Windows (see the header's own note) — every function
// fails closed with a "platform_unsupported" diagnostic and never touches the filesystem.
// This is the ONLY case exercised on this platform until a real Windows port lands.

TEST_CASE ("Windows: every read fails closed with platform_unsupported", "[skillfoundry][loader]")
{
    auto readResult = CertifiedSkillLoader::read (File ("C:\\nonexistent"));
    REQUIRE_FALSE ((bool) readResult.getProperty ("ok", true));
    REQUIRE (countDiagnosticsWithCode (readResult.getProperty ("diagnostics", var()), "platform_unsupported") == 1);

    auto statusResult = CertifiedSkillLoader::readSourceStatus (File ("C:\\nonexistent"));
    REQUIRE_FALSE ((bool) statusResult.getProperty ("ok", true));

    auto nativeResult = CertifiedSkillLoader::readBundledNative (File ("C:\\nonexistent"));
    REQUIRE_FALSE ((bool) nativeResult.getProperty ("ok", true));
}

#endif // ! JUCE_WINDOWS
