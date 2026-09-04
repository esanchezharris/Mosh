#pragma once

#include <juce_core/juce_core.h>

#include <optional>

#include "SessionOwnership.h"

#if JUCE_WINDOWS
 #include <process.h>
#else
 #include <unistd.h>
#endif

// Session-dir leaf resolution (SLF-CONC-001).
//
// Headless harness modes (--selftest, --selftest-undo, --run-script, the live-audio
// smoke) each used a FIXED leaf under ~/Library/Mosh, and MoshEngine wipes that dir
// with deleteRecursively() at startup when freshSession is set. So two concurrent
// runs on one host pointed at the SAME directory and deleted each other's exports,
// saved edit and mosh-log.jsonl mid-test -- a gate's pass/fail depended on whether
// another agent or worktree happened to be running at the time.
//
// MOSH_SELFTEST_SESSION already solved this for callers that opt in (gate.sh,
// verify.py, installed-app-gate.sh all pass one). The gap was the DEFAULT: a plain
// `Mosh --selftest`, which is what a human or a naive agent actually runs. So the
// default now self-isolates. Explicit overrides are honored only inside the dedicated
// _harness namespace; unsafe or unowned paths fall back to a unique safety directory.
//
// Same root-cause class as PR #342's hermetic service ports, for a session dir
// instead of a network port.
namespace mosh::sessionpaths
{
    // Marks a leaf this scheme generated, so the pruner can distinguish its own
    // garbage from the owner's GUI "session", a caller's explicit gate leaf, or the
    // legacy fixed names. Deliberately distinctive -- deleting the wrong dir here
    // would destroy someone's project.
    inline constexpr const char* kAutoMarker = "-auto-";
    inline constexpr const char* kSafetyPrefix = "session-safety-auto-";

    inline juce::File moshDataDirectory (bool allowTestRoot)
    {
        const auto requested = juce::SystemStats::getEnvironmentVariable (
            "MOSH_TEST_MOSH_DIR", {}).trim();
        if (allowTestRoot
            && juce::SystemStats::getEnvironmentVariable (
                   "MOSH_ENABLE_TEST_MOSH_DIR", {}) == "1"
            && juce::File::isAbsolutePath (requested))
            return juce::File (requested);

        return juce::File::getSpecialLocation (
            juce::File::userApplicationDataDirectory).getChildFile ("Mosh");
    }

    inline bool isAutoIsolatedLeaf (const juce::String& leafName)
    {
        return leafName.startsWith ("session-") && leafName.contains (kAutoMarker);
    }

    inline bool isSafetyIsolatedLeaf (const juce::String& leafName)
    {
        return leafName.startsWith (kSafetyPrefix);
    }

    /** Resolves the session-dir leaf name.

        @param baseName          the mode's base leaf ("session-selftest", ...). Empty
                                 or "session" means the interactive GUI, never isolated.
        @param explicitOverride  raw MOSH_SELFTEST_SESSION value (may be empty/blank).
        @param uniqueTag         per-process tag; see processTag().
        @param nestedEngine      true for a SECONDARY MoshEngine constructed inside an
                                 already-running harness process (e.g. simulated MP
                                 host/guest peers in SelfTest.cpp) -- never true for the
                                 one outer engine Main.cpp constructs per launch.

        Without nestedEngine, every MoshEngine built while MOSH_SELFTEST_SESSION is set
        resolves to the SAME leaf (the override is honored verbatim, baseName is
        ignored) -- correct for the single outer engine, but it silently collides
        multiple secondary engines constructed within one process onto one directory,
        each wiping the others' files via freshSession's reset. nestedEngine=true nests
        the leaf under the override instead, keyed by the secondary engine's own
        baseName, so distinct purposes (host/guest/authority/...) get distinct,
        non-colliding directories while the outer engine still lands exactly at the
        literal override.
    */
    inline juce::String resolveSessionLeaf (const juce::String& baseName,
                                            const juce::String& explicitOverride,
                                            const juce::String& uniqueTag,
                                            bool nestedEngine = false)
    {
        // Preserve an explicit request verbatim for validation. The requested
        // filesystem path does not necessarily win: unsafe or unowned requests are
        // redirected to a unique safety directory by resolveSessionDirectory.
        if (const auto s = explicitOverride.trim(); s.isNotEmpty())
        {
            if (nestedEngine && baseName.isNotEmpty() && baseName != "session")
                return s + "/" + baseName;
            return s;
        }

        // The GUI keeps the owner's real session dir. Auto-isolating here would
        // silently orphan their project every launch.
        if (baseName.isEmpty() || baseName == "session")
            return "session";

        return baseName + kAutoMarker + uniqueTag;
    }

