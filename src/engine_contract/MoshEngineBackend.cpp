#include "MoshEngineBackend.h"

namespace mosh
{
using namespace juce;

namespace
{
bool statusMeansSupported (const String& status)
{
    return status == "supported" || status == "reference" || status == "process";
}
}

MoshEngineBackend::MoshEngineBackend (EngineBackendContext contextToUse)
    : context (std::move (contextToUse))
{
}

var MoshEngineBackend::unsupported (const String& commandId) const
{
    return makeEngineError (backendId(), commandId, "unsupported_by_backend",
                            displayName() + " does not support " + commandId + " through the MOSH engine contract yet.",
                            makeEngineDiagnostics (backendId(), commandId));
}

var MoshEngineBackend::sessionGraph() const { return {}; }

var MoshEngineBackend::createSession (const var&) { return unsupported ("createSession"); }
var MoshEngineBackend::openSession (const var&) { return unsupported ("openSession"); }
var MoshEngineBackend::selectAudioDevice (const var&) { return unsupported ("selectAudioDevice"); }
var MoshEngineBackend::scanPlugins (const var&) { return unsupported ("scanPlugins"); }
var MoshEngineBackend::getPluginBlocklist (const var&) { return unsupported ("getPluginBlocklist"); }
var MoshEngineBackend::clearPluginBlocklist (const var&) { return unsupported ("clearPluginBlocklist"); }
var MoshEngineBackend::blockPlugin (const var&) { return unsupported ("blockPlugin"); }
var MoshEngineBackend::loadPlugin (const var&) { return unsupported ("loadPlugin"); }
var MoshEngineBackend::removePlugin (const var&) { return unsupported ("removePlugin"); }
var MoshEngineBackend::reorderPlugin (const var&) { return unsupported ("reorderPlugin"); }
var MoshEngineBackend::setPluginParam (const var&) { return unsupported ("setPluginParam"); }
var MoshEngineBackend::bypassPlugin (const var&) { return unsupported ("bypassPlugin"); }
var MoshEngineBackend::addAutomationPoint (const var&) { return unsupported ("addAutomationPoint"); }
var MoshEngineBackend::removeAutomationPoint (const var&) { return unsupported ("removeAutomationPoint"); }
var MoshEngineBackend::setAutomationPoint (const var&) { return unsupported ("setAutomationPoint"); }
var MoshEngineBackend::clearAutomation (const var&) { return unsupported ("clearAutomation"); }
var MoshEngineBackend::createTrack (const var&) { return unsupported ("createTrack"); }
var MoshEngineBackend::renameTrack (const var&) { return unsupported ("renameTrack"); }
var MoshEngineBackend::removeTrack (const var&) { return unsupported ("removeTrack"); }
var MoshEngineBackend::addClip (const var&) { return unsupported ("addClip"); }
var MoshEngineBackend::moveClip (const var&) { return unsupported ("moveClip"); }
var MoshEngineBackend::trimClip (const var&) { return unsupported ("trimClip"); }
var MoshEngineBackend::splitClip (const var&) { return unsupported ("splitClip"); }
var MoshEngineBackend::duplicateClip (const var&) { return unsupported ("duplicateClip"); }
var MoshEngineBackend::pasteClip (const var&) { return unsupported ("pasteClip"); }
var MoshEngineBackend::deleteTimeRange (const var&) { return unsupported ("deleteTimeRange"); }
var MoshEngineBackend::renameClip (const var&) { return unsupported ("renameClip"); }
var MoshEngineBackend::removeClip (const var&) { return unsupported ("removeClip"); }
var MoshEngineBackend::setClipMute (const var&) { return unsupported ("setClipMute"); }
var MoshEngineBackend::setClipGain (const var&) { return unsupported ("setClipGain"); }
var MoshEngineBackend::setClipWarp (const var&) { return unsupported ("setClipWarp"); }
var MoshEngineBackend::getClipPeaks (const var&) { return unsupported ("getClipPeaks"); }
var MoshEngineBackend::addMidiClip (const var&) { return unsupported ("addMidiClip"); }
var MoshEngineBackend::addNote (const var&) { return unsupported ("addNote"); }
var MoshEngineBackend::removeNote (const var&) { return unsupported ("removeNote"); }
var MoshEngineBackend::setNote (const var&) { return unsupported ("setNote"); }
var MoshEngineBackend::quantizeNotes (const var&) { return unsupported ("quantizeNotes"); }
var MoshEngineBackend::setTrackVolume (const var&) { return unsupported ("setTrackVolume"); }
var MoshEngineBackend::setTrackPan (const var&) { return unsupported ("setTrackPan"); }
var MoshEngineBackend::setTrackMute (const var&) { return unsupported ("setTrackMute"); }
var MoshEngineBackend::setTrackSolo (const var&) { return unsupported ("setTrackSolo"); }
var MoshEngineBackend::enableTrackMeter (const var&) { return unsupported ("enableTrackMeter"); }
var MoshEngineBackend::disableTrackMeter (const var&) { return unsupported ("disableTrackMeter"); }
var MoshEngineBackend::enableAllMeters (const var&) { return unsupported ("enableAllMeters"); }
var MoshEngineBackend::setMasterVolume (const var&) { return unsupported ("setMasterVolume"); }
var MoshEngineBackend::setMasterPan (const var&) { return unsupported ("setMasterPan"); }
var MoshEngineBackend::createBus (const var&) { return unsupported ("createBus"); }
var MoshEngineBackend::addSend (const var&) { return unsupported ("addSend"); }
var MoshEngineBackend::setSendLevel (const var&) { return unsupported ("setSendLevel"); }
var MoshEngineBackend::removeSend (const var&) { return unsupported ("removeSend"); }
var MoshEngineBackend::removeBus (const var&) { return unsupported ("removeBus"); }
var MoshEngineBackend::renameBus (const var&) { return unsupported ("renameBus"); }
var MoshEngineBackend::createGroupTrack (const var&) { return unsupported ("createGroupTrack"); }
var MoshEngineBackend::ungroupTrack (const var&) { return unsupported ("ungroupTrack"); }
var MoshEngineBackend::setTrackInput (const var&) { return unsupported ("setTrackInput"); }
var MoshEngineBackend::setTrackOutput (const var&) { return unsupported ("setTrackOutput"); }
var MoshEngineBackend::armTrack (const var&) { return unsupported ("armTrack"); }
var MoshEngineBackend::setInputMonitor (const var&) { return unsupported ("setInputMonitor"); }
var MoshEngineBackend::stopRecording (const var&) { return unsupported ("stopRecording"); }
var MoshEngineBackend::setTempo (const var&) { return unsupported ("setTempo"); }
var MoshEngineBackend::insertTempoChange (const var&) { return unsupported ("insertTempoChange"); }
var MoshEngineBackend::removeTempoChange (const var&) { return unsupported ("removeTempoChange"); }
var MoshEngineBackend::setTempoCurve (const var&) { return unsupported ("setTempoCurve"); }
var MoshEngineBackend::setTimeSignature (const var&) { return unsupported ("setTimeSignature"); }
var MoshEngineBackend::insertTimeSigChange (const var&) { return unsupported ("insertTimeSigChange"); }
var MoshEngineBackend::removeTimeSigChange (const var&) { return unsupported ("removeTimeSigChange"); }
var MoshEngineBackend::setMetronome (const var&) { return unsupported ("setMetronome"); }
var MoshEngineBackend::setProjectSettings (const var&) { return unsupported ("setProjectSettings"); }
var MoshEngineBackend::setTransport (const var&) { return unsupported ("setTransport"); }
var MoshEngineBackend::renderExport (const var&) { return unsupported ("renderExport"); }
var MoshEngineBackend::saveSessionGraph (const var&) { return unsupported ("saveSessionGraph"); }
var MoshEngineBackend::restoreSessionGraph (const var&) { return unsupported ("restoreSessionGraph"); }

var MoshEngineBackend::runContractSlice (const var&)
{
    return unsupported ("run_engine_contract_slice");
}

var makeEngineCapability (const String& operation, const String& status, const String& notes)
{
    auto* o = new DynamicObject();
    o->setProperty ("operation", operation);
    o->setProperty ("status", status);
    o->setProperty ("supported", statusMeansSupported (status));
    if (notes.isNotEmpty())
        o->setProperty ("notes", notes);
    return var (o);
}

var makeEngineDiagnostics (const String& backend, const String& commandId)
{
    auto* o = new DynamicObject();
    o->setProperty ("backend", backend);
    o->setProperty ("commandId", commandId);
    o->setProperty ("timestampMs", Time::getCurrentTime().toMilliseconds());
    return var (o);
}

var makeEngineResult (const String& backend, const String& commandId, var data, var diagnostics)
{
    auto* o = new DynamicObject();
    o->setProperty ("ok", true);
    o->setProperty ("backend", backend);
    o->setProperty ("commandId", commandId);
    if (! data.isVoid())
        o->setProperty ("data", data);
    if (! diagnostics.isVoid())
        o->setProperty ("diagnostics", diagnostics);
    return var (o);
}

var makeEngineError (const String& backend, const String& commandId,
                     const String& code, const String& message, var diagnostics)
{
    auto* error = new DynamicObject();
    error->setProperty ("code", code);
    error->setProperty ("message", message);

    auto* o = new DynamicObject();
    o->setProperty ("ok", false);
    o->setProperty ("backend", backend);
    o->setProperty ("commandId", commandId);
    o->setProperty ("error", var (error));
    if (! diagnostics.isVoid())
        o->setProperty ("diagnostics", diagnostics);
    return var (o);
}

String engineResultMessage (const var& result)
{
    if (auto* err = result.getProperty ("error", var()).getDynamicObject())
    {
        const auto code = err->getProperty ("code").toString();
        const auto message = err->getProperty ("message").toString();
        if (code.isNotEmpty() && message.isNotEmpty())
            return code + ": " + message;
        if (message.isNotEmpty())
            return message;
        if (code.isNotEmpty())
            return code;
    }

    const auto errorString = result.getProperty ("error", var()).toString();
    return errorString.isNotEmpty() ? errorString : String ("engine backend command failed");
}

} // namespace mosh
