#pragma once

#include <juce_core/juce_core.h>

#if MOSH_TESTING
 #include <functional>
#endif

#include "SessionOwnershipPosix.h"

namespace mosh::sessionpaths
{
    inline constexpr const char* kHarnessRootName = "_harness";
    inline constexpr const char* kHarnessOwnershipFile = ".mosh-harness-owned-v1";
    inline constexpr const char* kHarnessOwnershipContents = "Mosh isolated harness session v1";

   #if MOSH_TESTING
    struct IsolationOwnershipTestHooks
    {
        std::function<void()> afterDirectoryOpened;
        std::function<void(const juce::File&)> afterQuarantinedDirectoryOpened;
    };
   #endif

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
       #if JUCE_WINDOWS
        const auto marker = directory.getChildFile (kHarnessOwnershipFile);
        return marker.existsAsFile() && ! marker.isSymbolicLink()
            && marker.loadFileAsString() == kHarnessOwnershipContents;
       #else
        auto opened = detail::openAbsoluteDirectory (directory, false);
        return opened && detail::markerMatches (
            opened.get(), kHarnessOwnershipFile, kHarnessOwnershipContents);
       #endif
    }

    inline bool createFreshOwnedIsolationDirectory (
        const juce::File& containmentRoot, const juce::File& directory
       #if MOSH_TESTING
        , const IsolationOwnershipTestHooks* hooks = nullptr
       #endif
    )
    {
       #if JUCE_WINDOWS
        // Fail closed until the Windows port has an equivalent reparse-point-safe,
        // handle-relative ownership implementation.
        juce::ignoreUnused (containmentRoot, directory);
       #if MOSH_TESTING
        juce::ignoreUnused (hooks);
       #endif
        return false;
       #else
        auto parent = detail::openParent (containmentRoot, directory, true, true);
        if (! parent || ::mkdirat (parent->fd.get(), parent->leaf.c_str(), 0700) != 0)
            return false;

        auto opened = detail::openChildDirectory (parent->fd.get(), parent->leaf);
        const auto openedIdentity = opened ? detail::identityForFd (opened.get()) : std::nullopt;
        if (! openedIdentity)
            return false;

       #if MOSH_TESTING
        if (hooks != nullptr && hooks->afterDirectoryOpened)
            hooks->afterDirectoryOpened();
       #endif

        if (! detail::writeMarker (
                opened.get(), kHarnessOwnershipFile, kHarnessOwnershipContents))
            return false;

        const auto namedIdentity = detail::identityAt (parent->fd.get(), parent->leaf);
        if (! namedIdentity || ! detail::sameIdentity (*openedIdentity, *namedIdentity))
        {
            ::unlinkat (opened.get(), kHarnessOwnershipFile, 0);
            return false;
        }
        return detail::markerMatches (
            opened.get(), kHarnessOwnershipFile, kHarnessOwnershipContents);
       #endif
    }

    inline bool resetOwnedIsolationDirectory (
        const juce::File& containmentRoot, const juce::File& directory
       #if MOSH_TESTING
        , const IsolationOwnershipTestHooks* hooks = nullptr
       #endif
    )
    {
       #if JUCE_WINDOWS
        juce::ignoreUnused (containmentRoot, directory);
       #if MOSH_TESTING
        juce::ignoreUnused (hooks);
       #endif
        return false;
       #else
        auto root = detail::openAbsoluteDirectory (containmentRoot, false);
        auto parent = detail::openParent (containmentRoot, directory, false, false);
        if (! root || ! parent)
            return false;

        auto owned = detail::openChildDirectory (parent->fd.get(), parent->leaf);
        const auto ownedIdentity = owned ? detail::identityForFd (owned.get()) : std::nullopt;
        if (! ownedIdentity || ! detail::markerMatches (
                owned.get(), kHarnessOwnershipFile, kHarnessOwnershipContents))
            return false;

        const auto quarantineName = std::string (".mosh-reset-")
            + juce::Uuid().toString().toStdString();
        if (::mkdirat (root.get(), quarantineName.c_str(), 0700) != 0)
            return false;
        auto quarantine = detail::openChildDirectory (root.get(), quarantineName);
        if (! quarantine)
        {
            ::unlinkat (root.get(), quarantineName.c_str(), AT_REMOVEDIR);
            return false;
        }

        constexpr const char* movedName = "session";
        if (::renameat (parent->fd.get(), parent->leaf.c_str(),
                        quarantine.get(), movedName) != 0)
        {
            ::unlinkat (root.get(), quarantineName.c_str(), AT_REMOVEDIR);
            return false;
        }

        auto moved = detail::openChildDirectory (quarantine.get(), movedName);
        const auto movedIdentity = moved ? detail::identityForFd (moved.get()) : std::nullopt;
        if (! movedIdentity || ! detail::sameIdentity (*ownedIdentity, *movedIdentity)
            || ! detail::markerMatches (
                moved.get(), kHarnessOwnershipFile, kHarnessOwnershipContents))
            return false;

       #if MOSH_TESTING
        if (hooks != nullptr && hooks->afterQuarantinedDirectoryOpened)
            hooks->afterQuarantinedDirectoryOpened (
                containmentRoot.getChildFile (quarantineName).getChildFile (movedName));
       #endif

        // Keep the verified session under its unique quarantine instead of recursively
        // unlinking it. POSIX has no identity-conditional unlink: a concurrent writer
        // could replace a checked child in the final check-to-unlink window. Atomic
        // relocation frees the requested path while preserving every captured entry for
        // recovery, including a replacement that raced with this reset.
        const auto currentIdentity = detail::identityAt (quarantine.get(), movedName);
        return currentIdentity && detail::sameIdentity (*movedIdentity, *currentIdentity)
            && detail::markerMatches (
                moved.get(), kHarnessOwnershipFile, kHarnessOwnershipContents);
       #endif
    }
}