    inline juce::File safetySessionDirectory (const juce::File& moshDir,
                                              const juce::String& uniqueTag)
    {
        return moshDir.getChildFile (kSafetyPrefix + uniqueTag);
    }

    inline std::optional<juce::File> prepareSafetySessionDirectory (
        const juce::File& moshDir, const juce::String& uniqueTag)
    {
        for (int attempt = 0; attempt < 4; ++attempt)
        {
            const auto suffix = attempt == 0
                ? uniqueTag
                : uniqueTag + "-" + juce::Uuid().toString().substring (0, 8);
            const auto directory = safetySessionDirectory (moshDir, suffix);
            if (directory.exists())
            {
                if (directory.isDirectory()
                    && isContainedWithoutSymlinks (moshDir, directory)
                    && hasIsolationOwnershipMarker (directory))
                    return directory;
                continue;
            }
            if (createFreshOwnedIsolationDirectory (moshDir, directory))
                return directory;
        }
        return {};
    }

    inline bool isHarnessSessionDirectory (const juce::File& moshDir,
                                           const juce::File& directory)
    {
        return isContainedWithoutSymlinks (moshDir.getChildFile (kHarnessRootName),
                                           directory);
    }

    inline bool isOwnedHarnessSession (const juce::File& moshDir,
                                       const juce::File& directory)
    {
        if (! directory.isDirectory() || ! isHarnessSessionDirectory (moshDir, directory))
            return false;

        return hasIsolationOwnershipMarker (directory);
    }

    inline bool isAutoSessionDirectory (const juce::File& moshDir,
                                        const juce::File& directory)
    {
        return directory.getParentDirectory() == moshDir
            && isAutoIsolatedLeaf (directory.getFileName())
            && isContainedWithoutSymlinks (moshDir, directory);
    }

    inline bool isOwnedAutoSession (const juce::File& moshDir,
                                    const juce::File& directory)
    {
        if (! directory.isDirectory() || ! isAutoSessionDirectory (moshDir, directory))
            return false;

        return hasIsolationOwnershipMarker (directory);
    }

    inline bool createOwnedAutoSession (const juce::File& moshDir,
                                        const juce::File& directory)
    {
        if (! isAutoSessionDirectory (moshDir, directory))
            return false;
        return createFreshOwnedIsolationDirectory (moshDir, directory);
    }

    /** Creates and marks a new `_harness` directory as resettable.

        Refusing every existing unowned directory, even an empty one, is deliberate:
        path contents can change after observation, so an arbitrary existing directory
        must never be claimed merely because a caller supplied it. */
    inline bool createOwnedHarnessSession (const juce::File& moshDir,
                                           const juce::File& directory)
    {
        if (! isHarnessSessionDirectory (moshDir, directory))
            return false;
        return createFreshOwnedIsolationDirectory (
            moshDir.getChildFile (kHarnessRootName), directory);
    }

    inline bool resetOwnedHarnessSession (const juce::File& moshDir,
                                          const juce::File& directory)
    {
        return isOwnedHarnessSession (moshDir, directory)
            && resetOwnedIsolationDirectory (
                moshDir.getChildFile (kHarnessRootName), directory);
    }

    /** Resolves the project directory without allowing an environment-controlled
        leaf or a symlinked ancestor to escape the Mosh application-data root.

        Explicit overrides are resettable only below `_harness`, and an existing
        directory there must carry our ownership marker. Other explicit names route
        to a unique safety directory instead of risking owner data. */
    inline juce::File resolveSessionDirectory (const juce::File& moshDir,
                                               const juce::String& sessionLeaf,
                                               const juce::String& uniqueTag,
                                               bool useOwnerSession,
                                               bool explicitOverride)
    {
        const auto requested = moshDir.getChildFile (sessionLeaf);
        if (useOwnerSession)
            return moshDir.getChildFile ("session");

        if (explicitOverride
            && isHarnessSessionDirectory (moshDir, requested)
            && (! requested.exists()
                || isOwnedHarnessSession (moshDir, requested)))
            return requested;

        if (! explicitOverride
            && isAutoIsolatedLeaf (sessionLeaf)
            && requested.getParentDirectory() == moshDir
            && isContainedWithoutSymlinks (moshDir, requested)
            && (! requested.exists() || isOwnedAutoSession (moshDir, requested)))
            return requested;

        return safetySessionDirectory (moshDir, uniqueTag);
    }

