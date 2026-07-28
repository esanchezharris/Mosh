#pragma once

#include <juce_core/juce_core.h>
#include <memory>

namespace mosh
{
/** The Sparkle 2 auto-updater host (FS-K2).

    Deliberately NOT a MoshOps command. MoshOps owns the ONE mutation path for
    everything that changes the user's session; an update check changes nothing in the
    Edit, produces no undo transaction and no event — routing it through the command
    spine would only dilute what that spine means. It is a native app affordance, like
    the menu bar itself, and it lives in the menu bar for that reason.

    Three states, and the difference between the last two matters:
      • not compiled in  — MOSH_HAVE_SPARKLE undefined (-DMOSH_ENABLE_SPARKLE=OFF, or
                           any non-Apple build). isAvailable() is false forever.
      • compiled, unconfigured — the framework is embedded but no SUFeedURL is baked in.
                           isAvailable() is false, and the menu item is not offered at
                           all rather than offered-and-inert.
      • live             — a feed URL is configured; checkForUpdates() drives Sparkle's
                           own UI (progress, release notes, install-and-relaunch).

    Message thread only, and GUI runs only: constructing this in a headless `--selftest`
    process would put an updater controller behind a run with no event loop to drive it. */
class SparkleUpdater
{
public:
    SparkleUpdater();
    ~SparkleUpdater();

    SparkleUpdater (const SparkleUpdater&) = delete;
    SparkleUpdater& operator= (const SparkleUpdater&) = delete;

    /** True when Sparkle is compiled in AND a feed URL resolved. Only then is
        checkForUpdates() anything other than a no-op. */
    bool isAvailable() const;

    /** The appcast URL actually in use — Info.plist SUFeedURL, or the
        MOSH_SPARKLE_FEED_URL environment override (see the .mm for why that override
        exists and why it is safe). Empty when unavailable. */
    juce::String feedUrl() const;

    /** Show Sparkle's "check for updates" UI. No-op when !isAvailable(). */
    void checkForUpdates();

private:
    struct Impl;
    std::unique_ptr<Impl> impl;
};

} // namespace mosh
