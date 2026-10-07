#pragma once

#include "SessionPaths.h"

#if ! JUCE_WINDOWS
 #include <cerrno>
 #include <sys/stat.h>
#endif

namespace mosh::sessionpaths
{
    inline constexpr int kPruneAfterHours = 24;

    // True only when nothing at all is at `entry`, not even a dangling symlink: lstat
    // examines the name itself and never a link's destination. Fails closed on Windows,
    // like the ownership primitives.
    inline bool isAbsentEntry (const juce::File& entry)
    {
       #if JUCE_WINDOWS
        juce::ignoreUnused (entry);
        return false;
       #else
        struct stat info {};
        return ::lstat (entry.getFullPathName().toRawUTF8(), &info) != 0 && errno == ENOENT;
       #endif
    }

    inline void publishLatestPointer (const juce::File& moshDir,
                                      const juce::String& baseName,
                                      const juce::File& actualSessionDir)
    {
        if (baseName.isEmpty() || baseName == "session")
            return;

        if (! isOwnedAutoSession (moshDir, actualSessionDir))
            return;

        const auto pointer = moshDir.getChildFile (baseName);
        bool canPublish = ! pointer.exists() && ! pointer.isSymbolicLink();
        if (pointer.isSymbolicLink())
        {
            // The link's own text (one readlink); the link is never followed.
            const auto previous = pointer.getLinkedTarget();
            const bool previousIsThisBasesAutoSession =
                previous.getParentDirectory() == moshDir
                && previous.getFileName().startsWith (baseName + kAutoMarker);
            // A pruned run can no longer prove ownership (the marker lived inside it),
            // but with nothing left at its name the pointer guards nothing either.
            canPublish = previousIsThisBasesAutoSession
                && (isOwnedAutoSession (moshDir, previous) || isAbsentEntry (previous));
        }

        if (canPublish && pointer.isSymbolicLink())
            pointer.deleteFile();
        if (canPublish)
            juce::File::createSymbolicLink (pointer, actualSessionDir.getFullPathName(), true);

        const auto now = juce::Time::getCurrentTime();
        for (const auto& child : moshDir.findChildFiles (juce::File::findDirectories, false))
        {
            const auto leaf = child.getFileName();
            if (! isAutoIsolatedLeaf (leaf) || ! leaf.startsWith (baseName + kAutoMarker))
                continue;
            if (child == actualSessionDir || child.isSymbolicLink())
                continue;
            // Names and age are attacker/owner-controlled metadata. Only the exact
            // marker permits relocation into a reset quarantine.
            if (! isOwnedAutoSession (moshDir, child))
                continue;
            if ((now - child.getLastModificationTime()).inHours() < (double) kPruneAfterHours)
                continue;
            // Delete the quarantine this prune creates (descriptor-relative, never
            // following symlinks); trees holding model/adapter/checkpoint/evaluation
            // evidence stay quarantined. Older `.mosh-reset-*` entries are left for
            // scripts/verify-hardware/harness_session.py's manifest sweep.
            resetAndReclaimOwnedIsolationDirectory (moshDir, child);
        }
    }
}
