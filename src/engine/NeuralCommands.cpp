#include "NeuralCommands.h"
#include "NeuralInsertPlugin.h"
#include "EngineSnapshot.h"   // pluginToVar
#include "Ids.h"
#include "Astd.h"

namespace mosh
{
    namespace te = tracktion;

    static te::AudioTrack* findTrackN (te::Edit& edit, const juce::String& ref)
    {
        juce::String type, id;
        if (! ids::parseRef (ref, type, id)) id = ref;
        for (auto* t : te::getAudioTracks (edit))
            if (t->itemID.toString() == id) return t;
        return nullptr;
    }

    static NeuralInsertPlugin* findNeural (te::Edit& edit, const juce::String& ref)
    {
        juce::String type, id;
        if (! ids::parseRef (ref, type, id)) id = ref;
        for (auto* t : te::getAudioTracks (edit))
            for (auto* p : t->pluginList.getPlugins())
                if (p != nullptr && p->itemID.toString() == id)
                    return dynamic_cast<NeuralInsertPlugin*> (p);
        return nullptr;
    }

    // The ASTD registry for the neural insert's macros. One shared impl (spine Astd),
    // both tiers (04 §6 / 05 §6). "amount": raw 0..1, clamped below 0.7 by default.
    static AstdRegistry neuralAstd()
    {
        AstdRegistry r;
        r.set ({ "amount", 0.0, 1.0, 0.0, 0.7, 1.0 });
        return r;
    }

    void registerNeuralCommands (DslExecutor& exec, MoshEngine& engine)
    {
        // add_neural_insert {track, model?}
        exec.registerCommand ("add_neural_insert", [&engine] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto& edit = engine.getEdit();
            auto* track = findTrackN (edit, cmd.argString ("track"));
            if (track == nullptr)
                return MoshResult::failure (error::noSuchTrack, "No such track");

            auto plugin = edit.getPluginCache().createNewPlugin (NeuralInsertPlugin::xmlTypeName, {});
            if (plugin == nullptr)
                return MoshResult::failure (error::internalError, "neural insert type not registered");
            if (auto* ni = dynamic_cast<NeuralInsertPlugin*> (plugin.get()))
                ni->setModelId (cmd.argString ("model", "nam"));

            track->pluginList.insertPlugin (plugin, -1, nullptr);
            const auto ref = ids::pluginRef (plugin->itemID.toString());
            ctx.emit (events::pluginAdded (ids::trackRef (track->itemID.toString()), pluginToVar (plugin.get())));
            auto* data = new juce::DynamicObject(); data->setProperty ("id", ref);
            juce::StringArray changed; changed.add (ref);
            return MoshResult::success ("Added neural insert", changed, juce::var (data));
        });

        // set_neural_param {plugin, param, value(0..100)} — ASTD-clamped (defeatable via Lab)
        exec.registerCommand ("set_neural_param", [&engine] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto* ni = findNeural (engine.getEdit(), cmd.argString ("plugin"));
            if (ni == nullptr)
                return MoshResult::failure (error::noSuchPlugin, "No such neural insert");

            const auto param = cmd.argString ("param", "amount");
            const auto ui = cmd.argDouble ("value", 0.0);           // 0..100
            const auto reg = neuralAstd();
            const double raw = reg.uiToRaw (param, ui, ni->isLabMode());

            if (param == "amount")
                ni->setAmountRaw ((float) raw);
            else
                return MoshResult::failure (error::invalidArgs, "unknown neural param: " + param);

            const auto ref = ids::pluginRef (ni->itemID.toString());
            ctx.emit (events::pluginParamChanged (ref, param, raw));
            auto* data = new juce::DynamicObject();
            data->setProperty ("raw", raw);
            data->setProperty ("clamped", ! ni->isLabMode());
            juce::StringArray changed; changed.add (ref);
            return MoshResult::success ("Set neural param", changed, juce::var (data));
        });

        // set_neural_lab_mode {plugin, on} — unlock the raw range behind the warning (UI)
        exec.registerCommand ("set_neural_lab_mode", [&engine] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto* ni = findNeural (engine.getEdit(), cmd.argString ("plugin"));
            if (ni == nullptr)
                return MoshResult::failure (error::noSuchPlugin, "No such neural insert");
            ni->setLabMode (cmd.argBool ("on", true));
            const auto ref = ids::pluginRef (ni->itemID.toString());
            juce::StringArray changed; changed.add (ref);
            return MoshResult::success (ni->isLabMode() ? "Lab mode unlocked" : "Lab mode off", changed);
        });

        // bypass_neural_insert {plugin, bypassed}
        exec.registerCommand ("bypass_neural_insert", [&engine] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto* ni = findNeural (engine.getEdit(), cmd.argString ("plugin"));
            if (ni == nullptr)
                return MoshResult::failure (error::noSuchPlugin, "No such neural insert");
            const bool bypassed = cmd.argBool ("bypassed", true);
            ni->setEnabled (! bypassed);
            const auto ref = ids::pluginRef (ni->itemID.toString());
            ctx.emit (events::pluginBypassed (ref, bypassed));
            juce::StringArray changed; changed.add (ref);
            return MoshResult::success (bypassed ? "Bypassed neural insert" : "Enabled neural insert", changed);
        });
    }
}
