#pragma once

#include <filesystem>

#include <juce_core/juce_core.h>

namespace mosh::sessionpaths
{
    inline constexpr const char* kHarnessRootName = "_harness";
    inline constexpr const char* kHarnessOwnershipFile = ".mosh-harness-owned-v1";
    inline constexpr const char* kHarnessOwnershipContents = "Mosh isolated harness session v1";

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

    inline bool hasIsolationOwnershipMarker (const juce::File& directory)
    {
        const auto marker = directory.getChildFile (kHarnessOwnershipFile);
        return marker.existsAsFile()
            && ! marker.isSymbolicLink()
            && marker.loadFileAsString() == kHarnessOwnershipContents;
    }

    inline bool createFreshOwnedIsolationDirectory (const juce::File& containmentRoot,
                                                     const juce::File& directory)
    {
        if (directory.exists() || directory.isSymbolicLink()
            || ! isContainedWithoutSymlinks (containmentRoot, directory))
            return false;

        if (directory.getParentDirectory().createDirectory().failed()
            || ! isContainedWithoutSymlinks (containmentRoot, directory))
            return false;

        std::error_code error;
        const auto created = std::filesystem::create_directory (
            std::filesystem::path (directory.getFullPathName().toStdString()), error);
        if (! created || error || directory.isSymbolicLink()
            || ! isContainedWithoutSymlinks (containmentRoot, directory))
            return false;

        const auto marker = directory.getChildFile (kHarnessOwnershipFile);
        return marker.replaceWithText (kHarnessOwnershipContents)
            && hasIsolationOwnershipMarker (directory);
    }

    inline bool resetOwnedIsolationDirectory (const juce::File& containmentRoot,
                                               const juce::File& directory)
    {
        if (! directory.isDirectory() || directory.isSymbolicLink()
            || ! isContainedWithoutSymlinks (containmentRoot, directory)
            || ! hasIsolationOwnershipMarker (directory))
            return false;

        const auto quarantine = containmentRoot.getChildFile (
            ".mosh-reset-" + juce::Uuid().toString());
        std::error_code error;
        const auto quarantinePath = std::filesystem::path (
            quarantine.getFullPathName().toStdString());
        if (! std::filesystem::create_directory (quarantinePath, error) || error)
            return false;
        std::filesystem::permissions (
            quarantinePath,
            std::filesystem::perms::owner_all,
            std::filesystem::perm_options::replace,
            error);
        if (error)
        {
            std::filesystem::remove (quarantinePath, error);
            return false;
        }

        const auto quarantined = quarantine.getChildFile ("session");
        std::filesystem::rename (
            std::filesystem::path (directory.getFullPathName().toStdString()),
            std::filesystem::path (quarantined.getFullPathName().toStdString()),
            error);
        if (error)
        {
            std::filesystem::remove (quarantinePath, error);
            return false;
        }

        if (! quarantined.isDirectory() || quarantined.isSymbolicLink()
            || ! isContainedWithoutSymlinks (quarantine, quarantined)
            || ! hasIsolationOwnershipMarker (quarantined))
        {
            if (! directory.exists() && ! directory.isSymbolicLink())
            {
                error.clear();
                std::filesystem::rename (
                    std::filesystem::path (quarantined.getFullPathName().toStdString()),
                    std::filesystem::path (directory.getFullPathName().toStdString()),
                    error);
            }
            if (! quarantined.exists() && ! quarantined.isSymbolicLink())
            {
                error.clear();
                std::filesystem::remove (quarantinePath, error);
            }
            return false;
        }

        if (! quarantined.deleteRecursively())
            return false;
        error.clear();
        return std::filesystem::remove (quarantinePath, error) && ! error;
    }
}
