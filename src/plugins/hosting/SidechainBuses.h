#pragma once

#include <tracktion_engine/tracktion_engine.h>

namespace mosh::sidechain
{
namespace te = tracktion::engine;

// A third-party plugin with a sidechain ("key") input. Tracktion enables EVERY bus when it
// instantiates one (ExternalPlugin::completePluginInstanceCreation -> enableAllBuses) and,
// with no sidechain source routed, fills the extra input channels with SILENCE
// (ExternalPlugin::applyToBuffer clears every channel past the track's own). A plugin that
// keys from an active sidechain bus then detects nothing: Waves C1 gate stayed shut at any
// threshold above -inf (owner report 2026-10-14: "gates all audio even with gate open at
// -99 dB"), and a sidechain compressor would never compress.
//
// Mosh has no way to route audio into an external plugin's sidechain, so an aux input with
// no source is turned off and the plugin keys from its own input, as it does in a DAW with
// no sidechain selected. A plugin given a real sidechain source keeps its buses.

/** Turns off every input bus after the main one. Returns true when anything changed. */
inline bool disableAuxInputBuses (juce::AudioProcessor::BusesLayout& layout)
{
    bool changed = false;
    for (int i = 1; i < layout.inputBuses.size(); ++i)
        if (! layout.inputBuses.getReference (i).isDisabled())
        {
            layout.inputBuses.getReference (i) = juce::AudioChannelSet::disabled();
            changed = true;
        }
    return changed;
}

/** Applies disableAuxInputBuses to a hosted plugin with no sidechain source. Tracktion
    persists the layout with a null UndoManager ("part of Save, not a user edit"), so this
    never adds an undo step. Returns true when the plugin's layout changed; false when there
    was nothing to do, no instance yet, or the plugin refused the layout. */
inline bool disableUnroutedInputs (te::ExternalPlugin& plugin)
{
    if (plugin.getSidechainSourceID().isValid())
        return false;
    auto* instance = plugin.getAudioPluginInstance();
    if (instance == nullptr || instance->getBusCount (true) < 2)
        return false;
    auto layout = instance->getBusesLayout();
    return disableAuxInputBuses (layout) && plugin.setBusesLayout (layout);
}

/** Every external plugin in an Edit (tracks, master, racks). Returns how many changed. */
inline int disableUnroutedInputs (te::Edit& edit)
{
    int changed = 0;
    for (auto* plugin : te::getAllPlugins (edit, true))
        if (auto* ext = dynamic_cast<te::ExternalPlugin*> (plugin))
            if (disableUnroutedInputs (*ext))
                ++changed;
    return changed;
}
}
