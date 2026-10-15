#pragma once

#include <tracktion_engine/tracktion_engine.h>
#include "plugins/mixer/TrackMutePlugin.h"
#include "plugins/moshfx/MoshFxPlugins.h"
#include "plugins/spectral/MasterSpectralTapPlugin.h"
#if MOSH_HAVE_ANIRA
 #include "plugins/transform/RaveInsertPlugin.h"
#endif

namespace mosh
{
// Every plugin type Mosh owns that can appear in a SAVED project, registered in one place.
//
// It must run before the engine loads a persisted Edit. MoshEngine's ctor loads the last
// project, and Tracktion's PluginManager::createPlugin drops an unknown type with only a
// log line ("Failed to create plugin: moshAutoTune"), leaving the <PLUGIN> node orphaned in
// the tree: it is saved back untouched but never processes audio and never appears in the
// rack. Owner report 2026-10-14: every relaunch silently lost the vocal chain's Mosh
// AutoTune, so a new one was added each session and six piled up in the file.
//
// MoshEngine's ctor calls this before the load; PluginHost::initialise calls it again for
// any path that builds a PluginHost on its own engine. registerBuiltInType ignores a type
// it already has, so the second call is a no-op. The shadowing built-ins (compressor,
// delay, chorus, low-pass, 4OSC, sampler) are NOT here: they must replace Tracktion's own
// types, so they ride MoshEngineBehaviour's earlier hook.
inline void registerMoshPluginTypes (tracktion::engine::PluginManager& plugins)
{
    plugins.createBuiltInType<TrackMutePlugin>();            // CAP-AUT-006 mute gate
    plugins.createBuiltInType<MasterSpectralTapPlugin>();    // Moshi reactivity tap on the master
    plugins.createBuiltInType<MoshAutoTunePlugin>();
    plugins.createBuiltInType<MoshOTTPlugin>();
    plugins.createBuiltInType<MoshSoftClipPlugin>();
    plugins.createBuiltInType<MoshXFeedbackPlugin>();
   #if MOSH_HAVE_ANIRA
    plugins.createBuiltInType<RaveInsertPlugin>();           // Route C.2, anira build only
   #endif
}

/** The type names registerMoshPluginTypes makes loadable (for the --selftest guard). */
inline juce::StringArray moshPluginTypeNames()
{
    juce::StringArray names { TrackMutePlugin::xmlTypeName, MasterSpectralTapPlugin::xmlTypeName,
                              MoshAutoTunePlugin::xmlTypeName, MoshOTTPlugin::xmlTypeName,
                              MoshSoftClipPlugin::xmlTypeName, MoshXFeedbackPlugin::xmlTypeName };
   #if MOSH_HAVE_ANIRA
    names.add (RaveInsertPlugin::xmlTypeName);
   #endif
    return names;
}
}
