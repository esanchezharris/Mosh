#pragma once

#include <juce_core/juce_core.h>

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
// default now self-isolates, and an explicit override still wins verbatim -- the
// existing contract (pass a known leaf, read artifacts back out of it) is untouched.
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

    /** Resolves the session-dir leaf name.

        @param baseName          the mode's base leaf ("session-selftest", ...). Empty
                                 or "session" means the interactive GUI, never isolated.
        @param explicitOverride  raw MOSH_SELFTEST_SESSION value (may be empty/blank).
        @param uniqueTag         per-process tag; see processTag().
    */
    inline juce::String resolveSessionLeaf (const juce::String& baseName,
                                            const juce::String& explicitOverride,
                                            const juce::String& uniqueTag)
    {
        // An explicitly requested leaf always wins verbatim: callers that set it are
        // reading artifacts back out of that exact path afterwards.
        if (const auto s = explicitOverride.trim(); s.isNotEmpty())
            return s;

        // The GUI keeps the owner's real session dir. Auto-isolating here would
        // silently orphan their project every launch.
        if (baseName.isEmpty() || baseName == "session")
            return "session";

        return baseName + kAutoMarker + uniqueTag;
    }

    inline bool isContainedWithoutSymlinks (const juce::File& root,
                                            const juce::File& candidate)
    {
        if (! candidate.isAChildOf (root) || root.isSymbolicLink())
            return false;

        for (auto current = candidate; current != root; current = current.getParentDirectory())
            if (current.isSymbolicLink())
                return false;

        return true;
    }

    /** Resolves the project directory without allowing an environment-controlled
        leaf or a symlinked ancestor to escape the Mosh application-data root. */
    inline juce::File resolveSessionDirectory (const juce::File& moshDir,
                                               const juce::String& sessionLeaf,
                                               const juce::String& uniqueTag,
                                               bool useOwnerSession)
    {
        const auto requested = moshDir.getChildFile (sessionLeaf);
        if ((useOwnerSession || sessionLeaf != "session")
            && isContainedWithoutSymlinks (moshDir, requested))
            return requested;

        return moshDir.getChildFile ("session-safety-auto-" + uniqueTag);
    }

    /** Resolves Tracktion's property-storage directory for this launch.

        Only a true interactive GUI launch keeps the legacy ~/Library/Mosh/Settings.xml
        path. Named harness/audit sessions, including an explicit reserved "session"
        override, cannot read or rewrite the owner's device/plugin preferences.
    */
    inline juce::File resolvePropertyStorageDir (const juce::File& moshDir,
                                                 const juce::String& sessionLeaf,
                                                 const juce::String& uniqueTag,
                                                 bool useOwnerStorage)
    {
        if (useOwnerStorage)
            return moshDir;

        const auto root = moshDir.getChildFile ("_settings");
        const auto requested = root.getChildFile (sessionLeaf);
        if (isContainedWithoutSymlinks (root, requested))
            return requested;

        return moshDir.getChildFile ("_settings-safety-auto-" + uniqueTag);
    }

    /** Which non-interactive mode (if any) this launch is. Mirrors Main.cpp's flags. */
    struct HarnessModes
    {
        bool selfTest        = false;   // --selftest
        bool undoSelfTest    = false;   // --selftest-undo
        bool goldenSelfTest  = false;   // --golden-selftest
        bool liveAudioSmoke  = false;   // --live-audio-smoke
        bool scanDeep        = false;   // --scan-plugins-deep
        bool runScript       = false;   // --run-script
        bool voiceSmoke      = false;   // --voice-smoke
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
        if (m.scanDeep)       return "session-scan";
        if (m.runScript)      return "session-run-script";
        if (m.demoGui)        return "session-demo";
        if (m.voiceSmoke)     return "session-voice-smoke";
        if (m.selfTest)       return "session-selftest";

        // Device-free but flagless: still not the GUI (it wipes), so keep it off "session".
        if (m.envNoAudio)     return "session-selftest";

        return {};   // interactive GUI
    }

    /** True only for leaves resolveSessionLeaf() generated -- the pruner's safety gate. */
    inline bool isAutoIsolatedLeaf (const juce::String& leafName)
    {
        return leafName.startsWith ("session-") && leafName.contains (kAutoMarker);
    }

    /** How long an auto-isolated dir must be untouched before the pruner may delete it.
        Generous on purpose: a CONCURRENT run's dir must never be mistaken for garbage
        (that would reintroduce the very bug this file exists to fix). A harness run is
        minutes at most, so a day of silence means the run is long gone.
    */
    inline constexpr int kPruneAfterHours = 24;

    /** Marks a directory this scheme moved aside instead of deleting. Distinct from
        kAutoMarker so the pruner (which only ever touches "-auto-" dirs) leaves these
        alone — a preserved dir must outlive the run that rescued it.
    */
    inline constexpr const char* kLegacyMarker = "-legacy-";

    /** Moves a pre-existing REAL directory at the pointer path out of the way.

        NEVER deletes it. The tempting premise — "the legacy harness dir was wiped by
        every run anyway, so it was never durable state" — is precisely what SLF-CONC-001
        disproved: since #246 (2026-07-07) the interactive GUI's session ALSO resolved to
        "session-selftest", so a real directory at a legacy harness path can hold the
        owner's actual project. This function keys off a directory's NAME, which says
        nothing about its CONTENTS, so deleting is never justified here. Renaming costs
        nothing and turns the worst case from silent permanent data loss into "an oddly
        named folder appeared".

        @returns where it was moved, or an empty File if nothing needed moving.
    */
    inline juce::File preserveLegacyDir (const juce::File& pointer)
    {
        if (! pointer.isDirectory() || pointer.isSymbolicLink())
            return {};

        const auto stamp = juce::Time::getCurrentTime().formatted ("%Y%m%d-%H%M%S");
        auto aside = pointer.getSiblingFile (pointer.getFileName() + kLegacyMarker + stamp);

        // Two runs racing within the same second must not clobber each other's rescue.
        if (aside.exists())
            aside = pointer.getSiblingFile (pointer.getFileName() + kLegacyMarker + stamp
                                            + "-" + juce::Uuid().toString().substring (0, 8));

        return pointer.moveFileTo (aside) ? aside : juce::File();
    }

    /** Points <moshDir>/<baseName> at the run's real dir and prunes stale auto dirs.

        Auto-isolation would otherwise break every "look in ~/Library/Mosh/session-selftest
        afterwards" habit (scripts/validate-command-log-contract.sh defaults to exactly that
        path). The legacy path therefore survives as a symlink to the most recent run.
        Concurrent runs race to own it; last writer wins, which is fine for inspection.
    */
    inline void publishLatestPointer (const juce::File& moshDir,
                                      const juce::String& baseName,
                                      const juce::File& actualSessionDir)
    {
        // Never touch the GUI dir, whatever the caller passed.
        if (baseName.isEmpty() || baseName == "session")
            return;

        const auto pointer = moshDir.getChildFile (baseName);

        // A pre-existing REAL directory is PRESERVED, not deleted (see preserveLegacyDir).
        // A symlink is our own pointer from an earlier run — that IS disposable, so unlink it.
        if (pointer.isDirectory() && ! pointer.isSymbolicLink())
            preserveLegacyDir (pointer);
        else if (pointer.exists() || pointer.isSymbolicLink())
            pointer.deleteFile();

        // Best-effort: a failed symlink (e.g. Windows without the privilege) must never
        // fail the run — the real session dir is printed at startup either way.
        juce::File::createSymbolicLink (pointer, actualSessionDir.getFullPathName(), true);

        // Prune this base's stale auto dirs. Guarded three ways: the name must be one
        // WE generated, must belong to THIS base, and must be untouched for a day.
        const auto now = juce::Time::getCurrentTime();
        for (const auto& child : moshDir.findChildFiles (juce::File::findDirectories, false))
        {
            const auto leaf = child.getFileName();
            if (! isAutoIsolatedLeaf (leaf) || ! leaf.startsWith (baseName + kAutoMarker))
                continue;
            if (child == actualSessionDir || child.isSymbolicLink())
                continue;
            if ((now - child.getLastModificationTime()).inHours() < (double) kPruneAfterHours)
                continue;   // could be a live run — leave it alone
            child.deleteRecursively();
        }
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
