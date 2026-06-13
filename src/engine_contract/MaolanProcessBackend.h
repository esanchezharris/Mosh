#pragma once

#include "engine_contract/MoshEngineBackend.h"

#include <vector>

namespace mosh
{

class MaolanProcessBackend final : public MoshEngineBackend
{
public:
    explicit MaolanProcessBackend (EngineBackendContext contextToUse);

    juce::String backendId() const override;
    juce::String displayName() const override;
    juce::var capabilities() const override;
    juce::var diagnostics() const override;
    juce::var sessionGraph() const override;
    juce::var createSession (const juce::var& args) override;
    juce::var openSession (const juce::var& args) override;
    juce::var selectAudioDevice (const juce::var& args) override;
    juce::var scanPlugins (const juce::var& args) override;
    juce::var getPluginBlocklist (const juce::var& args) override;
    juce::var clearPluginBlocklist (const juce::var& args) override;
    juce::var blockPlugin (const juce::var& args) override;
    juce::var loadPlugin (const juce::var& args) override;
    juce::var removePlugin (const juce::var& args) override;
    juce::var reorderPlugin (const juce::var& args) override;
    juce::var setPluginParam (const juce::var& args) override;
    juce::var bypassPlugin (const juce::var& args) override;
    juce::var addAutomationPoint (const juce::var& args) override;
    juce::var removeAutomationPoint (const juce::var& args) override;
    juce::var setAutomationPoint (const juce::var& args) override;
    juce::var clearAutomation (const juce::var& args) override;
    juce::var createTrack (const juce::var& args) override;
    juce::var renameTrack (const juce::var& args) override;
    juce::var removeTrack (const juce::var& args) override;
    juce::var addClip (const juce::var& args) override;
    juce::var moveClip (const juce::var& args) override;
    juce::var trimClip (const juce::var& args) override;
    juce::var splitClip (const juce::var& args) override;
    juce::var duplicateClip (const juce::var& args) override;
    juce::var pasteClip (const juce::var& args) override;
    juce::var deleteTimeRange (const juce::var& args) override;
    juce::var renameClip (const juce::var& args) override;
    juce::var removeClip (const juce::var& args) override;
    juce::var setClipMute (const juce::var& args) override;
    juce::var setClipGain (const juce::var& args) override;
    juce::var setClipWarp (const juce::var& args) override;
    juce::var getClipPeaks (const juce::var& args) override;
    juce::var addMidiClip (const juce::var& args) override;
    juce::var addNote (const juce::var& args) override;
    juce::var removeNote (const juce::var& args) override;
    juce::var setNote (const juce::var& args) override;
    juce::var quantizeNotes (const juce::var& args) override;
    juce::var setTrackVolume (const juce::var& args) override;
    juce::var setTrackPan (const juce::var& args) override;
    juce::var setTrackMute (const juce::var& args) override;
    juce::var setTrackSolo (const juce::var& args) override;
    juce::var enableTrackMeter (const juce::var& args) override;
    juce::var disableTrackMeter (const juce::var& args) override;
    juce::var enableAllMeters (const juce::var& args) override;
    juce::var setMasterVolume (const juce::var& args) override;
    juce::var setMasterPan (const juce::var& args) override;
    juce::var createBus (const juce::var& args) override;
    juce::var addSend (const juce::var& args) override;
    juce::var setSendLevel (const juce::var& args) override;
    juce::var removeSend (const juce::var& args) override;
    juce::var removeBus (const juce::var& args) override;
    juce::var renameBus (const juce::var& args) override;
    juce::var createGroupTrack (const juce::var& args) override;
    juce::var ungroupTrack (const juce::var& args) override;
    juce::var setTrackInput (const juce::var& args) override;
    juce::var setTrackOutput (const juce::var& args) override;
    juce::var armTrack (const juce::var& args) override;
    juce::var setInputMonitor (const juce::var& args) override;
    juce::var stopRecording (const juce::var& args) override;
    juce::var setTempo (const juce::var& args) override;
    juce::var insertTempoChange (const juce::var& args) override;
    juce::var removeTempoChange (const juce::var& args) override;
    juce::var setTempoCurve (const juce::var& args) override;
    juce::var setTimeSignature (const juce::var& args) override;
    juce::var insertTimeSigChange (const juce::var& args) override;
    juce::var removeTimeSigChange (const juce::var& args) override;
    juce::var setMetronome (const juce::var& args) override;
    juce::var setProjectSettings (const juce::var& args) override;
    juce::var setTransport (const juce::var& args) override;
    juce::var renderExport (const juce::var& args) override;
    juce::var saveSessionGraph (const juce::var& args) override;
    juce::var restoreSessionGraph (const juce::var& args) override;
    juce::var runContractSlice (const juce::var& args) override;

private:
    struct CommandRun
    {
        bool ok = false;
        bool timedOut = false;
        int exitCode = -1;
        double timingMs = 0.0;
        juce::File stdoutLog;
        juce::File stderrLog;
    };