    inline std::optional<juce::File> resolveIdentitySessionDirectory (
        const juce::File& moshDir, const juce::String& explicitOverride,
        const juce::String& uniqueTag)
    {
        if (explicitOverride.trim().isEmpty())
            return moshDir.getChildFile ("session");

        auto directory = resolveSessionDirectory (
            moshDir, explicitOverride.trim(), uniqueTag, false, true);
        if (directory == safetySessionDirectory (moshDir, uniqueTag))
            return prepareSafetySessionDirectory (moshDir, uniqueTag);

        if (! isOwnedHarnessSession (moshDir, directory)
            && ! createOwnedHarnessSession (moshDir, directory))
            return prepareSafetySessionDirectory (moshDir, uniqueTag);
        return directory;
    }

    /** Resolves Tracktion's property-storage directory for this launch.

        Only a true interactive GUI launch keeps the legacy ~/Library/Mosh/Settings.xml
        path. Named harness/audit sessions, including an explicit reserved "session"
        override, cannot read or rewrite the owner's device/plugin preferences.
    */
    inline std::optional<juce::File> resolvePropertyStorageDir (
        const juce::File& moshDir, const juce::File& sessionDirectory,
        const juce::String& uniqueTag, bool useOwnerStorage)
    {
        if (useOwnerStorage)
            return moshDir;

        if (! isContainedWithoutSymlinks (moshDir, sessionDirectory))
        {
            const auto safeSession = prepareSafetySessionDirectory (moshDir, uniqueTag);
            if (! safeSession)
                return std::nullopt;
            return safeSession->getChildFile ("_settings/run-" + uniqueTag);
        }

        const auto root = sessionDirectory.getChildFile ("_settings");
        const auto requested = root.getChildFile ("run-" + uniqueTag);
        if (isContainedWithoutSymlinks (root, requested))
            return requested;

        const auto safeSession = prepareSafetySessionDirectory (moshDir, uniqueTag);
        if (! safeSession)
            return std::nullopt;
        return safeSession->getChildFile ("_settings/run-" + uniqueTag);
    }

    /** Which non-interactive mode (if any) this launch is. Mirrors Main.cpp's flags. */
    struct HarnessModes
    {
        bool selfTest        = false;   // --selftest
        bool undoSelfTest    = false;   // --selftest-undo
        bool goldenSelfTest  = false;   // --golden-selftest
        bool liveAudioSmoke  = false;   // --live-audio-smoke
        bool midiRecordSmoke = false;   // --midi-record-smoke
        bool scanDeep        = false;   // --scan-plugins-deep
        bool runScript       = false;   // --run-script
        bool demoGui         = false;   // --demo3/5/6
        bool envNoAudio      = false;   // MOSH_NO_AUDIO=1
    };

    /** The session base leaf for a launch. Empty means "the interactive GUI" -- the
        owner's real "session" dir, which must never be auto-isolated or wiped.

        Everything that is NOT the interactive GUI gets a harness base, including a
        bare MOSH_NO_AUDIO=1 launch: those wipe their session dir at startup, so
        handing them the GUI leaf would delete the owner's project.
    */
    inline juce::String harnessSessionBase (const HarnessModes& m)
    {
        if (m.undoSelfTest)   return "session-selftest-undo";
        if (m.goldenSelfTest) return "session-golden-selftest";
        if (m.liveAudioSmoke) return "session-live-audio-smoke";
        if (m.midiRecordSmoke) return "session-midi-record-smoke";
        if (m.scanDeep)       return "session-scan";
        if (m.runScript)      return "session-run-script";
        if (m.demoGui)        return "session-demo";
        if (m.selfTest)       return "session-selftest";

        // Device-free but flagless: still not the GUI (it wipes), so keep it off "session".
        if (m.envNoAudio)     return "session-selftest";

        return {};   // interactive GUI
    }

    /** A per-process tag: pid (greppable against a live process) + a Uuid fragment
        (so a recycled pid can't alias a previous run's dir). Computed once.
    */
    inline juce::String processTag()
    {
        static const juce::String tag = []
        {
           #if JUCE_WINDOWS
            const auto pid = (int) _getpid();
           #else
            const auto pid = (int) getpid();
           #endif
            return juce::String (pid) + "-" + juce::Uuid().toString().substring (0, 8);
        }();
        return tag;
    }
}
