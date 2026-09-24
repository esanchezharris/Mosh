#pragma once

#include <juce_core/juce_core.h>

#include <utility>

namespace mosh::recentmenu
{
/** A cheap identity for the File > Open Recent submenu: every entry's path and display name,
    in order. Two lists with the same signature render the same submenu, and anything that
    is not an array (no session yet) renders the same "No Recent Projects" as an empty one.
    Engine-free on purpose, so MoshTests pins it (tests/test_recent_menu_signature.cpp). */
inline juce::String signatureOf (const juce::var& recents)
{
    juce::String sig;
    if (auto* entries = recents.getArray())
        for (auto& e : *entries)
        {
            // Length-prefixed fields, so text moving between path and name can never collide.
            const auto path = e.getProperty ("path", juce::var()).toString();
            const auto name = e.getProperty ("name", juce::var()).toString();
            sig << path.length() << ':' << path << '|' << name.length() << ':' << name << ';';
        }
    return sig;
}

/** Decides whether the native menu bar needs a rebuild. JUCE rebuilds the macOS menu bar
    wholesale (every NSMenuItem released and re-made, JuceMainMenuHandler::menuBarItemsChanged),
    and doing that on every snapshot_invalidated -- several times per command batch -- is what
    the 2026-09-23 SIGSEGV in PopupMenu::Item::~Item crashed inside. The only thing that
    rebuild is for is the Recent submenu (command enablement follows the watched
    ApplicationCommandManager on its own), so it happens only when that list changed.
    Message thread only, like the menu it guards. */
class RefreshGate
{
public:
    /** Records the list the menu was just BUILT from, without asking for a rebuild. */
    void prime (const juce::var& recents)
    {
        last = signatureOf (recents);
        primed = true;
    }

    /** True the first time (when never primed) and whenever the list differs from the last
        one this gate answered for; false for every repeat of the same list. */
    bool shouldRefresh (const juce::var& recents)
    {
        auto sig = signatureOf (recents);
        if (primed && sig == last)
            return false;
        last = std::move (sig);
        primed = true;
        return true;
    }

private:
    juce::String last;
    bool primed = false;
};
} // namespace mosh::recentmenu
