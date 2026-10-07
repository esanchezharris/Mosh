#pragma once

#include <juce_core/juce_core.h>
#include <functional>

namespace mosh
{
class MoshEngine;
class MoshOps;

struct PluginPanelsSelfTestCallbacks
{
    std::function<void (const juce::String&)> section;
    std::function<void (bool, const juce::String&)> check;
};

/** The native plugin panels' engine seam (docs/02_MOSHOPS_CONTRACT.md): the snapshot's
    plugin itemId, physical parameter ranges and `state` object; set_plugin_state
    (validation, clamping, the low/high-pass mode flip, undo); gesture coalescing on
    set_plugin_param / set_plugin_state; and the "plugin_meters" rail through
    MoshOps::pluginMeters (compressor, soft clip, OTT, X-FDBK), driven block by block
    because a headless run has no audio thread. Creates its own track and removes it. */
void runPluginPanelsSelfTest (MoshEngine&, MoshOps&, const PluginPanelsSelfTestCallbacks&);
}
