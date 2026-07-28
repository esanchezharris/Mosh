#include <catch2/catch_test_macros.hpp>
#include "state/SafeMode.h"

// FS-T2 — plugin-crash SAFE MODE, the pure half.
//
// The load-time policy ("open this project without third-party plugins") is a ValueTree
// scrub, so it lives in a header-only, engine-free seam exactly like state/Migrations.h and
// is unit-tested here with zero engine dependency.
//
// VERIFIED against the pinned tracktion_engine clone (2877b621):
// ExternalPlugin::xmlTypeName == "vst" (tracktion_ExternalPlugin.cpp:696) and EVERY hosted
// VST/VST3/AU persists as <PLUGIN type="vst" uid filename manufacturer name/> (:668-674).
// So type == "vst" is the exact discriminator for "third-party", and it agrees with the
// runtime discriminator MoshOps already uses (dynamic_cast<te::ExternalPlugin*>).
// Mosh/Tracktion built-ins carry their own xmlTypeName and are untouched BY CONSTRUCTION.

using namespace mosh::safemode;

namespace
{
    juce::ValueTree pluginNode (const juce::String& type, const juce::String& name)
    {
        juce::ValueTree p ("PLUGIN");
        p.setProperty ("type", type, nullptr);
        p.setProperty ("name", name, nullptr);
        return p;
    }

    juce::ValueTree externalNode (const juce::String& name,
                                  const juce::String& manufacturer,
                                  const juce::String& filename,
                                  const juce::String& uid)
    {
        auto p = pluginNode ("vst", name);
        p.setProperty ("manufacturer", manufacturer, nullptr);
        p.setProperty ("filename", filename, nullptr);
        p.setProperty ("uid", uid, nullptr);
        return p;
    }

    // A realistic edit: two audio tracks, each with built-ins around a third-party insert,
    // plus a clip so we can prove the scrub does not disturb arrangement content.
    juce::ValueTree makeEditState()
    {
        juce::ValueTree edit ("EDIT");

        juce::ValueTree t1 ("TRACK");
        t1.setProperty ("name", "Drums", nullptr);
        juce::ValueTree clip ("AUDIOCLIP");
        clip.setProperty ("name", "loop", nullptr);
        t1.appendChild (clip, nullptr);
        t1.appendChild (pluginNode ("volume", "Volume & Pan"), nullptr);
        t1.appendChild (externalNode ("OTT", "Xfer Records", "/Library/Audio/Plug-Ins/VST3/OTT.vst3", "6f7474"), nullptr);
        t1.appendChild (pluginNode ("level", "Level Meter"), nullptr);
        edit.appendChild (t1, nullptr);

        juce::ValueTree t2 ("TRACK");
        t2.setProperty ("name", "Lead", nullptr);
        t2.appendChild (externalNode ("Vital", "Vital Audio", "/Library/Audio/Plug-Ins/VST3/Vital.vst3", "76974c"), nullptr);
        t2.appendChild (pluginNode ("sampler", "Sampler"), nullptr);
        edit.appendChild (t2, nullptr);

        edit.appendChild (pluginNode ("masterSpectralTap", "Spectral Tap"), nullptr);
        return edit;
    }

    int countNodes (const juce::ValueTree& t, const juce::Identifier& type)
    {
        int n = (t.hasType (type) ? 1 : 0);
        for (int i = 0; i < t.getNumChildren(); ++i) n += countNodes (t.getChild (i), type);
        return n;
    }
}

TEST_CASE ("a PLUGIN node of type vst is third-party; built-ins are not", "[safemode]")
{
    REQUIRE (isThirdPartyPluginNode (externalNode ("OTT", "Xfer", "/x/OTT.vst3", "1")));

    // Every built-in Mosh/Tracktion insert Mosh actually creates.
    REQUIRE_FALSE (isThirdPartyPluginNode (pluginNode ("volume", "Volume & Pan")));
    REQUIRE_FALSE (isThirdPartyPluginNode (pluginNode ("level", "Level Meter")));
    REQUIRE_FALSE (isThirdPartyPluginNode (pluginNode ("sampler", "Sampler")));
    REQUIRE_FALSE (isThirdPartyPluginNode (pluginNode ("masterSpectralTap", "Spectral Tap")));
    REQUIRE_FALSE (isThirdPartyPluginNode (pluginNode ("auxsend", "Aux Send")));
    REQUIRE_FALSE (isThirdPartyPluginNode (pluginNode ("auxreturn", "Aux Return")));

    // A non-PLUGIN node that merely carries type="vst" must not be mistaken for one.
    juce::ValueTree decoy ("TRACK");
    decoy.setProperty ("type", "vst", nullptr);
    REQUIRE_FALSE (isThirdPartyPluginNode (decoy));
}

