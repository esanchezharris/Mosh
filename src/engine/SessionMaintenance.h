#pragma once

#include "SessionPaths.h"

namespace mosh::sessionpaths
{
    inline constexpr int kPruneAfterHours = 24;
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
            const auto previous = pointer.getLinkedTarget();
            canPublish = previous.getFileName().startsWith (baseName + kAutoMarker)
                && isOwnedAutoSession (moshDir, previous);
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
            // marker establishes that recursive deletion is permitted.
            if (! isOwnedAutoSession (moshDir, child))
                continue;
            if ((now - child.getLastModificationTime()).inHours() < (double) kPruneAfterHours)
                continue;
            resetOwnedIsolationDirectory (moshDir, child);
        }
    }
}
