#pragma once

#include <juce_core/juce_core.h>

namespace mosh
{

struct EngineBackendContext
{
    juce::File sessionDir;
    juce::File repoRoot;
};

juce::var makeEngineCapability (const juce::String& operation,
                                const juce::String& status,
                                const juce::String& notes = {});

juce::var makeEngineDiagnostics (const juce::String& backend,
                                 const juce::String& commandId);

juce::var makeEngineResult (const juce::String& backend,
                            const juce::String& commandId,
                            juce::var data,
                            juce::var diagnostics);

juce::var makeEngineError (const juce::String& backend,
                           const juce::String& commandId,
                           const juce::String& code,
                           const juce::String& message,
                           juce::var diagnostics);

juce::String engineResultMessage (const juce::var& result);

class MoshEngineBackend
{
public:
    explicit MoshEngineBackend (EngineBackendContext contextToUse);
    virtual ~MoshEngineBackend() = default;

    virtual juce::String backendId() const = 0;
    virtual juce::String displayName() const = 0;
    virtual juce::var capabilities() const = 0;
    virtual juce::var diagnostics() const = 0;
    virtual juce::var sessionGraph() const;

    virtual juce::var createSession (const juce::var& args);
    virtual juce::var openSession (const juce::var& args);
    virtual juce::var selectAudioDevice (const juce::var& args);
    virtual juce::var scanPlugins (const juce::var& args);
    virtual juce::var getPluginBlocklist (const juce::var& args);
    virtual juce::var clearPluginBlocklist (const juce::var& args);
    virtual juce::var blockPlugin (const juce::var& args);
    virtual juce::var loadPlugin (const juce::var& args);
    virtual juce::var removePlugin (const juce::var& args);
    virtual juce::var reorderPlugin (const juce::var& args);
    virtual juce::var setPluginParam (const juce::var& args);
    virtual juce::var bypassPlugin (const juce::var& args);
    virtual juce::var addAutomationPoint (const juce::var& args);
    virtual juce::var removeAutomationPoint (const juce::var& args);
    virtual juce::var setAutomationPoint (const juce::var& args);
    virtual juce::var clearAutomation (const juce::var& args);
    virtual juce::var createTrack (const juce::var& args);
    virtual juce::var renameTrack (const juce::var& args);
    virtual juce::var removeTrack (const juce::var& args);
    virtual juce::var addClip (const juce::var& args);
    virtual juce::var moveClip (const juce::var& args);
    virtual juce::var trimClip (const juce::var& args);
    virtual juce::var splitClip (const juce::var& args);
    virtual juce::var duplicateClip (const juce::var& args);
    virtual juce::var pasteClip (const juce::var& args);
    virtual juce::var deleteTimeRange (const juce::var& args);
    virtual juce::var renameClip (const juce::var& args);
    virtual juce::var removeClip (const juce::var& args);
    virtual juce::var setClipMute (const juce::var& args);
    virtual juce::var setClipGain (const juce::var& args);
    virtual juce::var setClipWarp (const juce::var& args);
    virtual juce::var getClipPeaks (const juce::var& args);
    virtual juce::var addMidiClip (const juce::var& args);
    virtual juce::var addNote (const juce::var& args);
    virtual juce::var removeNote (const juce::var& args);
    virtual juce::var setNote (const juce::var& args);
    virtual juce::var quantizeNotes (const juce::var& args);
    virtual juce::var setTrackVolume (const juce::var& args);
    virtual juce::var setTrackPan (const juce::var& args);
    virtual juce::var setTrackMute (const juce::var& args);
    virtual juce::var setTrackSolo (const juce::var& args);
    virtual juce::var enableTrackMeter (const juce::var& args);
    virtual juce::var disableTrackMeter (const juce::var& args);
    virtual juce::var enableAllMeters (const juce::var& args);
    virtual juce::var setMasterVolume (const juce::var& args);
    virtual juce::var setMasterPan (const juce::var& args);
    virtual juce::var createBus (const juce::var& args);
    virtual juce::var addSend (const juce::var& args);
    virtual juce::var setSendLevel (const juce::var& args);
    virtual juce::var removeSend (const juce::var& args);
    virtual juce::var removeBus (const juce::var& args);
    virtual juce::var renameBus (const juce::var& args);
    virtual juce::var createGroupTrack (const juce::var& args);
    virtual juce::var ungroupTrack (const juce::var& args);
    virtual juce::var setTrackInput (const juce::var& args);
    virtual juce::var setTrackOutput (const juce::var& args);
    virtual juce::var armTrack (const juce::var& args);
    virtual juce::var setInputMonitor (const juce::var& args);
    virtual juce::var stopRecording (const juce::var& args);
    virtual juce::var setTempo (const juce::var& args);
    virtual juce::var insertTempoChange (const juce::var& args);
    virtual juce::var removeTempoChange (const juce::var& args);
    virtual juce::var setTempoCurve (const juce::var& args);
    virtual juce::var setTimeSignature (const juce::var& args);
    virtual juce::var insertTimeSigChange (const juce::var& args);
    virtual juce::var removeTimeSigChange (const juce::var& args);
    virtual juce::var setMetronome (const juce::var& args);
    virtual juce::var setProjectSettings (const juce::var& args);
    virtual juce::var setTransport (const juce::var& args);
    virtual juce::var renderExport (const juce::var& args);
    virtual juce::var saveSessionGraph (const juce::var& args);
    virtual juce::var restoreSessionGraph (const juce::var& args);
    virtual juce::var runContractSlice (const juce::var& args);

protected:
    juce::var unsupported (const juce::String& commandId) const;

    EngineBackendContext context;
};

} // namespace mosh