TEST_CASE ("collect finds every third-party plugin in document order with its identity", "[safemode]")
{
    auto st = makeEditState();
    const auto found = collectThirdPartyPlugins (st);

    REQUIRE (found.size() == 2);
    REQUIRE (found[0].name == "OTT");
    REQUIRE (found[0].manufacturer == "Xfer Records");
    REQUIRE (found[0].filename == "/Library/Audio/Plug-Ins/VST3/OTT.vst3");
    REQUIRE (found[0].uid == "6f7474");
    REQUIRE (found[1].name == "Vital");
    REQUIRE (found[1].manufacturer == "Vital Audio");
}

TEST_CASE ("collect on a project with no third-party plugins is empty", "[safemode]")
{
    juce::ValueTree edit ("EDIT");
    juce::ValueTree t ("TRACK");
    t.appendChild (pluginNode ("volume", "Volume & Pan"), nullptr);
    edit.appendChild (t, nullptr);

    REQUIRE (collectThirdPartyPlugins (edit).empty());
}

TEST_CASE ("scrub removes exactly the third-party plugins and nothing else", "[safemode]")
{
    auto st = makeEditState();
    // 6 PLUGIN nodes: volume + OTT + level on Drums, Vital + sampler on Lead, master tap.
    REQUIRE (countNodes (st, "PLUGIN") == 6);

    const int removed = scrubThirdPartyPlugins (st);
    REQUIRE (removed == 2);

    // The two externals are gone...
    REQUIRE (collectThirdPartyPlugins (st).empty());
    // ...and every built-in survives (6 - 2 = 4).
    REQUIRE (countNodes (st, "PLUGIN") == 4);

    // Arrangement content is untouched: both tracks, the clip, and the built-in racks.
    REQUIRE (countNodes (st, "TRACK") == 2);
    REQUIRE (countNodes (st, "AUDIOCLIP") == 1);
    REQUIRE (st.getChild (0).getProperty ("name").toString() == "Drums");
    REQUIRE (st.getChild (0).getChildWithProperty ("type", "volume").isValid());
    REQUIRE (st.getChild (0).getChildWithProperty ("type", "level").isValid());
    REQUIRE (st.getChild (1).getChildWithProperty ("type", "sampler").isValid());
    REQUIRE (st.getChildWithProperty ("type", "masterSpectralTap").isValid());
}

TEST_CASE ("scrub is idempotent — a second pass removes nothing", "[safemode]")
{
    auto st = makeEditState();
    REQUIRE (scrubThirdPartyPlugins (st) == 2);
    REQUIRE (scrubThirdPartyPlugins (st) == 0);
}

TEST_CASE ("scrub reaches plugins nested at any depth", "[safemode]")
{
    // Tracktion nests racks/folder tracks, so a flat top-level walk would silently miss one
    // — which would let the very plugin that crashed the load be re-instantiated in safe mode.
    juce::ValueTree edit ("EDIT");
    juce::ValueTree folder ("FOLDERTRACK");
    juce::ValueTree inner ("TRACK");
    inner.appendChild (externalNode ("Serum", "Xfer", "/x/Serum.vst3", "5e"), nullptr);
    folder.appendChild (inner, nullptr);
    edit.appendChild (folder, nullptr);

    REQUIRE (collectThirdPartyPlugins (edit).size() == 1);
    REQUIRE (scrubThirdPartyPlugins (edit) == 1);
    REQUIRE (collectThirdPartyPlugins (edit).empty());
    REQUIRE (countNodes (edit, "TRACK") == 1);        // the nested track itself survives
}

// ─── breadcrumb: the crash-suspect record written across a load ───

TEST_CASE ("breadcrumb round-trips the plugins a load is about to instantiate", "[safemode]")
{
    auto st = makeEditState();
    const auto crumb = makeBreadcrumb (collectThirdPartyPlugins (st));

    const auto suspects = suspectsFromBreadcrumb (crumb);
    REQUIRE (suspects.size() == 2);
    REQUIRE (suspects[0] == "OTT");
    REQUIRE (suspects[1] == "Vital");
}

TEST_CASE ("an empty or malformed breadcrumb yields no suspects", "[safemode]")
{
    REQUIRE (suspectsFromBreadcrumb ("").empty());
    REQUIRE (suspectsFromBreadcrumb ("   ").empty());
    REQUIRE (suspectsFromBreadcrumb ("not json at all").empty());
    REQUIRE (suspectsFromBreadcrumb ("{\"plugins\":\"wrong type\"}").empty());
}

TEST_CASE ("a lone suspect is quarantinable; an ambiguous one is not", "[safemode]")
{
    // The honest limit of this design: the breadcrumb brackets the WHOLE load, so when a
    // project brings up several plugins we cannot say which one crashed. Safe mode still
    // skips them all, but block_plugin must only fire on an UNAMBIGUOUS suspect — otherwise
    // a crash quarantines innocent plugins the user paid for.
    REQUIRE (quarantineTarget ({ "OTT" }) == "OTT");
    REQUIRE (quarantineTarget ({ "OTT", "Vital" }).isEmpty());
    REQUIRE (quarantineTarget ({}).isEmpty());
}
