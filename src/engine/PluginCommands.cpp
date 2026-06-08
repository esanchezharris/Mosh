#include "PluginCommands.h"
#include "EngineSnapshot.h"   // pluginToVar
#include "Ids.h"

namespace mosh
{
    namespace te = tracktion;

    static te::AudioTrack* findAudioTrackP (te::Edit& edit, const juce::String& ref)
    {
        juce::String type, id;
        if (! ids::parseRef (ref, type, id)) id = ref;
        for (auto* t : te::getAudioTracks (edit))
            if (t->itemID.toString() == id) return t;
        return nullptr;
    }

    struct FoundPlugin
    {
        te::AudioTrack* track = nullptr;
        te::Plugin::Ptr plugin;
        bool valid() const { return plugin != nullptr && track != nullptr; }
    };

    static FoundPlugin findPlugin (te::Edit& edit, const juce::String& ref)
    {
        juce::String type, id;
        if (! ids::parseRef (ref, type, id)) id = ref;
        for (auto* t : te::getAudioTracks (edit))
            for (auto p : t->pluginList.getPlugins())
                if (p != nullptr && p->itemID.toString() == id)
                    return { t, p };
        return {};
    }

    void registerPluginCommands (DslExecutor& exec, MoshEngine& engine)
    {
        // load_plugin {track, type, index?}
        exec.registerCommand ("load_plugin", [&engine] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto& edit = engine.getEdit();
            auto* track = findAudioTrackP (edit, cmd.argString ("track"));
            if (track == nullptr)
                return MoshResult::failure (error::noSuchTrack, "No such track");
            const auto type = cmd.argString ("type");
            if (type.isEmpty())
                return MoshResult::failure (error::invalidArgs, "plugin type required");

            auto plugin = edit.getPluginCache().createNewPlugin (type, {});
            if (plugin == nullptr)
                return MoshResult::failure (error::invalidArgs, "unknown/unavailable plugin type: " + type);

            const int index = cmd.hasArg ("index") ? cmd.argInt ("index") : -1;   // -1 = append
            track->pluginList.insertPlugin (plugin, index, nullptr);

            const auto ref = ids::pluginRef (plugin->itemID.toString());
            ctx.emit (events::pluginAdded (ids::trackRef (track->itemID.toString()), pluginToVar (plugin.get())));
            auto* data = new juce::DynamicObject(); data->setProperty ("id", ref);
            juce::StringArray changed; changed.add (ref);
            return MoshResult::success ("Loaded plugin", changed, juce::var (data));
        });

        // bypass_plugin {plugin, bypassed}
        exec.registerCommand ("bypass_plugin", [&engine] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto found = findPlugin (engine.getEdit(), cmd.argString ("plugin"));
            if (! found.valid())
                return MoshResult::failure (error::noSuchPlugin, "No such plugin");
            const bool bypassed = cmd.argBool ("bypassed", true);
            found.plugin->setEnabled (! bypassed);   // enabled == not bypassed
            const auto ref = ids::pluginRef (found.plugin->itemID.toString());
            ctx.emit (events::pluginBypassed (ref, bypassed));
            juce::StringArray changed; changed.add (ref);
            return MoshResult::success (bypassed ? "Bypassed plugin" : "Enabled plugin", changed);
        });

        // remove_plugin {plugin}
        exec.registerCommand ("remove_plugin", [&engine] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto found = findPlugin (engine.getEdit(), cmd.argString ("plugin"));
            if (! found.valid())
                return MoshResult::failure (error::noSuchPlugin, "No such plugin");
            const auto ref = ids::pluginRef (found.plugin->itemID.toString());
            found.plugin->removeFromParent();
            ctx.emit (events::snapshotInvalidated());   // no plugin_removed event → UI resyncs
            juce::StringArray changed; changed.add (ref);
            return MoshResult::success ("Removed plugin", changed);
        });

        // reorder_plugin {plugin, index}
        exec.registerCommand ("reorder_plugin", [&engine] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto found = findPlugin (engine.getEdit(), cmd.argString ("plugin"));
            if (! found.valid())
                return MoshResult::failure (error::noSuchPlugin, "No such plugin");
            const int index = cmd.argInt ("index", 0);
            auto keep = found.plugin;                   // Plugin::Ptr keeps it alive across the move
            keep->removeFromParent();
            found.track->pluginList.insertPlugin (keep, index, nullptr);
            ctx.emit (events::snapshotInvalidated());
            juce::StringArray changed; changed.add (ids::pluginRef (keep->itemID.toString()));
            return MoshResult::success ("Reordered plugin", changed);
        });
    }
}