    struct SliceState
    {
        struct Clip
        {
            struct Note
            {
                int pitch = 60;
                double start = 0.0;
                double length = 1.0;
                int velocity = 100;
            };

            juce::String id;
            juce::String name;
            juce::String type = "wave";
            juce::String sourceKind = "file";
            juce::String sourcePath;
            double startSeconds = 0.0;
            double lengthSeconds = 0.0;
            double offsetSeconds = 0.0;
            double gainDb = 0.0;
            double frequencyHz = 0.0;
            bool mute = false;
            bool autoTempo = false;
            double sourceBpm = 0.0;
            double warpSourceLengthSeconds = 0.0;
            juce::String stretchMode;
            std::vector<Note> notes;
        };

        struct PluginParam
        {
            struct AutomationPoint
            {
                double time = 0.0;
                double value = 0.0;
                double curve = 0.0;
            };

            int index = 0;
            juce::String name;
            double value = 0.0;
            std::vector<AutomationPoint> points;
        };

        struct Plugin
        {
            juce::String id;
            juce::String format = "vst3";
            juce::String path;
            juce::String name;
            bool enabled = true;
            bool isInstrument = false;
            std::vector<PluginParam> params;
        };

        struct Track
        {
            struct Send
            {
                int bus = -1;
                double db = 0.0;
                bool mute = false;
            };

            juce::String id;
            juce::String name;
            juce::String type = "audio";
            bool isGroup = false;
            juce::String parentId;
            bool isReturn = false;
            int returnBus = -1;
            double volumeDb = 0.0;
            double pan = 0.0;
            bool mute = false;
            bool solo = false;
            bool meterEnabled = false;
            bool armed = false;
            juce::String monitor = "automatic";
            juce::String inputDeviceId;
            juce::String outputKind;
            juce::String outputDeviceId;
            juce::String outputDestTrackId;
            std::vector<Send> sends;
            std::vector<Clip> clips;
            std::vector<Plugin> plugins;
        };

        struct Bus
        {
            int bus = -1;
            juce::String name;
            juce::String trackId;
        };

        struct TempoPoint
        {
            double time = 0.0;
            double bpm = 120.0;
            double curve = 1.0;
        };

        struct TimeSigPoint
        {
            double time = 0.0;
            int numerator = 4;
            int denominator = 4;
        };

        juce::File outputDir;
        juce::File clipsDir;
        juce::File commandLog;
        juce::File timingCsv;
        juce::File sessionGraph;
        juce::File restoredSessionGraph;
        juce::File summary;
        juce::File smokeDir;
        juce::File renderDir;
        juce::File playbackDir;
        juce::File maolanSessionDir;
        juce::File maolanSessionAudioDir;
        juce::File maolanSessionJson;
        juce::File persistenceMaolanSessionDir;
        juce::File persistenceMaolanSessionAudioDir;
        juce::File persistenceMaolanSessionJson;
        juce::File maolanStdout;
        juce::File maolanStderr;
        juce::File renderStdout;
        juce::File renderStderr;
        juce::File renderWav;
        juce::File renderStats;
        juce::File playbackStdout;
        juce::File playbackStderr;
        juce::File playbackStats;
        juce::String sessionId = "mosh-maolan-contract-slice";
        juce::String device = "coreaudio:default";
        juce::String pluginPath;
        std::vector<Track> tracks;
        std::vector<Bus> buses;
        std::vector<juce::String> pluginBlocklist;
        std::vector<TempoPoint> tempoMap;
        std::vector<TimeSigPoint> timeSigMap;
        double masterVolumeDb = 0.0;
        double masterPan = 0.0;
        double tempoBpm = 120.0;
        int timeSigNumerator = 4;
        int timeSigDenominator = 4;
        bool metronome = false;
        double projectSampleRate = 48000.0;
        int projectBitDepth = 24;
        juce::String projectTimeBase = "seconds";
        double transportPosition = 0.0;
        bool transportPlaying = false;
        bool smokeRan = false;
        bool renderRan = false;
        int seq = 0;
    };

