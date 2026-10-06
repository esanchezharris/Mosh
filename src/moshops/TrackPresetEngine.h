// Track-chain presets — the engine-linked half. TrackPreset.h decides WHAT a preset says
// (pure, juce_core only); this header turns one validated stage into Tracktion plugin
// state, and reads a live plugin back into the preset's own units. Shared by
// cmdApplyTrackPreset (MoshOps.Plugins.cpp) and VocalPresetSelfTest.cpp, so the selftest
// qualifies the SAME state the command inserts rather than a hand-built look-alike.
#pragma once

#include "TrackPreset.h"
#include "state/Ids.h"
#include "plugins/moshfx/MoshLowPassPlugin.h"
#include <tracktion_engine/tracktion_engine.h>

namespace te = tracktion::engine;

namespace mosh::trackpreset
{

/** One stage as a complete PLUGIN ValueTree, written entirely with a NULL undo manager.

    STATE-FIRST, deliberately. This is the tree a saved project carries, so creating the
    plugin from it takes the same path a reload takes: each AutomatableParameter comes up
    at its property's value (attachToCurrentValue / ParameterWithStateValue). Nothing here
    is an undoable parameter write, which is what keeps two known hazards out of reach:
      • a CachedValue assignment alone does not move the parameter the DSP reads
        (the 2026-09-02 "180 Hz" high-pass that rendered at 4 kHz), and
      • an undone parameter write leaves AutomatableParameter::currentValue stale
        (the reason SetPluginParamValueAction exists).
    The ONLY undoable action a preset apply performs is adding this finished tree to the
    track, so one undo removes it and one redo restores it exactly.

    Two things the engine would otherwise write THROUGH the edit's UndoManager while
    constructing the plugin — actions on a tree that is not even in the edit yet — are
    put in the tree up front so construction records nothing at all:
      • the MODIFIERASSIGNMENTS child (AutomatableParameter's constructor creates it), and
      • `remapOnTempoChange` (PluginCache::createNewPlugin assigns it when the engine
        behaviour asks for it; a CachedValue skips the write when the value already holds).
    Pass `remapOnTempoChange` = EngineBehaviour::arePluginsRemappedWhenTempoChanges(), the
    same value every other plugin created through the cache gets. */
inline juce::ValueTree makeStageState (const TrackPreset& preset, int stageIndex, bool remapOnTempoChange)
{
    const auto& stage = preset.stages[(size_t) stageIndex];
    juce::ValueTree v (te::IDs::PLUGIN);
    v.setProperty (te::IDs::type, juce::String (stage.processor->type), nullptr);
    v.setProperty (te::IDs::enabled, ! stage.bypassed, nullptr);
    for (const auto& s : stage.state)
        v.setProperty (juce::Identifier (s.spec->stateProp), s.value, nullptr);
    for (const auto& p : stage.params)
        v.setProperty (juce::Identifier (p.spec->stateProp), p.native, nullptr);

    // Ownership: what makes this plugin "the preset's" rather than the user's. Plain
    // properties on the PLUGIN node, so they save with the edit and ride undo with it.
    v.setProperty (ids::moshPresetId, preset.id, nullptr);
    v.setProperty (ids::moshPresetRevision, preset.revision, nullptr);
    v.setProperty (ids::moshPresetStage, stageIndex, nullptr);
    v.setProperty (ids::moshPresetName, preset.name, nullptr);

    v.getOrCreateChildWithName (te::IDs::MODIFIERASSIGNMENTS, nullptr);
    if (remapOnTempoChange)
        v.setProperty (te::IDs::remapOnTempoChange, true, nullptr);
    return v;
}

/** True when `plugin` carries `presetId`'s ownership tag. */
inline bool isOwnedBy (te::Plugin& plugin, const juce::String& presetId)
{
    return plugin.state.getProperty (ids::moshPresetId).toString() == presetId;
}

/** Tolerance for "the parameter holds the value the preset asked for": float precision
    on the native value, scaled to its magnitude. */
inline bool nativeMatches (float actual, float wanted)
{
    return std::abs (actual - wanted) <= 1.0e-5f * juce::jmax (1.0f, std::abs (wanted));
}

/** Does the LIVE plugin hold exactly what `stage` says? Reads the parameters the DSP
    reads (getCurrentValue), not the request and not the tree. Empty string == yes.

    Also: a setting Mosh's own plugin adds outside the preset table must hold Tracktion's
    value. A preset file cannot name a filter slope, so a preset's low/high-pass is
    12 dB/oct (makeStageState never writes "moshFilterSlope"); one the user steepened is
    not the preset any more, and re-applying the preset replaces it at 12. */
inline juce::String stageMismatch (te::Plugin& plugin, const Stage& stage)
{
    if (plugin.getPluginType() != stage.processor->type)
        return "expected a " + juce::String (stage.processor->type) + " but found " + plugin.getPluginType();
    if (plugin.isEnabled() == stage.bypassed)
        return juce::String (stage.processor->type) + (stage.bypassed ? " should be bypassed" : " should be enabled");

    for (const auto& p : stage.params)
    {
        auto param = plugin.getAutomatableParameterByID (p.spec->id);
        if (param == nullptr)
            return juce::String (stage.processor->type) + " has no '" + p.spec->id + "' parameter";
        if (param->hasAutomationPoints())
            return juce::String (p.spec->id) + " is automated";
        if (! nativeMatches (param->getCurrentValue(), p.native))
            return juce::String (p.spec->id) + " reads " + param->getCurrentValueAsString()
                 + " (native " + juce::String (param->getCurrentValue(), 6)
                 + ", wanted " + juce::String (p.native, 6) + ")";
    }

    for (const auto& s : stage.state)
    {
        const auto actual = plugin.state.getProperty (juce::Identifier (s.spec->stateProp));
        const bool same = s.spec->kind == StateSpec::Kind::boolean
                              ? ((bool) actual == (bool) s.value)
                              : (actual.toString() == s.value.toString());
        if (! same)
            return juce::String (s.spec->key) + " is '" + actual.toString() + "'";
    }

    if (auto* filter = dynamic_cast<MoshLowPassPlugin*> (&plugin))
        if (filter->getSlope() != moshfx::filterdesign::kDefaultSlope)
            return "slope is " + juce::String (filter->getSlope()) + " dB/oct (the preset's filter is "
                 + juce::String (moshfx::filterdesign::kDefaultSlope) + " dB/oct)";
    return {};
}

/** The readback a result reports for one stage: every value taken from the live plugin
    and converted to the preset's unit, alongside the engine's own display string. A
    low/high-pass stage also reports the slope it runs at (`state.slope`, dB/oct), which
    a preset cannot set but stageMismatch requires to be 12. */
inline juce::var stageReadback (te::Plugin& plugin, const Stage& stage, int listIndex)
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("index", listIndex);
    o->setProperty ("processor", plugin.getPluginType());
    o->setProperty ("enabled", plugin.isEnabled());

