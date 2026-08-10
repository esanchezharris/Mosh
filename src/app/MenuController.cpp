#include "MenuController.h"

namespace mosh
{
namespace
{
    // Command IDs for the menu items (one per File/Edit action). Recent-project
    // items use a separate dynamic ID range (they aren't fixed commands).
    enum CommandIDs
    {
        fileNew = 0x6d01,   // 'm'osh menu base
        fileOpen,
        fileSave,
        fileSaveAs,
        fileExport,
        fileClose,
        editUndo,
        editRedo,
        editCut,
        editCopy,
        editPaste,
        editDelete,
        transportPlayPause,
    };

    constexpr int recentBaseID = 0x6e00; // Open Recent items: recentBaseID + index
    constexpr int maxRecentItems = 12;

    // "Check for Updates…" lives in the APPLICATION menu (Mosh ▸), where macOS users
    // look for it — not in File/Edit/Transport. JUCE reaches that menu only through
    // setMacMainMenu's extraAppleMenuItems, and those items arrive at
    // menuItemSelected() with topLevelMenuIndex == -1, never through perform(). Hence
    // its own ID range rather than a CommandID.
    constexpr int appCheckForUpdatesID = 0x6f01;
}

MenuController::MenuController (ActionSink s, RecentProvider r, UpdateAction u)
    : sink (std::move (s)), recents (std::move (r)), checkForUpdates (std::move (u))
{
    commands.target = this;                       // route invocations to perform()
    commands.registerAllCommandsForTarget (this); // register command info + key-equivalents
    setApplicationCommandManagerToWatch (&commands);

   #if JUCE_MAC
    // The single top-level menu bar across the whole app (macOS). JUCE supplies the
    // standard application menu (incl. Quit) from the app name automatically.
    //
    // The updates item is added ONLY when an updater actually exists (Sparkle compiled
    // in AND a feed URL configured). A permanently-dead "Check for Updates…" would be a
    // worse answer than no item: it reads as "this app checks for updates" to a user
    // who would then never get one.
    if (checkForUpdates)
    {
        const auto ell = juce::String::charToString (static_cast<juce::juce_wchar> (0x2026));
        juce::PopupMenu appMenuItems;
        appMenuItems.addItem (appCheckForUpdatesID, "Check for Updates" + ell);
        juce::MenuBarModel::setMacMainMenu (this, &appMenuItems);
    }
    else
    {
        juce::MenuBarModel::setMacMainMenu (this);
    }
   #endif
}

MenuController::~MenuController()
{
   #if JUCE_MAC
    juce::MenuBarModel::setMacMainMenu (nullptr);
   #endif
}

juce::StringArray MenuController::getMenuBarNames()
{
    return { "File", "Edit", "Transport" };
}

juce::PopupMenu MenuController::getMenuForIndex (int topLevelMenuIndex, const juce::String&)
{
    juce::PopupMenu menu;

    if (topLevelMenuIndex == 0) // File
    {
        menu.addCommandItem (&commands, fileNew);
        menu.addCommandItem (&commands, fileOpen);

        // Open Recent ▸ — rebuilt from the session snapshot each time the menu shows.
        juce::PopupMenu recentMenu;
        const auto rp = recents ? recents() : juce::var();
        const int n = (rp.isArray() ? rp.size() : 0);
        if (n > 0)
        {
            for (int i = 0; i < n && i < maxRecentItems; ++i)
            {
                auto name = rp[i].getProperty ("name", {}).toString();
                if (name.isEmpty())
                    name = juce::File (rp[i].getProperty ("path", {}).toString()).getFileName();
                recentMenu.addItem (recentBaseID + i, name);
            }
        }
        else
        {
            recentMenu.addItem (recentBaseID + 999, "No Recent Projects", false, false);
        }
        menu.addSubMenu ("Open Recent", recentMenu);

        menu.addSeparator();
        menu.addCommandItem (&commands, fileSave);
        menu.addCommandItem (&commands, fileSaveAs);
        menu.addSeparator();
        menu.addCommandItem (&commands, fileExport);
        menu.addSeparator();
        menu.addCommandItem (&commands, fileClose);
    }
    else if (topLevelMenuIndex == 1) // Edit
    {
        menu.addCommandItem (&commands, editUndo);
        menu.addCommandItem (&commands, editRedo);
        menu.addSeparator();
        menu.addCommandItem (&commands, editCut);
        menu.addCommandItem (&commands, editCopy);
        menu.addCommandItem (&commands, editPaste);
        menu.addSeparator();
        menu.addCommandItem (&commands, editDelete);
    }
    else if (topLevelMenuIndex == 2)
    {
        menu.addCommandItem (&commands, transportPlayPause);
    }

    return menu;
}

void MenuController::menuItemSelected (int menuItemID, int /*topLevelMenuIndex*/)
{
    // Only the dynamic Open-Recent items and the application-menu extras arrive here;
    // command items go via perform().
    if (menuItemID == appCheckForUpdatesID)
    {
        if (checkForUpdates)
            checkForUpdates();
        return;
    }

    if (menuItemID >= recentBaseID && menuItemID < recentBaseID + maxRecentItems)
    {
        const int i = menuItemID - recentBaseID;
        const auto rp = recents ? recents() : juce::var();
        if (rp.isArray() && i < rp.size())
        {
            const auto path = rp[i].getProperty ("path", {}).toString();
            if (path.isNotEmpty())
                fire ("open_project", path);
        }
    }
}

void MenuController::getAllCommands (juce::Array<juce::CommandID>& c)
{
    c.addArray ({ fileNew, fileOpen, fileSave, fileSaveAs, fileExport, fileClose,
                  editUndo, editRedo, editCut, editCopy, editPaste, editDelete,
                  transportPlayPause });
}

void MenuController::getCommandInfo (juce::CommandID commandID, juce::ApplicationCommandInfo& result)
{
    using namespace juce;
    const auto cmd = ModifierKeys::commandModifier;
    const auto cmdShift = ModifierKeys::commandModifier | ModifierKeys::shiftModifier;
    // U+2026 HORIZONTAL ELLIPSIS built from the code point — a raw "\xe2\x80\xa6" UTF-8
    // string literal mis-decoded to "â¦" in the NSMenu title on this toolchain.
    const auto ell = String::charToString (static_cast<juce_wchar> (0x2026));

    switch (commandID)
    {
        case fileNew:     result.setInfo ("New", "Start a new project", "File", 0);            result.addDefaultKeypress ('n', cmd); break;
        case fileOpen:    result.setInfo ("Open" + ell, "Open a project", "File", 0);          result.addDefaultKeypress ('o', cmd); break;
        case fileSave:    result.setInfo ("Save", "Save the project", "File", 0);              result.addDefaultKeypress ('s', cmd); break;
        case fileSaveAs:  result.setInfo ("Save As" + ell, "Save a portable copy", "File", 0); result.addDefaultKeypress ('s', cmdShift); break;
        case fileExport:  result.setInfo ("Export Audio" + ell, "Export the mix", "File", 0);  result.addDefaultKeypress ('r', cmdShift); break;   // ⇧⌘R, like Live — ⌘E is Split (Edit › Split)
        case fileClose:   result.setInfo ("Close", "Close the window", "File", 0);             result.addDefaultKeypress ('w', cmd); break;

        case editUndo:    result.setInfo ("Undo", "Undo the last change", "Edit", 0);          result.addDefaultKeypress ('z', cmd); break;
        case editRedo:    result.setInfo ("Redo", "Redo the last change", "Edit", 0);          result.addDefaultKeypress ('z', cmdShift); break;
        case editCut:     result.setInfo ("Cut", "Cut the selected clip", "Edit", 0);          result.addDefaultKeypress ('x', cmd); break;
        case editCopy:    result.setInfo ("Copy", "Copy the selected clip", "Edit", 0);        result.addDefaultKeypress ('c', cmd); break;
        case editPaste:   result.setInfo ("Paste", "Paste the clip", "Edit", 0);              result.addDefaultKeypress ('v', cmd); break;
        // Delete: no key-equivalent on purpose (⌫ must keep working in text fields);
        // the WebView keyboard layer owns the Delete/Backspace shortcut.
        case editDelete:  result.setInfo ("Delete", "Remove the selected clip", "Edit", 0);    break;
        case transportPlayPause:
            result.setInfo ("Play/Pause", "Toggle playback", "Transport", 0);
            // Space: NO key-equivalent — the NSMenu would swallow the keystroke before
            // any responder sees it (the same hijack the code documents for Delete
            // below). The WebView keymap owns play/pause (ableton preset: Space).
            break;
        default: break;
    }
}

bool MenuController::perform (const juce::ApplicationCommandTarget::InvocationInfo& info)
{
    switch (info.commandID)
    {
        case fileNew:     fire ("new_project");  return true;
        case fileOpen:    fire ("open_project"); return true;
        case fileSave:    fire ("save");         return true;
        case fileSaveAs:  fire ("save_as");      return true;
        case fileExport:  fire ("export_audio"); return true;
        case fileClose:
            if (auto* app = juce::JUCEApplication::getInstance())
                app->systemRequestedQuit();
            return true;

        case editUndo:    fire ("undo");   return true;
        case editRedo:    fire ("redo");   return true;
        case editCut:     fire ("cut");    return true;
        case editCopy:    fire ("copy");   return true;
        case editPaste:   fire ("paste");  return true;
        case editDelete:  fire ("delete"); return true;
        case transportPlayPause: fire ("play_pause"); return true;
        default: return false;
    }
}

void MenuController::fire (const juce::String& action, const juce::String& file)
{
    if (! sink)
        return;
    auto* o = new juce::DynamicObject();
    o->setProperty ("action", action);
    if (file.isNotEmpty())
        o->setProperty ("file", file);
    sink (juce::var (o));
}

} // namespace mosh
