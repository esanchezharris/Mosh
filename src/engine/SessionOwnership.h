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
        std::function<void(const juce::File&)> beforeQuarantineReclaimed;
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

   #if ! JUCE_WINDOWS
    namespace detail
    {
        inline constexpr const char* kQuarantinedSessionName = "session";

        /** A reset session, relocated under a quarantine this process just created. The
            descriptors stay open so a later reclaim acts on these exact directories. */
        struct QuarantinedSession
        {
            OwnedFd root;
            std::string name;
            OwnedFd quarantine;
            OwnedFd session;
            FileIdentity identity;
        };

        inline std::optional<QuarantinedSession> quarantineOwnedIsolationDirectory (
            const juce::File& containmentRoot, const juce::File& directory
           #if MOSH_TESTING
            , const IsolationOwnershipTestHooks* hooks
           #endif
        )
        {
            auto root = openAbsoluteDirectory (containmentRoot, false);
            auto parent = openParent (containmentRoot, directory, false, false);
            if (! root || ! parent)
                return std::nullopt;

            auto owned = openChildDirectory (parent->fd.get(), parent->leaf);
            const auto ownedIdentity = owned ? identityForFd (owned.get()) : std::nullopt;
            if (! ownedIdentity || ! markerMatches (
                    owned.get(), kHarnessOwnershipFile, kHarnessOwnershipContents))
                return std::nullopt;

            const auto quarantineName = std::string (".mosh-reset-")
                + juce::Uuid().toString().toStdString();
            if (::mkdirat (root.get(), quarantineName.c_str(), 0700) != 0)
                return std::nullopt;
            auto quarantine = openChildDirectory (root.get(), quarantineName);
            if (! quarantine)
            {
                ::unlinkat (root.get(), quarantineName.c_str(), AT_REMOVEDIR);
                return std::nullopt;
            }

            if (::renameat (parent->fd.get(), parent->leaf.c_str(),
                            quarantine.get(), kQuarantinedSessionName) != 0)
            {
                ::unlinkat (root.get(), quarantineName.c_str(), AT_REMOVEDIR);
                return std::nullopt;
            }

            auto moved = openChildDirectory (quarantine.get(), kQuarantinedSessionName);
            const auto movedIdentity = moved ? identityForFd (moved.get()) : std::nullopt;
            if (! movedIdentity || ! sameIdentity (*ownedIdentity, *movedIdentity)
                || ! markerMatches (
                    moved.get(), kHarnessOwnershipFile, kHarnessOwnershipContents))
                return std::nullopt;

           #if MOSH_TESTING
            if (hooks != nullptr && hooks->afterQuarantinedDirectoryOpened)
                hooks->afterQuarantinedDirectoryOpened (
                    containmentRoot.getChildFile (quarantineName)
                                   .getChildFile (kQuarantinedSessionName));
           #endif

            // Relocation, not a recursive unlink, is what frees the requested path. POSIX
            // has no identity-conditional unlink: a concurrent writer could replace a
            // checked child in the final check-to-unlink window. Atomic relocation frees
            // the path while preserving every captured entry for recovery, including a
            // replacement that raced with this reset.
            const auto currentIdentity = identityAt (quarantine.get(), kQuarantinedSessionName);
            if (! currentIdentity || ! sameIdentity (*movedIdentity, *currentIdentity)
                || ! markerMatches (
                    moved.get(), kHarnessOwnershipFile, kHarnessOwnershipContents))
                return std::nullopt;

            return QuarantinedSession { std::move (root), quarantineName, std::move (quarantine),
                                        std::move (moved), *movedIdentity };
        }

        /** Deletes a quarantine created by quarantineOwnedIsolationDirectory.

            Every step goes through descriptors opened on the verified directories, never a
            path: symlinks are unlinked rather than followed, and a directory is only
            entered if it is the same real directory an lstat saw, on the same device.
            Anything that no longer matches (a swapped session, an unexpected sibling, an
            entry that cannot be removed) stops the reclaim and stays where it is.
            Quarantines holding model, adapter, checkpoint or evaluation files are kept. */
        inline bool reclaimQuarantinedSession (QuarantinedSession& quarantined,
                                               const juce::File& containmentRoot
                                              #if MOSH_TESTING
                                               , const IsolationOwnershipTestHooks* hooks
                                              #endif
        )
        {
           #if MOSH_TESTING
            if (hooks != nullptr && hooks->beforeQuarantineReclaimed)
                hooks->beforeQuarantineReclaimed (
                    containmentRoot.getChildFile (quarantined.name)
                                   .getChildFile (kQuarantinedSessionName));
           #else
            juce::ignoreUnused (containmentRoot);
           #endif

            const auto stillNamed = [&quarantined]
            {
                const auto current = identityAt (quarantined.quarantine.get(),
                                                 kQuarantinedSessionName);
                return current && sameIdentity (quarantined.identity, *current);
            };

            const auto device = quarantined.identity.device;
            if (! stillNamed()
                || ! markerMatches (quarantined.session.get(),
                                    kHarnessOwnershipFile, kHarnessOwnershipContents)
                || containsRetainedEvidence (quarantined.session.get(), device, 0)
                || ! removeTreeContents (quarantined.session.get(), device, 0)
                || ! stillNamed()
                || ::unlinkat (quarantined.quarantine.get(), kQuarantinedSessionName,
                               AT_REMOVEDIR) != 0)
                return false;

            return ::unlinkat (quarantined.root.get(), quarantined.name.c_str(),
                               AT_REMOVEDIR) == 0;
        }
    }
   #endif

    /** Moves an owned directory into a unique `.mosh-reset-*` quarantine beside it and
        keeps it there for recovery. */
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
        return detail::quarantineOwnedIsolationDirectory (containmentRoot, directory
                                                         #if MOSH_TESTING
                                                          , hooks
                                                         #endif
                                                          ).has_value();
       #endif
    }

    /** Resets like resetOwnedIsolationDirectory, then deletes the quarantine this call
        created (see detail::reclaimQuarantinedSession). The result reports the reset: a
        declined reclaim leaves the quarantine for recovery or a later sweep. A directory
        whose own name marks it as evidence (for example `eval-*`) is never reclaimed. */
    inline bool resetAndReclaimOwnedIsolationDirectory (
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
        auto quarantined = detail::quarantineOwnedIsolationDirectory (containmentRoot, directory
                                                                     #if MOSH_TESTING
                                                                      , hooks
                                                                     #endif
                                                                      );
        if (! quarantined)
            return false;

        if (! detail::isEvidenceDirectoryName (directory.getFileName().toStdString()))
            detail::reclaimQuarantinedSession (*quarantined, containmentRoot
                                              #if MOSH_TESTING
                                               , hooks
                                              #endif
                                               );
        return true;
       #endif
    }
}