    juce::File contractScript() const;
    juce::File defaultEvidenceDir() const;
    juce::File maolanMoshDir() const;
    juce::File maolanEnvFile() const;
    juce::File fixturePlugin() const;

    void configureEvidenceDir (const juce::File& outputDir);
    void ensureEvidenceDir();
    juce::String nextTrackId() const;
    juce::String nextClipId() const;
    SliceState::Track* findTrack (const juce::String& trackId);
    const SliceState::Track* findTrack (const juce::String& trackId) const;
    SliceState::Track* firstTrack();
    SliceState::Bus* findBus (int bus);
    const SliceState::Bus* findBus (int bus) const;
    int nextBusNumber() const;
    SliceState::Plugin* findPlugin (SliceState::Track& track, int index);
    const SliceState::Plugin* findPlugin (const SliceState::Track& track, int index) const;
    bool isPluginBlocked (const juce::String& pluginId, const juce::String& pluginPath) const;
    juce::var pluginBlocklistData() const;
    SliceState::PluginParam* findPluginParam (SliceState::Plugin& plugin, int paramIndex);
    SliceState::PluginParam& findOrCreatePluginParam (SliceState::Plugin& plugin, int paramIndex);
    juce::var pluginResultData (const SliceState::Track& track, const SliceState::Plugin& plugin, int index) const;
    juce::var pluginParamAutomationData (const SliceState::Track& track,
                                         const SliceState::Plugin& plugin,
                                         int pluginIndex,
                                         const SliceState::PluginParam& param,
                                         int pointIndex) const;
    SliceState::Clip* findClip (const juce::String& clipId, SliceState::Track** owner = nullptr);
    const SliceState::Clip* findClip (const juce::String& clipId, const SliceState::Track** owner = nullptr) const;
    double audioFileLengthSeconds (const juce::File& file) const;
    bool writeToneClipFile (const juce::File& file, double seconds, double frequencyHz) const;
    bool hasRenderableClips() const;
    bool hasLoadedPlugins() const;
    double bpmAtSeconds (double seconds) const;
    double warpedLengthSeconds (const SliceState::Clip& clip) const;
    void refreshWarpedClipLengths();
    bool writeMaolanSessionFolderTo (const juce::File& sessionDir,
                                     const juce::File& audioDir,
                                     const juce::File& sessionJson,
                                     juce::String& error);
    bool writeMaolanSessionFolder (juce::String& error);
    juce::var clipResultData (const SliceState::Track& track, const SliceState::Clip& clip) const;
    juce::var updateTrackMixer (const juce::String& commandId,
                                const juce::String& propertyName,
                                const juce::var& value,
                                const juce::var& args);
    juce::var buildSessionGraph() const;
    bool applySessionGraph (const juce::var& graph);
    bool writeSessionGraphFile (const juce::File& file) const;
    juce::var operationDiagnostics (const juce::String& commandId,
                                    double timingMs = 0.0,
                                    const juce::File& stdoutPath = {},
                                    const juce::File& stderrPath = {},
                                    juce::Array<juce::var> artifactPaths = {}) const;
    juce::var failOperation (const juce::String& commandId,
                             const juce::String& code,
                             const juce::String& message,
                             const juce::var& args,
                             juce::var diagnostics);
    juce::var finishOperation (const juce::String& commandId,
                               const juce::var& args,
                               juce::var data,
                               juce::var diagnostics);
    void appendCommandRecord (const juce::String& operation,
                              const juce::var& args,
                              bool ok,
                              juce::var diagnostics,
                              juce::var error = {});
    CommandRun runShell (const juce::String& commandId,
                         const juce::String& shellBody,
                         const juce::File& stdoutLog,
                         const juce::File& stderrLog,
                         int timeoutSeconds);
    juce::var ensureSmokeRan (const juce::var& args);
    juce::var writeSummary();

    SliceState state;
};

} // namespace mosh