    auto* state = new juce::DynamicObject();
    for (const auto& s : stage.state)
    {
        const auto actual = plugin.state.getProperty (juce::Identifier (s.spec->stateProp));
        state->setProperty (s.spec->key, s.spec->kind == StateSpec::Kind::boolean ? juce::var ((bool) actual)
                                                                                 : juce::var (actual.toString()));
    }
    if (auto* filter = dynamic_cast<MoshLowPassPlugin*> (&plugin))
        state->setProperty ("slope", filter->getSlope());
    o->setProperty ("state", juce::var (state));

    juce::Array<juce::var> params;
    for (const auto& p : stage.params)
    {
        auto* po = new juce::DynamicObject();
        po->setProperty ("id", p.spec->id);
        po->setProperty ("unit", p.spec->unit);
        if (auto param = plugin.getAutomatableParameterByID (p.spec->id))
        {
            const float native = param->getCurrentValue();
            po->setProperty ("native", native);
            // A slope of 0 is an infinite ratio; JSON cannot carry it, so the display
            // string ("INF : 1") is the readback and the number is simply absent.
            if (const double canonical = toCanonical (*p.spec, native); std::isfinite (canonical))
                po->setProperty ("value", canonical);
            po->setProperty ("display", param->getCurrentValueAsString());
        }
        params.add (juce::var (po));
    }
    o->setProperty ("params", params);
    return juce::var (o);
}

} // namespace mosh::trackpreset
