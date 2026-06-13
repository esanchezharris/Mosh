#include "TracktionEngineBackend.h"

namespace mosh
{
using namespace juce;

TracktionEngineBackend::TracktionEngineBackend (MoshEngine& engineToUse, EngineBackendContext contextToUse)
    : MoshEngineBackend (std::move (contextToUse)), engine (engineToUse)
{
}

String TracktionEngineBackend::backendId() const { return "tracktion"; }

String TracktionEngineBackend::displayName() const { return "Tracktion/JUCE Reference"; }

var TracktionEngineBackend::capabilities() const
{
    Array<var> caps;
    caps.add (makeEngineCapability ("createSession", "reference", "Existing new_project path."));
    caps.add (makeEngineCapability ("openSession", "reference", "Existing open_project path."));
    caps.add (makeEngineCapability ("selectAudioDevice", "reference", "Existing CoreAudio device command path."));
    caps.add (makeEngineCapability ("scanPlugins", "reference", "Existing PluginHost scan/catalog path."));
    caps.add (makeEngineCapability ("loadPlugin", "reference", "Existing Tracktion external plugin load path."));
    caps.add (makeEngineCapability ("removePlugin", "reference", "Existing Tracktion plugin removal path."));
    caps.add (makeEngineCapability ("setPluginParam", "reference", "Existing Tracktion plugin parameter path."));
    caps.add (makeEngineCapability ("bypassPlugin", "reference", "Existing Tracktion plugin enable/bypass path."));
    caps.add (makeEngineCapability ("createTrack", "reference", "Existing Tracktion audio track path."));
    caps.add (makeEngineCapability ("renameTrack", "reference", "Existing Tracktion track rename path."));
    caps.add (makeEngineCapability ("removeTrack", "reference", "Existing Tracktion track removal path."));
    caps.add (makeEngineCapability ("setTrackVolume", "reference", "Existing Tracktion track fader path."));
    caps.add (makeEngineCapability ("setTrackPan", "reference", "Existing Tracktion track pan path."));
    caps.add (makeEngineCapability ("setTrackMute", "reference", "Existing Tracktion track mute path."));
    caps.add (makeEngineCapability ("setTrackSolo", "reference", "Existing Tracktion track solo path."));
    caps.add (makeEngineCapability ("enableTrackMeter", "reference", "Existing Tracktion level-meter tap path."));
    caps.add (makeEngineCapability ("disableTrackMeter", "reference", "Existing Tracktion level-meter tap path."));
    caps.add (makeEngineCapability ("enableAllMeters", "reference", "Existing Tracktion level-meter tap path."));
    caps.add (makeEngineCapability ("setTransport", "reference", "Existing Tracktion transport path."));
    caps.add (makeEngineCapability ("renderExport", "reference", "Existing export_audio path."));
    caps.add (makeEngineCapability ("saveSessionGraph", "reference", "Existing Tracktion edit save path."));
    caps.add (makeEngineCapability ("restoreSessionGraph", "reference", "Existing Tracktion edit reload/open path."));
    caps.add (makeEngineCapability ("diagnostics", "reference", "Adapter reports current engine/session state."));
    return caps;
}

var TracktionEngineBackend::diagnostics() const
{
    auto d = makeEngineDiagnostics (backendId(), "diagnostics");
    if (auto* o = d.getDynamicObject())
    {
        o->setProperty ("displayName", displayName());
        o->setProperty ("mode", "reference");
        o->setProperty ("sessionDir", engine.sessionDir().getFullPathName());
        o->setProperty ("editFile", engine.editFile().getFullPathName());
        o->setProperty ("audioEnabled", engine.hasAudio());
        o->setProperty ("audioDeviceError", engine.audioDeviceError());
        o->setProperty ("availableCores", engine.availableCores());
        o->setProperty ("audioThreads", engine.effectiveAudioThreads());
        o->setProperty ("repoRoot", context.repoRoot.getFullPathName());
        o->setProperty ("capabilities", capabilities());
    }
    return d;
}

} // namespace mosh
