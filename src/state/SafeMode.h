#pragma once

#include <juce_data_structures/juce_data_structures.h>
#include <vector>

// FS-T2 — plugin-crash SAFE MODE: the load-time policy, as pure ValueTree logic.
//
// A hosted third-party plugin that crashes while a project is being loaded is unrecoverable
// by the normal path: every relaunch re-loads the same project and re-crashes on the same
// plugin. Safe mode breaks that loop by opening the project with third-party plugin nodes
// scrubbed OUT of the state before Tracktion ever instantiates them ("load then remove"
// cannot work — loading is what crashes).
//
// Header-only + engine-free (juce_data_structures only) so it unit-tests in MoshTests with
// zero engine dependency, mirroring state/Migrations.h and state/RenderLayer.h.
namespace mosh::safemode
{
    /** The ValueTree `type` every hosted VST/VST3/AU node carries.

        VERIFIED against the pinned tracktion_engine clone (2877b621):
        `ExternalPlugin::xmlTypeName == "vst"` (tracktion_ExternalPlugin.cpp:696), and
        ExternalPlugin::create writes <PLUGIN type="vst" uid filename manufacturer name/>
        for every external format including VST3 and AudioUnit (:668-674).

        This is the exact complement of Mosh's runtime discriminator
        (`dynamic_cast<te::ExternalPlugin*>`): every Mosh/Tracktion built-in — volume/pan,
        LevelMeterPlugin, SamplerPlugin, MasterSpectralTapPlugin, aux send/return, RAVE —
        declares its own xmlTypeName, so built-ins are preserved BY CONSTRUCTION rather than
        by an allowlist that would silently drift as inserts are added.

        `--selftest` asserts this string still equals `te::ExternalPlugin::xmlTypeName`, so a
        Tracktion bump that renamed it would fail the gate instead of silently disarming safe
        mode. */
    inline const char* const kExternalPluginType = "vst";

    /** Identity of one hosted third-party plugin, read straight off its PLUGIN node.
        `name` is the block id: PluginHost::findDescription matches `d.name == pluginId`
        (and `filename` for an absolute VST3 path), so block_plugin accepts it as-is. */
    struct PluginRef { juce::String name, manufacturer, filename, uid; };

    /** True iff this node is a hosted third-party plugin. Requires BOTH the PLUGIN node type
        and type=="vst" — a non-PLUGIN node that merely carries a `type` property is not one. */
    inline bool isThirdPartyPluginNode (const juce::ValueTree& node)
    {
        return node.hasType ("PLUGIN")
            && node.getProperty ("type").toString() == kExternalPluginType;
    }

    /** Every third-party plugin in the edit state, in document order.

        Recursive: Tracktion nests tracks inside folder tracks and racks, and a flat
        top-level walk would miss those — letting the very plugin that crashed the load be
        re-instantiated in "safe" mode. */
    inline std::vector<PluginRef> collectThirdPartyPlugins (const juce::ValueTree& tree)
    {
        std::vector<PluginRef> out;
        if (isThirdPartyPluginNode (tree))
            out.push_back ({ tree.getProperty ("name").toString(),
                             tree.getProperty ("manufacturer").toString(),
                             tree.getProperty ("filename").toString(),
                             tree.getProperty ("uid").toString() });

        for (int i = 0; i < tree.getNumChildren(); ++i)
            for (auto& p : collectThirdPartyPlugins (tree.getChild (i)))
                out.push_back (p);

        return out;
    }

    /** Remove every third-party plugin node, at any depth. Returns how many were removed.

        Built-in inserts, tracks, clips and all other arrangement content are untouched: the
        project opens complete, minus the third-party racks. Iterates children in REVERSE so
        removal never shifts an index we have yet to visit. Non-undoable (nullptr UndoManager)
        — this is a pre-load scrub of a detached tree, not a user edit, so it must not enter
        the one undo system. */
    inline int scrubThirdPartyPlugins (juce::ValueTree& tree)
    {
        int removed = 0;
        for (int i = tree.getNumChildren(); --i >= 0;)
        {
            auto child = tree.getChild (i);
            if (isThirdPartyPluginNode (child))
            {
                tree.removeChild (i, nullptr);
                ++removed;
            }
            else
            {
                removed += scrubThirdPartyPlugins (child);
            }
        }
        return removed;
    }

    /** Serialise the plugins a load is about to instantiate, for the crash breadcrumb. */
    inline juce::String makeBreadcrumb (const std::vector<PluginRef>& plugins)
    {
        juce::Array<juce::var> arr;
        for (auto& p : plugins)
        {
            auto* o = new juce::DynamicObject();
            o->setProperty ("name", p.name);
            o->setProperty ("manufacturer", p.manufacturer);
            o->setProperty ("filename", p.filename);
            o->setProperty ("uid", p.uid);
            arr.add (juce::var (o));
        }
        auto* root = new juce::DynamicObject();
        root->setProperty ("plugins", arr);
        return juce::JSON::toString (juce::var (root), true);
    }

    /** Plugin names recorded in a breadcrumb. Malformed/absent input yields none — a
        corrupt breadcrumb must never be read as "everything is a suspect". */
    inline std::vector<juce::String> suspectsFromBreadcrumb (const juce::String& contents)
    {
        std::vector<juce::String> names;
        const auto parsed = juce::JSON::parse (contents);
        if (! parsed.isObject()) return names;

        const auto plugins = parsed.getProperty ("plugins", juce::var());
        if (auto* arr = plugins.getArray())          // bound to a NAMED local: a juce::var
            for (auto& e : *arr)                     // temporary's array dies with the
            {                                        // if-condition (a real UAF in this repo)
                const auto n = e.getProperty ("name", juce::var()).toString();
                if (n.isNotEmpty()) names.push_back (n);
            }
        return names;
    }

    /** The plugin to quarantine via block_plugin, or "" when there is no unambiguous one.

        The breadcrumb brackets the WHOLE load, so a project that brings up several plugins
        leaves several candidates and we cannot say which one crashed. Safe mode still skips
        them all — that is the user-facing promise — but blocklisting is reserved for a LONE
        suspect. Quarantining a set would punish innocent plugins the user paid for on the
        strength of a guess, and the blocklist persists across launches. */
    inline juce::String quarantineTarget (const std::vector<juce::String>& suspects)
    {
        return suspects.size() == 1 ? suspects.front() : juce::String();
    }
}
