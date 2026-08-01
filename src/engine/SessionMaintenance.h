#pragma once

#include "SessionPaths.h"

namespace mosh::sessionpaths
{
    inline constexpr int kPruneAfterHours = 24;
    inline constexpr const char* kLegacyMarker = "-legacy-";

    inline juce::File preserveLegacyDir (const juce::File& pointer)
    {
        if (! pointer.isDirectory() || pointer.isSymbolicLink())
            return {};

        const auto stamp = juce::Time::getCurrentTime().formatted ("%Y%m%d-%H%M%S");
        auto aside = pointer.getSiblingFile (pointer.getFileName() + kLegacyMarker + stamp);
        if (aside.exists())
            aside = pointer.getSiblingFile (pointer.getFileName() + kLegacyMarker + stamp
                                            + "-" + juce::Uuid().toString().substring (0, 8));

        return pointer.moveFileTo (aside) ? aside : juce::File();
    }

    inline void publishLatestPointer (const juce::File& moshDir,
                                      const juce::String& baseName,
                                      const juce::File& actualSessionDir)
    {
        if (baseName.isEmpty() || baseName == "session")
            return;

        // A generated-looking name is not proof of ownership. The engine marks a
        // new run before writing artifacts; direct callers may claim only an empty
        // directory. Otherwise pointer publication and pruning must both stop.
        if (! isOwnedAutoSession (moshDir, actualSessionDir)
            && ! markOwnedAutoSession (moshDir, actualSessionDir))
            return;

        const auto pointer = moshDir.getChildFile (baseName);
        if (pointer.isDirectory() && ! pointer.isSymbolicLink())
            preserveLegacyDir (pointer);
        else if (pointer.exists() || pointer.isSymbolicLink())
            pointer.deleteFile();

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
            child.deleteRecursively();
        }
    }
}
