#pragma once

#include <juce_gui_extra/juce_gui_extra.h>
#include <functional>

namespace mosh
{
/** The native macOS menu bar (File + Edit). It does NOT mutate Tracktion or call
    MoshOps directly: every item forwards a `{ action, file? }` intent to the WebView
    over the bridge's event channel, and the UI's single runAction dispatcher turns
    it into the corresponding MoshOps command (reusing the existing native file
    pickers for Open/Save As/Export). That keeps ONE definition of each command and
    matches the swappable-seam rule — the menu is just another client of the seam.

    Accelerators (⌘N/⌘O/⌘S/⇧⌘S/⌘E, ⌘Z/⇧⌘Z/⌘X/⌘C/⌘V) are real NSMenu key-equivalents;
    the WebView keyboard layer YIELDS those chords when a native menu is present, so a
    keystroke fires exactly once (via the menu → forwarded here → runAction). Delete is
    intentionally NOT given a key-equivalent (it would hijack ⌫ in text fields) — the
    web layer owns it. */
class MenuController : public juce::MenuBarModel,
                      public juce::ApplicationCommandTarget
{
public:
    /** Forwards a menu intent to the WebView: a JSON object { action, file? }. */
    using ActionSink = std::function<void (const juce::var&)>;
    /** Returns the session's recentProjects array ([{ path, name }], newest-first). */
    using RecentProvider = std::function<juce::var()>;

    MenuController (ActionSink sink, RecentProvider recents);
    ~MenuController() override;

    /** Rebuild the menus (e.g. after the Recent list changed). Message thread only. */
    void refresh() { menuItemsChanged(); }

    // MenuBarModel ----------------------------------------------------------------
    juce::StringArray getMenuBarNames() override;
    juce::PopupMenu getMenuForIndex (int topLevelMenuIndex, const juce::String& menuName) override;
    void menuItemSelected (int menuItemID, int topLevelMenuIndex) override;

    // ApplicationCommandTarget ----------------------------------------------------
    juce::ApplicationCommandTarget* getNextCommandTarget() override { return nullptr; }
    void getAllCommands (juce::Array<juce::CommandID>& commands) override;
    void getCommandInfo (juce::CommandID commandID, juce::ApplicationCommandInfo& result) override;
    bool perform (const juce::ApplicationCommandTarget::InvocationInfo& info) override;

private:
    void fire (const juce::String& action, const juce::String& file = {});

    // MenuController is the command target, but it is not a Component, so the default
    // focus-based getFirstCommandTarget() can never reach it — leaving every menu item
    // disabled and un-invokable. This manager pins the target explicitly so menu clicks
    // and accelerators route to perform().
    struct TargetedCommandManager : juce::ApplicationCommandManager
    {
        juce::ApplicationCommandTarget* target = nullptr;
        juce::ApplicationCommandTarget* getFirstCommandTarget (juce::CommandID) override { return target; }
    };

    TargetedCommandManager commands;
    ActionSink sink;
    RecentProvider recents;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MenuController)
};

} // namespace mosh
