// N1 (2026-09-23 real-app walkthrough) -- the intermittent SIGSEGV in JUCE's macOS menu-bar
// rebuild (MenuBarModel::handleAsyncUpdate -> JuceMainMenuHandler::menuBarItemsChanged ->
// -[NSMenu removeItemAtIndex:] -> NSMenuItem dealloc -> PopupMenu::Item::~Item). Main.cpp
// called MenuController::refresh() on EVERY snapshot_invalidated, so one `+ Chords` batch
// tore down and rebuilt the whole NSMenu bar several times inside ~150 ms. The only thing
// that rebuild exists for is File > Open Recent, so the rebuild is now gated on that list
// actually changing (src/app/RecentMenuSignature.h). Engine-free: juce_core only.
#include <catch2/catch_test_macros.hpp>
#include "app/RecentMenuSignature.h"

using namespace mosh::recentmenu;

namespace
{
juce::var entry (const juce::String& path, const juce::String& name)
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("path", path);
    o->setProperty ("name", name);
    return juce::var (o);
}

// A FRESH var each call: the session hands the menu a new array on every read, so equality
// has to be by content, never by object identity.
juce::var recents (std::initializer_list<std::pair<const char*, const char*>> items)
{
    juce::Array<juce::var> out;
    for (auto& [path, name] : items)
        out.add (entry (path, name));
    return juce::var (out);
}
} // namespace

TEST_CASE ("recent menu: N identical Recent lists want exactly one rebuild", "[recentmenu]")
{
    RefreshGate gate;
    int rebuilds = 0;
    for (int i = 0; i < 25; ++i)   // a batch's worth of snapshot_invalidated events
        if (gate.shouldRefresh (recents ({ { "/p/a.mosh", "a" }, { "/p/b.mosh", "b" } })))
            ++rebuilds;
    CHECK (rebuilds == 1);
}

TEST_CASE ("recent menu: a primed gate asks for nothing until the list changes", "[recentmenu]")
{
    RefreshGate gate;
    gate.prime (recents ({ { "/p/a.mosh", "a" } }));   // the menu was just built from this
    CHECK_FALSE (gate.shouldRefresh (recents ({ { "/p/a.mosh", "a" } })));
    CHECK_FALSE (gate.shouldRefresh (recents ({ { "/p/a.mosh", "a" } })));
    CHECK (gate.shouldRefresh (recents ({ { "/p/b.mosh", "b" }, { "/p/a.mosh", "a" } })));   // Save As / Open
    CHECK_FALSE (gate.shouldRefresh (recents ({ { "/p/b.mosh", "b" }, { "/p/a.mosh", "a" } })));
}

TEST_CASE ("recent menu: every visible difference is a change", "[recentmenu]")
{
    const auto base = recents ({ { "/p/a.mosh", "a" }, { "/p/b.mosh", "b" } });
    CHECK (signatureOf (base) == signatureOf (recents ({ { "/p/a.mosh", "a" }, { "/p/b.mosh", "b" } })));
    CHECK (signatureOf (base) != signatureOf (recents ({ { "/p/b.mosh", "b" }, { "/p/a.mosh", "a" } })));   // order
    CHECK (signatureOf (base) != signatureOf (recents ({ { "/p/a.mosh", "A" }, { "/p/b.mosh", "b" } })));   // name
    CHECK (signatureOf (base) != signatureOf (recents ({ { "/q/a.mosh", "a" }, { "/p/b.mosh", "b" } })));   // path
    CHECK (signatureOf (base) != signatureOf (recents ({ { "/p/a.mosh", "a" } })));                          // removed
    // Field boundaries are not ambiguous: moving characters between path and name changes it.
    CHECK (signatureOf (recents ({ { "/p/ab", "c" } })) != signatureOf (recents ({ { "/p/a", "bc" } })));
}

TEST_CASE ("recent menu: no list and an empty list render the same submenu", "[recentmenu]")
{
    CHECK (signatureOf (juce::var()) == signatureOf (juce::var (juce::Array<juce::var>())));
    RefreshGate gate;
    gate.prime (juce::var());
    CHECK_FALSE (gate.shouldRefresh (juce::var (juce::Array<juce::var>())));
    CHECK (gate.shouldRefresh (recents ({ { "/p/a.mosh", "a" } })));
}
