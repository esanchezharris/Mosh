#include "MaolanProcessBackend.h"

#include <algorithm>
#include <cmath>
#include <csignal>
#include <cstring>

namespace mosh
{
using namespace juce;

namespace
{
String defaultMaolanEnvFile()
{
    return SystemStats::getEnvironmentVariable (
        "MOSH_MAOLAN_ENV_FILE",
        "/Users/emiliosanchez-harris/Documents/MaolanMosh/config/maolan.private.env");
}

String defaultMaolanMoshDir()
{
    return SystemStats::getEnvironmentVariable (
        "MOSH_MAOLAN_DIR",
        "/Users/emiliosanchez-harris/Documents/MaolanMosh");
}

String defaultPluginPath()
{
    return SystemStats::getEnvironmentVariable (
        "MOSH_MAOLAN_PLUGIN_PATH",
        "/Users/emiliosanchez-harris/Library/Audio/Plug-Ins/VST3/JamPilotTestGain.vst3");
}

String shellQuote (String value)
{
    return "'" + value.replace ("'", "'\"'\"'", false) + "'";
}

String maolanLockedShellCommand (const String& command)
{
    return "/usr/bin/lockf -t \"${MOSH_MAOLAN_CARGO_LOCK_TIMEOUT_SECONDS:-900}\" "
           "\"$MAOLAN_APP_DIR/.mosh-maolan-cargo.lock\" /bin/bash -lc "
           + shellQuote (command);
}

Array<var> paths (std::initializer_list<File> files)
{
    Array<var> result;
    for (const auto& file : files)
        if (file.getFullPathName().isNotEmpty())
            result.add (file.getFullPathName());
    return result;
}

var objectWith (std::initializer_list<std::pair<const char*, var>> values)
{
    auto* o = new DynamicObject();
    for (const auto& value : values)
        o->setProperty (value.first, value.second);
    return var (o);
}

String pluginNameFromPath (const String& path)
{
    return File (path).getFileName();
}

int secondsToMaolanFrames (double seconds)
{
    return jmax (0, (int) std::round (jmax (0.0, seconds) * 48000.0));
}

String maolanPluginFormat (const String& format)
{
    auto upper = format.trim().toUpperCase();
    return upper.isNotEmpty() ? upper : String ("VST3");
}

String maolanPluginNodeType (const String& format)
{
    const auto upper = maolanPluginFormat (format);
    if (upper == "CLAP")
        return "clap_plugin";
    if (upper == "LV2")
        return "plugin";
    return "vst3_plugin";
}

var maolanTrackNode (const char* type)
{
    return objectWith ({{ "type", String (type) }});
}

var maolanPluginNode (const String& format, int pluginIndex)
{
    return objectWith ({
        { "type", maolanPluginNodeType (format) },
        { "plugin_index", pluginIndex },
    });
}

bool writeUtf8File (const File& file, const String& text)
{
    file.deleteFile();
    if (auto stream = file.createOutputStream())
    {
        stream->write (text.toRawUTF8(), text.getNumBytesAsUTF8());
        stream->flush();
        return true;
    }
    return false;
}

void writeU16LE (OutputStream& out, uint16 value)
{
    out.writeByte ((char) (value & 0xff));
    out.writeByte ((char) ((value >> 8) & 0xff));
}

void writeU32LE (OutputStream& out, uint32 value)
{
    out.writeByte ((char) (value & 0xff));
    out.writeByte ((char) ((value >> 8) & 0xff));
    out.writeByte ((char) ((value >> 16) & 0xff));
    out.writeByte ((char) ((value >> 24) & 0xff));
}

uint16 readU16LE (const char* data)
{
    return (uint16) ((uint8) data[0] | ((uint16) (uint8) data[1] << 8));
}

uint32 readU32LE (const char* data)
{
    return (uint32) ((uint8) data[0]
                     | ((uint32) (uint8) data[1] << 8)
                     | ((uint32) (uint8) data[2] << 16)
                     | ((uint32) (uint8) data[3] << 24));
}

float readF32LE (const char* data)
{
    const uint32 bits = readU32LE (data);
    float value = 0.0f;
    std::memcpy (&value, &bits, sizeof (value));
    return value;
}
}

MaolanProcessBackend::MaolanProcessBackend (EngineBackendContext contextToUse)
    : MoshEngineBackend (std::move (contextToUse))
{
}

String MaolanProcessBackend::backendId() const { return "maolan"; }

String MaolanProcessBackend::displayName() const { return "Maolan Process Backend"; }

var MaolanProcessBackend::capabilities() const
{
    Array<var> caps;
    caps.add (makeEngineCapability ("createSession", "process", "MOSH-owned session graph JSON for the slice."));
    caps.add (makeEngineCapability ("openSession", "process", "MOSH-owned graph replay plus Maolan session-folder materialization."));
    caps.add (makeEngineCapability ("selectAudioDevice", "process", "coreaudio:default only."));
    caps.add (makeEngineCapability ("scanPlugins", "process", "Fixture probe through maolan-test."));
    caps.add (makeEngineCapability ("getPluginBlocklist", "process", "MOSH-owned plugin catalog blocklist persisted in session JSON."));
    caps.add (makeEngineCapability ("clearPluginBlocklist", "process", "MOSH-owned plugin catalog blocklist persisted in session JSON."));
    caps.add (makeEngineCapability ("blockPlugin", "process", "MOSH-owned plugin catalog blocklist persisted in session JSON."));
    caps.add (makeEngineCapability ("loadPlugin", "process", "JamPilotTestGain.vst3 through maolan-test."));
    caps.add (makeEngineCapability ("removePlugin", "process", "MOSH-owned plugin removal persisted in session JSON."));
    caps.add (makeEngineCapability ("reorderPlugin", "process", "MOSH-owned plugin chain ordering persisted in session JSON."));
    caps.add (makeEngineCapability ("setPluginParam", "process", "MOSH-owned plugin parameter values persisted in session JSON."));
    caps.add (makeEngineCapability ("bypassPlugin", "process", "MOSH-owned plugin enabled/bypass state persisted in session JSON."));
    caps.add (makeEngineCapability ("addAutomationPoint", "process", "MOSH-owned plugin automation points persisted in session JSON; native DSP automation is deferred."));
    caps.add (makeEngineCapability ("removeAutomationPoint", "process", "MOSH-owned plugin automation point removal persisted in session JSON; native DSP automation is deferred."));
    caps.add (makeEngineCapability ("setAutomationPoint", "process", "MOSH-owned plugin automation point edits persisted in session JSON; native DSP automation is deferred."));
    caps.add (makeEngineCapability ("clearAutomation", "process", "MOSH-owned plugin automation clearing persisted in session JSON; native DSP automation is deferred."));
    caps.add (makeEngineCapability ("createTrack", "process", "MOSH-owned tracks materialized in session JSON."));
    caps.add (makeEngineCapability ("renameTrack", "process", "MOSH-owned track names persisted in session JSON."));
    caps.add (makeEngineCapability ("removeTrack", "process", "MOSH-owned track removal persisted in session JSON."));
    caps.add (makeEngineCapability ("addClip", "process", "MOSH-owned clip metadata and source files persisted in session JSON."));
    caps.add (makeEngineCapability ("moveClip", "process", "MOSH-owned clip start/track persisted in session JSON."));
    caps.add (makeEngineCapability ("trimClip", "process", "MOSH-owned clip trim/offset persisted in session JSON."));
    caps.add (makeEngineCapability ("splitClip", "process", "MOSH-owned clip split persisted in session JSON."));
    caps.add (makeEngineCapability ("duplicateClip", "process", "MOSH-owned wave clip duplication persisted in session JSON."));
    caps.add (makeEngineCapability ("pasteClip", "process", "MOSH-owned wave clip paste persisted in session JSON."));
    caps.add (makeEngineCapability ("deleteTimeRange", "process", "MOSH-owned wave clip time-range deletion persisted in session JSON."));
    caps.add (makeEngineCapability ("renameClip", "process", "MOSH-owned clip names persisted in session JSON."));
    caps.add (makeEngineCapability ("removeClip", "process", "MOSH-owned clip removal persisted in session JSON."));
    caps.add (makeEngineCapability ("setClipMute", "process", "MOSH-owned clip mute persisted in session JSON."));
    caps.add (makeEngineCapability ("setClipGain", "process", "MOSH-owned clip gain persisted in session JSON."));
    caps.add (makeEngineCapability ("setClipWarp", "process", "MOSH-owned clip auto-tempo metadata persisted in session JSON; native Maolan time-stretch is deferred."));
    caps.add (makeEngineCapability ("getClipPeaks", "process", "MOSH-owned WAV clip source peaks."));
    caps.add (makeEngineCapability ("addMidiClip", "process", "MOSH-owned MIDI clips and notes persisted in session JSON; native MIDI playback is deferred."));
    caps.add (makeEngineCapability ("addNote", "process", "MOSH-owned MIDI note insertion persisted in session JSON."));
    caps.add (makeEngineCapability ("removeNote", "process", "MOSH-owned MIDI note removal persisted in session JSON."));
    caps.add (makeEngineCapability ("setNote", "process", "MOSH-owned MIDI note edits persisted in session JSON."));
    caps.add (makeEngineCapability ("quantizeNotes", "process", "MOSH-owned MIDI note quantization persisted in session JSON."));
    caps.add (makeEngineCapability ("setTrackVolume", "process", "MOSH-owned track volume persisted in session JSON."));
    caps.add (makeEngineCapability ("setTrackPan", "process", "MOSH-owned track pan persisted in session JSON."));
    caps.add (makeEngineCapability ("setTrackMute", "process", "MOSH-owned track mute persisted in session JSON."));
    caps.add (makeEngineCapability ("setTrackSolo", "process", "MOSH-owned track solo persisted in session JSON."));
    caps.add (makeEngineCapability ("enableTrackMeter", "process", "MOSH-owned meter posture persisted in session JSON; native level samples are deferred."));
    caps.add (makeEngineCapability ("disableTrackMeter", "process", "MOSH-owned meter posture persisted in session JSON; native level samples are deferred."));
    caps.add (makeEngineCapability ("enableAllMeters", "process", "MOSH-owned meter posture persisted in session JSON; native level samples are deferred."));
    caps.add (makeEngineCapability ("setMasterVolume", "process", "MOSH-owned master volume persisted in session JSON."));
    caps.add (makeEngineCapability ("setMasterPan", "process", "MOSH-owned master pan persisted in session JSON."));
    caps.add (makeEngineCapability ("createBus", "process", "MOSH-owned aux bus and return track persisted in session JSON; live aux summing is deferred."));
    caps.add (makeEngineCapability ("addSend", "process", "MOSH-owned send metadata persisted in session JSON; live aux summing is deferred."));
    caps.add (makeEngineCapability ("setSendLevel", "process", "MOSH-owned send level persisted in session JSON; live aux summing is deferred."));
    caps.add (makeEngineCapability ("removeSend", "process", "MOSH-owned send removal persisted in session JSON."));
    caps.add (makeEngineCapability ("removeBus", "process", "MOSH-owned aux bus removal persisted in session JSON."));
    caps.add (makeEngineCapability ("renameBus", "process", "MOSH-owned aux bus rename persisted in session JSON."));
    caps.add (makeEngineCapability ("createGroupTrack", "process", "MOSH-owned group membership persisted in session JSON; native submix summing is deferred."));
    caps.add (makeEngineCapability ("ungroupTrack", "process", "MOSH-owned group membership removal persisted in session JSON."));
    caps.add (makeEngineCapability ("setTrackInput", "process", "MOSH-owned track input preference persisted in session JSON; live input binding is deferred."));
    caps.add (makeEngineCapability ("setTrackOutput", "process", "MOSH-owned track output route persisted in session JSON."));
    caps.add (makeEngineCapability ("armTrack", "process", "MOSH-owned record-arm posture persisted in session JSON; live input binding is deferred."));
    caps.add (makeEngineCapability ("setInputMonitor", "process", "MOSH-owned monitor posture persisted in session JSON."));
    caps.add (makeEngineCapability ("stopRecording", "process", "Structured no-live-input recording stop posture for this process slice."));
    caps.add (makeEngineCapability ("setTempo", "process", "MOSH-owned tempo intent persisted in session JSON."));
    caps.add (makeEngineCapability ("insertTempoChange", "process", "MOSH-owned tempo-map point persisted in session JSON; native tempo-ramp playback is deferred."));
    caps.add (makeEngineCapability ("removeTempoChange", "process", "MOSH-owned tempo-map point removal persisted in session JSON."));
    caps.add (makeEngineCapability ("setTempoCurve", "process", "MOSH-owned tempo curve metadata persisted in session JSON; native ramp playback is deferred."));
    caps.add (makeEngineCapability ("setTimeSignature", "process", "MOSH-owned time-signature intent persisted in session JSON."));
    caps.add (makeEngineCapability ("insertTimeSigChange", "process", "MOSH-owned time-signature map point persisted in session JSON."));
    caps.add (makeEngineCapability ("removeTimeSigChange", "process", "MOSH-owned time-signature map point removal persisted in session JSON."));
    caps.add (makeEngineCapability ("setMetronome", "process", "MOSH-owned metronome preference persisted in session JSON."));
    caps.add (makeEngineCapability ("setProjectSettings", "process", "MOSH-owned project export/time-base defaults persisted in session JSON."));
    caps.add (makeEngineCapability ("setTransport", "process", "Stop/seek state and bounded Maolan playback smoke are process-backed; record is unsupported."));
    caps.add (makeEngineCapability ("renderExport", "process", "Maolan offline bounce for plugin graphs, session-folder export for clip-only graphs, smoke fallback for empty graphs."));
    caps.add (makeEngineCapability ("saveSessionGraph", "process", "Writes MOSH graph and Maolan session-folder JSON."));
    caps.add (makeEngineCapability ("restoreSessionGraph", "process", "Restores MOSH graph and rematerializes Maolan session-folder JSON."));
    caps.add (makeEngineCapability ("diagnostics", "process", "Reports env/script/artifact readiness."));
    return caps;
}

File MaolanProcessBackend::contractScript() const
{
    return context.repoRoot.getChildFile ("scripts").getChildFile ("maolan-contract-slice-gate.sh");
}

File MaolanProcessBackend::maolanMoshDir() const
{
    return File (defaultMaolanMoshDir());
}

File MaolanProcessBackend::maolanEnvFile() const
{
    return File (defaultMaolanEnvFile());
}

File MaolanProcessBackend::fixturePlugin() const
{
    return File (defaultPluginPath());
}

File MaolanProcessBackend::defaultEvidenceDir() const
{
    const auto envOutputDir = SystemStats::getEnvironmentVariable ("MOSH_ENGINE_CONTRACT_OUTPUT_DIR", {}).trim();
    if (envOutputDir.isNotEmpty())
        return File (envOutputDir);

    const auto now = Time::getCurrentTime();
    const auto day = now.formatted ("%Y-%m-%d");
    const auto stamp = now.formatted ("%Y%m%d-%H%M%S");
    return context.repoRoot
        .getChildFile ("_preserved_artifacts")
        .getChildFile (day + "-maolan-contract")
        .getChildFile (stamp);
}

void MaolanProcessBackend::configureEvidenceDir (const File& outputDir)
{
    state = {};
    state.outputDir = outputDir;
    state.clipsDir = outputDir.getChildFile ("clips");
    state.commandLog = outputDir.getChildFile ("command-log.jsonl");
    state.timingCsv = outputDir.getChildFile ("timing.csv");
    state.sessionGraph = outputDir.getChildFile ("session-graph.json");
    state.restoredSessionGraph = outputDir.getChildFile ("restored-session-graph.json");
    state.summary = outputDir.getChildFile ("summary.json");
    state.smokeDir = outputDir.getChildFile ("maolanmosh-smoke");
    state.renderDir = outputDir.getChildFile ("render-smoke");
    state.playbackDir = outputDir.getChildFile ("playback-smoke");
    state.maolanSessionDir = state.renderDir.getChildFile ("maolan-session");
    state.maolanSessionAudioDir = state.maolanSessionDir.getChildFile ("audio");
    state.maolanSessionJson = state.maolanSessionDir.getChildFile ("main.json");
    state.persistenceMaolanSessionDir = outputDir.getChildFile ("session-maolan");
    state.persistenceMaolanSessionAudioDir = state.persistenceMaolanSessionDir.getChildFile ("audio");
    state.persistenceMaolanSessionJson = state.persistenceMaolanSessionDir.getChildFile ("main.json");
    state.maolanStdout = outputDir.getChildFile ("maolanmosh.stdout.log");
    state.maolanStderr = outputDir.getChildFile ("maolanmosh.stderr.log");
    state.renderStdout = outputDir.getChildFile ("render.stdout.log");
    state.renderStderr = outputDir.getChildFile ("render.stderr.log");
    state.renderWav = state.renderDir.getChildFile ("maolan-render-smoke.wav");
    state.renderStats = state.renderDir.getChildFile ("maolan-render-smoke-stats.json");
    state.playbackStdout = outputDir.getChildFile ("playback.stdout.log");
    state.playbackStderr = outputDir.getChildFile ("playback.stderr.log");
    state.playbackStats = state.playbackDir.getChildFile ("maolan-play-session-smoke-stats.json");
    state.pluginPath = fixturePlugin().getFullPathName();
    SliceState::TempoPoint baseTempo;
    baseTempo.time = 0.0;
    baseTempo.bpm = state.tempoBpm;
    baseTempo.curve = 1.0;
    state.tempoMap.push_back (baseTempo);
    SliceState::TimeSigPoint baseTimeSig;
    baseTimeSig.time = 0.0;
    baseTimeSig.numerator = state.timeSigNumerator;
    baseTimeSig.denominator = state.timeSigDenominator;
    state.timeSigMap.push_back (baseTimeSig);
    state.outputDir.createDirectory();
    state.clipsDir.createDirectory();
    state.smokeDir.createDirectory();
    state.renderDir.createDirectory();
    state.playbackDir.createDirectory();
    state.maolanSessionDir.createDirectory();
    state.maolanSessionAudioDir.createDirectory();
    state.persistenceMaolanSessionDir.createDirectory();
    state.persistenceMaolanSessionAudioDir.createDirectory();
    state.commandLog.replaceWithText ({});
}

void MaolanProcessBackend::ensureEvidenceDir()
{
    if (! state.outputDir.exists())
        configureEvidenceDir (defaultEvidenceDir());
}

String MaolanProcessBackend::nextTrackId() const
{
    for (int candidate = static_cast<int> (state.tracks.size()) + 1; candidate < 100000; ++candidate)
    {
        const auto id = "track-" + String (candidate);
        bool exists = false;
        for (const auto& track : state.tracks)
        {
            if (track.id == id)
            {
                exists = true;
                break;
            }
        }
        if (! exists)
            return id;
    }
    return "track-" + String (Time::getCurrentTime().toMilliseconds());
}

String MaolanProcessBackend::nextClipId() const
{
    int existing = 0;
    for (const auto& track : state.tracks)
        existing += static_cast<int> (track.clips.size());

    for (int candidate = existing + 1; candidate < 1000000; ++candidate)
    {
        const auto id = "clip-" + String (candidate);
        bool exists = false;
        for (const auto& track : state.tracks)
        {
            for (const auto& clip : track.clips)
            {
                if (clip.id == id)
                {
                    exists = true;
                    break;
                }
            }
            if (exists)
                break;
        }
        if (! exists)
            return id;
    }
    return "clip-" + String (Time::getCurrentTime().toMilliseconds());
}

MaolanProcessBackend::SliceState::Track* MaolanProcessBackend::findTrack (const String& trackId)
{
    for (auto& track : state.tracks)
        if (track.id == trackId)
            return &track;
    return nullptr;
}

const MaolanProcessBackend::SliceState::Track* MaolanProcessBackend::findTrack (const String& trackId) const
{
    for (const auto& track : state.tracks)
        if (track.id == trackId)
            return &track;
    return nullptr;
}

MaolanProcessBackend::SliceState::Track* MaolanProcessBackend::firstTrack()
{
    return state.tracks.empty() ? nullptr : &state.tracks.front();
}

MaolanProcessBackend::SliceState::Bus* MaolanProcessBackend::findBus (int bus)
{
    for (auto& candidate : state.buses)
        if (candidate.bus == bus)
            return &candidate;
    return nullptr;
}

const MaolanProcessBackend::SliceState::Bus* MaolanProcessBackend::findBus (int bus) const
{
    for (const auto& candidate : state.buses)
        if (candidate.bus == bus)
            return &candidate;
    return nullptr;
}

int MaolanProcessBackend::nextBusNumber() const
{
    for (int candidate = 0; candidate < 1024; ++candidate)
    {
        bool exists = false;
        for (const auto& bus : state.buses)
            if (bus.bus == candidate)
            {
                exists = true;
                break;
            }
        if (! exists)
            return candidate;
    }
    return static_cast<int> (state.buses.size());
}

MaolanProcessBackend::SliceState::Plugin* MaolanProcessBackend::findPlugin (SliceState::Track& track, int index)
{
    return index >= 0 && index < (int) track.plugins.size() ? &track.plugins[(size_t) index] : nullptr;
}

const MaolanProcessBackend::SliceState::Plugin* MaolanProcessBackend::findPlugin (const SliceState::Track& track, int index) const
{
    return index >= 0 && index < (int) track.plugins.size() ? &track.plugins[(size_t) index] : nullptr;
}

bool MaolanProcessBackend::isPluginBlocked (const String& pluginId, const String& pluginPath) const
{
    const auto fixturePath = state.pluginPath.isNotEmpty() ? state.pluginPath : fixturePlugin().getFullPathName();
    const auto path = pluginPath.isNotEmpty() ? pluginPath : fixturePath;
    const auto filename = File (path).getFileName();

    for (const auto& blocked : state.pluginBlocklist)
    {
        if (blocked == pluginId || blocked == path || blocked == filename)
            return true;
        if (blocked == "jampilot-test-gain-vst3"
            && (pluginId == "jampilot-test-gain-vst3" || path.contains ("JamPilotTestGain.vst3")))
            return true;
        if (blocked.contains ("JamPilotTestGain.vst3") && path.contains ("JamPilotTestGain.vst3"))
            return true;
    }

    return false;
}

var MaolanProcessBackend::pluginBlocklistData() const
{
    Array<var> entries;
    const auto fixturePath = state.pluginPath.isNotEmpty() ? state.pluginPath : fixturePlugin().getFullPathName();
    for (const auto& blocked : state.pluginBlocklist)
    {
        auto* o = new DynamicObject();
        o->setProperty ("id", (blocked == fixturePath || blocked.contains ("JamPilotTestGain.vst3"))
                                ? String ("jampilot-test-gain-vst3") : blocked);
        o->setProperty ("rawId", blocked);
        o->setProperty ("reason", "blocked");
        entries.add (var (o));
    }

    auto* data = new DynamicObject();
    data->setProperty ("blocklist", entries);
    data->setProperty ("count", entries.size());
    data->setProperty ("sessionGraph", state.sessionGraph.getFullPathName());
    return var (data);
}

MaolanProcessBackend::SliceState::PluginParam* MaolanProcessBackend::findPluginParam (SliceState::Plugin& plugin, int paramIndex)
{
    for (auto& param : plugin.params)
        if (param.index == paramIndex)
            return &param;
    return nullptr;
}

MaolanProcessBackend::SliceState::PluginParam& MaolanProcessBackend::findOrCreatePluginParam (SliceState::Plugin& plugin, int paramIndex)
{
    if (auto* param = findPluginParam (plugin, paramIndex))
        return *param;

    SliceState::PluginParam param;
    param.index = paramIndex;
    param.name = "Param " + String (paramIndex);
    param.value = 0.0;
    plugin.params.push_back (param);
    return plugin.params.back();
}

var MaolanProcessBackend::pluginResultData (const SliceState::Track& track, const SliceState::Plugin& plugin, int index) const
{
    Array<var> params;
    for (const auto& param : plugin.params)
    {
        Array<var> points;
        for (int i = 0; i < (int) param.points.size(); ++i)
        {
            const auto& point = param.points[(size_t) i];
            points.add (objectWith ({
                { "i", i },
                { "t", point.time },
                { "time", point.time },
                { "v", point.value },
                { "value", point.value },
                { "curve", point.curve },
            }));
        }

        params.add (objectWith ({
            { "index", param.index },
            { "name", param.name.isNotEmpty() ? param.name : String ("Param ") + String (param.index) },
            { "value", param.value },
            { "automated", ! param.points.empty() },
            { "points", points },
        }));
    }

    return objectWith ({
        { "trackId", track.id },
        { "index", index },
        { "pluginId", plugin.id },
        { "id", plugin.id },
        { "name", plugin.name },
        { "type", plugin.format },
        { "format", plugin.format },
        { "file", plugin.path },
        { "path", plugin.path },
        { "enabled", plugin.enabled },
        { "external", true },
        { "builtin", false },
        { "isInstrument", plugin.isInstrument },
        { "identifier", plugin.id },
        { "manufacturer", "Maolan" },
        { "params", params },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    });
}

var MaolanProcessBackend::pluginParamAutomationData (const SliceState::Track& track,
                                                    const SliceState::Plugin& plugin,
                                                    int pluginIndex,
                                                    const SliceState::PluginParam& param,
                                                    int pointIndex) const
{
    auto data = pluginResultData (track, plugin, pluginIndex);
    if (auto* o = data.getDynamicObject())
    {
        Array<var> points;
        for (int i = 0; i < (int) param.points.size(); ++i)
        {
            const auto& point = param.points[(size_t) i];
            points.add (objectWith ({
                { "i", i },
                { "t", point.time },
                { "time", point.time },
                { "v", point.value },
                { "value", point.value },
                { "curve", point.curve },
            }));
        }

        o->setProperty ("paramIndex", param.index);
        o->setProperty ("pointIndex", pointIndex);
        o->setProperty ("points", points);
        o->setProperty ("automated", ! param.points.empty());
    }
    return data;
}

MaolanProcessBackend::SliceState::Clip* MaolanProcessBackend::findClip (const String& clipId, SliceState::Track** owner)
{
    for (auto& track : state.tracks)
    {
        for (auto& clip : track.clips)
        {
            if (clip.id == clipId)
            {
                if (owner != nullptr)
                    *owner = &track;
                return &clip;
            }
        }
    }
    if (owner != nullptr)
        *owner = nullptr;
    return nullptr;
}

const MaolanProcessBackend::SliceState::Clip* MaolanProcessBackend::findClip (const String& clipId, const SliceState::Track** owner) const
{
    for (const auto& track : state.tracks)
    {
        for (const auto& clip : track.clips)
        {
            if (clip.id == clipId)
            {
                if (owner != nullptr)
                    *owner = &track;
                return &clip;
            }
        }
    }
    if (owner != nullptr)
        *owner = nullptr;
    return nullptr;
}

double MaolanProcessBackend::audioFileLengthSeconds (const File& file) const
{
    auto stream = file.createInputStream();
    if (stream == nullptr || stream->getTotalLength() < 44)
        return 0.0;

    MemoryBlock bytes;
    stream->readIntoMemoryBlock (bytes, (ssize_t) jmin<int64> (stream->getTotalLength(), 1024 * 1024));
    const auto* data = static_cast<const char*> (bytes.getData());
    const auto size = bytes.getSize();
    if (size < 44 || String::fromUTF8 (data, 4) != "RIFF" || String::fromUTF8 (data + 8, 4) != "WAVE")
        return 0.0;

    uint16 channels = 0;
    uint32 sampleRate = 0;
    uint16 bitsPerSample = 0;
    uint32 dataBytes = 0;

    size_t cursor = 12;
    while (cursor + 8 <= size)
    {
        const String chunkId = String::fromUTF8 (data + cursor, 4);
        const auto chunkSize = readU32LE (data + cursor + 4);
        const auto chunkData = cursor + 8;
        if (chunkData + chunkSize > size)
            break;

        if (chunkId == "fmt " && chunkSize >= 16)
        {
            channels = readU16LE (data + chunkData + 2);
            sampleRate = readU32LE (data + chunkData + 4);
            bitsPerSample = readU16LE (data + chunkData + 14);
        }
        else if (chunkId == "data")
        {
            dataBytes = chunkSize;
            break;
        }

        cursor = chunkData + chunkSize + (chunkSize % 2);
    }

    if (channels == 0 || sampleRate == 0 || bitsPerSample == 0 || dataBytes == 0)
        return 0.0;

    const auto bytesPerFrame = (uint32) channels * ((uint32) bitsPerSample / 8u);
    if (bytesPerFrame == 0)
        return 0.0;

    return (double) (dataBytes / bytesPerFrame) / (double) sampleRate;
}

bool MaolanProcessBackend::writeToneClipFile (const File& file, double seconds, double frequencyHz) const
{
    const double safeSeconds = jlimit (0.01, 60.0, seconds);
    const double safeFrequency = jlimit (20.0, 20000.0, frequencyHz);
    const double sampleRate = 48000.0;
    const int frames = jmax (1, (int) std::round (safeSeconds * sampleRate));
    const uint16 channels = 2;
    const uint16 bitsPerSample = 16;
    const uint32 bytesPerFrame = (uint32) channels * ((uint32) bitsPerSample / 8u);
    const uint32 dataBytes = (uint32) frames * bytesPerFrame;
    const uint32 sampleRateInt = 48000;

    file.deleteFile();
    auto stream = file.createOutputStream();
    if (stream == nullptr)
        return false;

    stream->write ("RIFF", 4);
    writeU32LE (*stream, 36u + dataBytes);
    stream->write ("WAVE", 4);
    stream->write ("fmt ", 4);
    writeU32LE (*stream, 16);
    writeU16LE (*stream, 1);
    writeU16LE (*stream, channels);
    writeU32LE (*stream, sampleRateInt);
    writeU32LE (*stream, sampleRateInt * bytesPerFrame);
    writeU16LE (*stream, (uint16) bytesPerFrame);
    writeU16LE (*stream, bitsPerSample);
    stream->write ("data", 4);
    writeU32LE (*stream, dataBytes);

    for (int sample = 0; sample < frames; ++sample)
    {
        const auto value = (int16) std::round (std::sin (MathConstants<double>::twoPi * safeFrequency * (double) sample / sampleRate) * 0.2 * 32767.0);
        writeU16LE (*stream, (uint16) value);
        writeU16LE (*stream, (uint16) value);
    }

    stream->flush();
    stream.reset();
    return file.existsAsFile() && file.getSize() > 44;
}

bool MaolanProcessBackend::hasRenderableClips() const
{
    for (const auto& track : state.tracks)
        for (const auto& clip : track.clips)
            if (clip.type == "wave" && clip.sourcePath.isNotEmpty() && File (clip.sourcePath).existsAsFile())
                return true;

    return false;
}

bool MaolanProcessBackend::hasLoadedPlugins() const
{
    for (const auto& track : state.tracks)
        if (! track.plugins.empty())
            return true;

    return false;
}

double MaolanProcessBackend::bpmAtSeconds (double seconds) const
{
    double bpm = state.tempoBpm;
    for (const auto& point : state.tempoMap)
        if (point.time <= seconds)
            bpm = point.bpm;
    return jlimit (20.0, 999.0, bpm);
}

double MaolanProcessBackend::warpedLengthSeconds (const SliceState::Clip& clip) const
{
    if (! clip.autoTempo)
        return clip.lengthSeconds;

    const double sourceLength = clip.warpSourceLengthSeconds > 0.0
                                    ? clip.warpSourceLengthSeconds
                                    : clip.lengthSeconds;
    const double sourceBpm = clip.sourceBpm > 0.0 ? clip.sourceBpm : bpmAtSeconds (clip.startSeconds);
    const double targetBpm = bpmAtSeconds (clip.startSeconds);
    return jmax (0.01, sourceLength * sourceBpm / targetBpm);
}

void MaolanProcessBackend::refreshWarpedClipLengths()
{
    for (auto& track : state.tracks)
        for (auto& clip : track.clips)
            if (clip.autoTempo)
                clip.lengthSeconds = warpedLengthSeconds (clip);
}

bool MaolanProcessBackend::writeMaolanSessionFolderTo (const File& sessionDir,
                                                       const File& audioDir,
                                                       const File& sessionJson,
                                                       String& error)
{
    sessionDir.deleteRecursively();
    if (! sessionDir.createDirectory() || ! audioDir.createDirectory())
    {
        error = "Could not create Maolan session directory: " + sessionDir.getFullPathName();
        return false;
    }

    Array<var> tracks;
    Array<var> connections;
    auto* graphsObject = new DynamicObject();
    var graphs (graphsObject);
    bool hasGraphs = false;
    int trackNumber = 0;
    for (const auto& track : state.tracks)
    {
        if (track.isGroup)
            continue;

        ++trackNumber;
        const auto trackName = track.name.isNotEmpty() ? track.name : String ("Maolan Track ") + String (trackNumber);

        Array<var> clips;
        int clipNumber = 0;
        for (const auto& clip : track.clips)
        {
            ++clipNumber;
            if (clip.type != "wave")
                continue;

            const File source (clip.sourcePath);
            if (! source.existsAsFile())
            {
                error = "Maolan export clip source missing: " + source.getFullPathName();
                return false;
            }

            const auto copiedName = File::createLegalFileName (
                (clip.id.isNotEmpty() ? clip.id : String ("clip-") + String (clipNumber))
                + "-" + (clip.name.isNotEmpty() ? clip.name : String ("audio")) + ".wav");
            const auto copied = audioDir.getChildFile (copiedName);
            if (! source.copyFileTo (copied))
            {
                error = "Could not copy Maolan session clip source to: " + copied.getFullPathName();
                return false;
            }

            clips.add (objectWith ({
                { "name", String ("audio/") + copied.getFileName() },
                { "start", secondsToMaolanFrames (clip.startSeconds) },
                { "length", jmax (1, secondsToMaolanFrames (warpedLengthSeconds (clip))) },
                { "offset", secondsToMaolanFrames (clip.offsetSeconds) },
                { "muted", clip.mute },
                { "fade_enabled", false },
            }));
        }

        Array<var> graphPlugins;
        Array<var> graphConnections;
        for (int pluginIndex = 0; pluginIndex < (int) track.plugins.size(); ++pluginIndex)
        {
            const auto& plugin = track.plugins[(size_t) pluginIndex];
            const auto format = maolanPluginFormat (plugin.format);
            const auto pluginPath = plugin.path.isNotEmpty() ? plugin.path : state.pluginPath;
            graphPlugins.add (objectWith ({
                { "format", format },
                { "uri", pluginPath },
                { "state", var() },
                { "bypassed", ! plugin.enabled },
            }));
        }

        if (graphPlugins.size() > 0)
        {
            for (int port = 0; port < 2; ++port)
            {
                for (int pluginIndex = 0; pluginIndex <= graphPlugins.size(); ++pluginIndex)
                {
                    const bool fromTrackInput = pluginIndex == 0;
                    const bool toTrackOutput = pluginIndex == graphPlugins.size();
                    graphConnections.add (objectWith ({
                        { "from_node", fromTrackInput ? maolanTrackNode ("track_input")
                                                      : maolanPluginNode (track.plugins[(size_t) pluginIndex - 1].format, pluginIndex - 1) },
                        { "from_port", port },
                        { "to_node", toTrackOutput ? maolanTrackNode ("track_output")
                                                    : maolanPluginNode (track.plugins[(size_t) pluginIndex].format, pluginIndex) },
                        { "to_port", port },
                        { "kind", "Audio" },
                    }));
                }
            }

            graphsObject->setProperty (trackName, objectWith ({
                { "plugins", graphPlugins },
                { "connections", graphConnections },
            }));
            hasGraphs = true;
        }

        Array<var> midiClips;
        tracks.add (objectWith ({
            { "name", trackName },
            { "level", track.volumeDb },
            { "balance", track.pan },
            { "muted", track.mute },
            { "soloed", track.solo },
            { "audio", objectWith ({
                { "ins", 2 },
                { "outs", 2 },
                { "clips", clips },
            }) },
            { "midi", objectWith ({
                { "ins", 0 },
                { "outs", 0 },
                { "clips", midiClips },
            }) },
        }));

        connections.add (objectWith ({
            { "from_track", trackName },
            { "from_port", 0 },
            { "to_track", "hw:out" },
            { "to_port", 0 },
            { "kind", "audio" },
        }));
        connections.add (objectWith ({
            { "from_track", trackName },
            { "from_port", 1 },
            { "to_track", "hw:out" },
            { "to_port", 1 },
            { "kind", "audio" },
        }));
    }

    auto session = objectWith ({
        { "tracks", tracks },
        { "connections", connections },
    });
    if (hasGraphs)
        session.getDynamicObject()->setProperty ("graphs", graphs);
    if (! sessionJson.replaceWithText (JSON::toString (session, true) + "\n"))
    {
        error = "Could not write Maolan session JSON: " + sessionJson.getFullPathName();
        return false;
    }

    refreshWarpedClipLengths();
    return true;
}

bool MaolanProcessBackend::writeMaolanSessionFolder (String& error)
{
    return writeMaolanSessionFolderTo (state.maolanSessionDir,
                                       state.maolanSessionAudioDir,
                                       state.maolanSessionJson,
                                       error);
}

var MaolanProcessBackend::clipResultData (const SliceState::Track& track, const SliceState::Clip& clip) const
{
    Array<var> notes;
    for (int i = 0; i < (int) clip.notes.size(); ++i)
    {
        const auto& note = clip.notes[(size_t) i];
        notes.add (objectWith ({
            { "i", i },
            { "pitch", note.pitch },
            { "start", note.start },
            { "length", note.length },
            { "velocity", note.velocity },
        }));
    }

    return objectWith ({
        { "trackId", track.id },
        { "clipId", clip.id },
        { "id", clip.id },
        { "name", clip.name },
        { "type", clip.type },
        { "sourceKind", clip.sourceKind },
        { "sourcePath", clip.sourcePath },
        { "file", clip.sourcePath },
        { "start", clip.startSeconds },
        { "startSeconds", clip.startSeconds },
        { "length", warpedLengthSeconds (clip) },
        { "lengthSeconds", warpedLengthSeconds (clip) },
        { "offset", clip.offsetSeconds },
        { "offsetSeconds", clip.offsetSeconds },
        { "gainDb", clip.gainDb },
        { "mute", clip.mute },
        { "frequencyHz", clip.frequencyHz },
        { "autoTempo", clip.autoTempo },
        { "sourceBpm", clip.sourceBpm },
        { "stretchMode", clip.stretchMode.isNotEmpty() ? clip.stretchMode : String ("SoundTouch") },
        { "warpSourceLengthSeconds", clip.warpSourceLengthSeconds },
        { "notes", notes },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    });
}

var MaolanProcessBackend::buildSessionGraph() const
{
    Array<var> tracks;
    for (const auto& track : state.tracks)
    {
        Array<var> clips;
        for (const auto& clip : track.clips)
        {
            Array<var> notes;
            for (int i = 0; i < (int) clip.notes.size(); ++i)
            {
                const auto& note = clip.notes[(size_t) i];
                notes.add (objectWith ({
                    { "i", i },
                    { "pitch", note.pitch },
                    { "start", note.start },
                    { "length", note.length },
                    { "velocity", note.velocity },
                }));
            }

            clips.add (objectWith ({
                { "id", clip.id },
                { "name", clip.name.isNotEmpty() ? clip.name : String ("Maolan Clip") },
                { "type", clip.type.isNotEmpty() ? clip.type : String ("wave") },
                { "sourceKind", clip.sourceKind.isNotEmpty() ? clip.sourceKind : String ("file") },
                { "sourcePath", clip.sourcePath },
                { "startSeconds", clip.startSeconds },
                { "lengthSeconds", warpedLengthSeconds (clip) },
                { "offsetSeconds", clip.offsetSeconds },
                { "gainDb", clip.gainDb },
                { "mute", clip.mute },
                { "frequencyHz", clip.frequencyHz },
                { "autoTempo", clip.autoTempo },
                { "sourceBpm", clip.sourceBpm },
                { "stretchMode", clip.stretchMode.isNotEmpty() ? clip.stretchMode : String ("SoundTouch") },
                { "warpSourceLengthSeconds", clip.warpSourceLengthSeconds },
                { "notes", notes },
            }));
        }

        Array<var> plugins;
        for (const auto& plugin : track.plugins)
        {
            Array<var> params;
            for (const auto& param : plugin.params)
            {
                Array<var> points;
                for (int i = 0; i < (int) param.points.size(); ++i)
                {
                    const auto& point = param.points[(size_t) i];
                    points.add (objectWith ({
                        { "i", i },
                        { "t", point.time },
                        { "time", point.time },
                        { "v", point.value },
                        { "value", point.value },
                        { "curve", point.curve },
                    }));
                }

                params.add (objectWith ({
                    { "index", param.index },
                    { "name", param.name.isNotEmpty() ? param.name : String ("Param ") + String (param.index) },
                    { "value", param.value },
                    { "automated", ! param.points.empty() },
                    { "points", points },
                }));
            }

            plugins.add (objectWith ({
                { "id", plugin.id },
                { "format", plugin.format.isNotEmpty() ? plugin.format : String ("vst3") },
                { "path", plugin.path.isNotEmpty() ? plugin.path : state.pluginPath },
                { "name", plugin.name.isNotEmpty() ? plugin.name : pluginNameFromPath (plugin.path.isNotEmpty() ? plugin.path : state.pluginPath) },
                { "enabled", plugin.enabled },
                { "isInstrument", plugin.isInstrument },
                { "params", params },
            }));
        }

        Array<var> sends;
        for (const auto& send : track.sends)
        {
            sends.add (objectWith ({
                { "bus", send.bus },
                { "db", send.db },
                { "mute", send.mute },
            }));
        }

        tracks.add (objectWith ({
            { "id", track.id },
            { "name", track.name.isNotEmpty() ? track.name : String ("Maolan Track") },
            { "type", track.type.isNotEmpty() ? track.type : String ("audio") },
            { "isGroup", track.isGroup },
            { "parentId", track.parentId },
            { "isReturn", track.isReturn },
            { "returnBus", track.returnBus },
            { "volumeDb", track.volumeDb },
            { "pan", track.pan },
            { "mute", track.mute },
            { "solo", track.solo },
            { "meterEnabled", track.meterEnabled },
            { "armed", track.armed },
            { "monitor", track.monitor.isNotEmpty() ? track.monitor : String ("automatic") },
            { "hasInput", false },
            { "inputDeviceID", track.inputDeviceId },
            { "sends", sends },
            { "clips", clips },
            { "plugins", plugins },
        }));
        auto& graphTrack = tracks.getReference (tracks.size() - 1);
        if (auto* graphTrackObject = graphTrack.getDynamicObject())
        {
            if (track.inputDeviceId.isNotEmpty())
                graphTrackObject->setProperty ("input", objectWith ({
                    { "deviceID", track.inputDeviceId },
                    { "name", track.inputDeviceId },
                }));

            if (track.outputKind == "track")
                graphTrackObject->setProperty ("output", objectWith ({
                    { "isTrack", true },
                    { "destId", track.outputDestTrackId },
                }));
            else if (track.outputKind == "device")
                graphTrackObject->setProperty ("output", objectWith ({
                    { "isTrack", false },
                    { "deviceID", track.outputDeviceId },
                    { "name", track.outputDeviceId },
                }));
        }
    }

    Array<var> buses;
    for (const auto& bus : state.buses)
    {
        buses.add (objectWith ({
            { "bus", bus.bus },
            { "name", bus.name.isNotEmpty() ? bus.name : String ("Bus ") + String (bus.bus + 1) },
            { "trackId", bus.trackId },
        }));
    }

    auto render = objectWith ({
        { "path", state.renderWav.existsAsFile() ? state.renderWav.getFullPathName() : String() },
        { "stats", state.renderStats.existsAsFile() ? state.renderStats.getFullPathName() : String() },
    });
    if (state.renderStats.existsAsFile())
    {
        auto parsed = JSON::parse (state.renderStats.loadFileAsString());
        render.getDynamicObject()->setProperty ("data", parsed);
    }
    auto playback = objectWith ({
        { "stats", state.playbackStats.existsAsFile() ? state.playbackStats.getFullPathName() : String() },
    });
    if (state.playbackStats.existsAsFile())
    {
        auto parsed = JSON::parse (state.playbackStats.loadFileAsString());
        playback.getDynamicObject()->setProperty ("data", parsed);
    }

    Array<var> tempoMap;
    const auto& tempoPoints = state.tempoMap.empty() ? std::vector<SliceState::TempoPoint> { { 0.0, state.tempoBpm, 1.0 } }
                                                     : state.tempoMap;
    for (const auto& point : tempoPoints)
    {
        tempoMap.add (objectWith ({
            { "time", point.time },
            { "bpm", point.bpm },
            { "curve", point.curve },
        }));
    }
    Array<var> timeSigMap;
    const auto& timeSigPoints = state.timeSigMap.empty() ? std::vector<SliceState::TimeSigPoint> { { 0.0, state.timeSigNumerator, state.timeSigDenominator } }
                                                         : state.timeSigMap;
    for (const auto& point : timeSigPoints)
    {
        timeSigMap.add (objectWith ({
            { "time", point.time },
            { "numerator", point.numerator },
            { "denominator", point.denominator },
        }));
    }

    Array<var> pluginBlocklist;
    for (const auto& blocked : state.pluginBlocklist)
        pluginBlocklist.add (blocked);

    return objectWith ({
        { "schemaVersion", 1 },
        { "backend", backendId() },
        { "device", state.device },
        { "sessionId", state.sessionId },
        { "pluginBlocklist", pluginBlocklist },
        { "tempo", state.tempoBpm },
        { "tempoMap", tempoMap },
        { "timeSigNumerator", state.timeSigNumerator },
        { "timeSigDenominator", state.timeSigDenominator },
        { "timeSigMap", timeSigMap },
        { "metronome", state.metronome },
        { "master", objectWith ({
            { "volumeDb", state.masterVolumeDb },
            { "pan", state.masterPan },
        }) },
        { "buses", buses },
        { "project", objectWith ({
            { "sampleRate", state.projectSampleRate },
            { "bitDepth", state.projectBitDepth },
            { "timeBase", state.projectTimeBase },
        }) },
        { "tracks", tracks },
        { "transport", objectWith ({{ "playing", state.transportPlaying }, { "position", state.transportPosition }}) },
        { "render", render },
        { "playback", playback },
        { "artifacts", objectWith ({
            { "outputDir", state.outputDir.getFullPathName() },
            { "commandLog", state.commandLog.getFullPathName() },
            { "timingCsv", state.timingCsv.getFullPathName() },
            { "sessionGraph", state.sessionGraph.getFullPathName() },
            { "restoredSessionGraph", state.restoredSessionGraph.getFullPathName() },
            { "clipsDir", state.clipsDir.getFullPathName() },
            { "renderWav", state.renderWav.getFullPathName() },
            { "renderStats", state.renderStats.getFullPathName() },
            { "playbackStats", state.playbackStats.getFullPathName() },
            { "maolanSessionDir", state.maolanSessionDir.getFullPathName() },
            { "maolanSessionJson", state.maolanSessionJson.getFullPathName() },
            { "persistenceMaolanSessionDir", state.persistenceMaolanSessionDir.getFullPathName() },
            { "persistenceMaolanSessionJson", state.persistenceMaolanSessionJson.getFullPathName() },
        }) },
    });
}

var MaolanProcessBackend::sessionGraph() const
{
    return buildSessionGraph();
}

bool MaolanProcessBackend::applySessionGraph (const var& graph)
{
    if (graph.isVoid() || ! graph.isObject())
        return false;

    state.sessionId = graph.getProperty ("sessionId", state.sessionId).toString();
    state.device = graph.getProperty ("device", state.device).toString();
    state.tempoBpm = jlimit (20.0, 999.0, (double) graph.getProperty ("tempo", state.tempoBpm));
    state.timeSigNumerator = jlimit (1, 32, (int) graph.getProperty ("timeSigNumerator", state.timeSigNumerator));
    state.timeSigDenominator = (int) graph.getProperty ("timeSigDenominator", state.timeSigDenominator);
    if (! (state.timeSigDenominator == 1 || state.timeSigDenominator == 2 || state.timeSigDenominator == 4
           || state.timeSigDenominator == 8 || state.timeSigDenominator == 16 || state.timeSigDenominator == 32))
        state.timeSigDenominator = 4;
    state.tempoMap.clear();
    const auto tempoMap = graph.getProperty ("tempoMap", var());
    if (auto* tempoArr = tempoMap.getArray())
    {
        for (const auto& pointVar : *tempoArr)
        {
            SliceState::TempoPoint point;
            point.time = jmax (0.0, (double) pointVar.getProperty ("time", 0.0));
            point.bpm = jlimit (20.0, 999.0, (double) pointVar.getProperty ("bpm", state.tempoBpm));
            point.curve = (double) pointVar.getProperty ("curve", 1.0);
            state.tempoMap.push_back (point);
        }
    }
    if (state.tempoMap.empty())
        state.tempoMap.push_back ({ 0.0, state.tempoBpm, 1.0 });
    std::sort (state.tempoMap.begin(), state.tempoMap.end(),
               [] (const SliceState::TempoPoint& a, const SliceState::TempoPoint& b)
               {
                   return a.time < b.time;
               });
    state.tempoMap.front().time = 0.0;
    state.tempoBpm = state.tempoMap.front().bpm;

    state.timeSigMap.clear();
    const auto timeSigMap = graph.getProperty ("timeSigMap", var());
    if (auto* sigArr = timeSigMap.getArray())
    {
        for (const auto& pointVar : *sigArr)
        {
            SliceState::TimeSigPoint point;
            point.time = jmax (0.0, (double) pointVar.getProperty ("time", 0.0));
            point.numerator = jlimit (1, 32, (int) pointVar.getProperty ("numerator", state.timeSigNumerator));
            const int denominator = (int) pointVar.getProperty ("denominator", state.timeSigDenominator);
            point.denominator = (denominator == 1 || denominator == 2 || denominator == 4
                                 || denominator == 8 || denominator == 16 || denominator == 32)
                                    ? denominator : 4;
            state.timeSigMap.push_back (point);
        }
    }
    if (state.timeSigMap.empty())
        state.timeSigMap.push_back ({ 0.0, state.timeSigNumerator, state.timeSigDenominator });
    std::sort (state.timeSigMap.begin(), state.timeSigMap.end(),
               [] (const SliceState::TimeSigPoint& a, const SliceState::TimeSigPoint& b)
               {
                   return a.time < b.time;
               });
    state.timeSigMap.front().time = 0.0;
    state.timeSigNumerator = state.timeSigMap.front().numerator;
    state.timeSigDenominator = state.timeSigMap.front().denominator;
    state.metronome = (bool) graph.getProperty ("metronome", state.metronome);
    const auto project = graph.getProperty ("project", var());
    if (project.isObject())
    {
        state.projectSampleRate = jmax (7000.0, (double) project.getProperty ("sampleRate", state.projectSampleRate));
        const int bitDepth = (int) project.getProperty ("bitDepth", state.projectBitDepth);
        state.projectBitDepth = (bitDepth == 16 || bitDepth == 24 || bitDepth == 32) ? bitDepth : 24;
        const auto timeBase = project.getProperty ("timeBase", state.projectTimeBase).toString();
        state.projectTimeBase = (timeBase == "barsBeats") ? String ("barsBeats") : String ("seconds");
    }
    const auto master = graph.getProperty ("master", var());
    if (master.isObject())
    {
        state.masterVolumeDb = jlimit (-48.0, 6.0, (double) master.getProperty ("volumeDb", state.masterVolumeDb));
        state.masterPan = jlimit (-1.0, 1.0, (double) master.getProperty ("pan", state.masterPan));
    }

    const auto transport = graph.getProperty ("transport", var());
    if (transport.isObject())
    {
        state.transportPlaying = (bool) transport.getProperty ("playing", state.transportPlaying);
        state.transportPosition = (double) transport.getProperty ("position", state.transportPosition);
    }

    state.pluginBlocklist.clear();
    const auto pluginBlocklist = graph.getProperty ("pluginBlocklist", var());
    if (auto* blockArr = pluginBlocklist.getArray())
        for (const auto& blocked : *blockArr)
        {
            const auto value = blocked.toString();
            if (value.isNotEmpty()
                && std::find (state.pluginBlocklist.begin(), state.pluginBlocklist.end(), value) == state.pluginBlocklist.end())
                state.pluginBlocklist.push_back (value);
        }

    state.tracks.clear();
    state.buses.clear();
    const auto tracks = graph.getProperty ("tracks", var());
    if (auto* arr = tracks.getArray())
    {
        for (const auto& trackVar : *arr)
        {
            SliceState::Track track;
            track.id = trackVar.getProperty ("id", var()).toString();
            track.name = trackVar.getProperty ("name", var()).toString();
            track.type = trackVar.getProperty ("type", "audio").toString();
            track.isGroup = (bool) trackVar.getProperty ("isGroup", track.type == "group");
            track.parentId = trackVar.getProperty ("parentId", var()).toString();
            track.isReturn = (bool) trackVar.getProperty ("isReturn", false);
            track.returnBus = (int) trackVar.getProperty ("returnBus", -1);
            track.volumeDb = (double) trackVar.getProperty ("volumeDb", 0.0);
            track.pan = jlimit (-1.0, 1.0, (double) trackVar.getProperty ("pan", 0.0));
            track.mute = (bool) trackVar.getProperty ("mute", false);
            track.solo = (bool) trackVar.getProperty ("solo", false);
            track.meterEnabled = (bool) trackVar.getProperty ("meterEnabled", false);
            track.armed = (bool) trackVar.getProperty ("armed", false);
            track.monitor = trackVar.getProperty ("monitor", "automatic").toString();
            if (track.monitor != "off" && track.monitor != "on" && track.monitor != "automatic")
                track.monitor = "automatic";
            track.inputDeviceId = trackVar.getProperty ("inputDeviceID", var()).toString();
            const auto input = trackVar.getProperty ("input", var());
            if (track.inputDeviceId.isEmpty() && input.isObject())
                track.inputDeviceId = input.getProperty ("deviceID", var()).toString();
            const auto output = trackVar.getProperty ("output", var());
            if (output.isObject())
            {
                if ((bool) output.getProperty ("isTrack", false))
                {
                    track.outputKind = "track";
                    track.outputDestTrackId = output.getProperty ("destId", output.getProperty ("destTrackId", var())).toString();
                }
                else
                {
                    track.outputKind = "device";
                    track.outputDeviceId = output.getProperty ("deviceID", var()).toString();
                }
            }
            if (track.id.isEmpty())
                track.id = nextTrackId();
            if (track.name.isEmpty())
                track.name = "Maolan Track";
            if (track.isGroup)
                track.type = "group";

            const auto sends = trackVar.getProperty ("sends", var());
            if (auto* sendArr = sends.getArray())
            {
                for (const auto& sendVar : *sendArr)
                {
                    SliceState::Track::Send send;
                    send.bus = (int) sendVar.getProperty ("bus", -1);
                    send.db = jlimit (-100.0, 6.0, (double) sendVar.getProperty ("db", 0.0));
                    send.mute = (bool) sendVar.getProperty ("mute", false);
                    if (send.bus >= 0)
                        track.sends.push_back (send);
                }
            }

            const auto clips = trackVar.getProperty ("clips", var());
            if (auto* clipArr = clips.getArray())
            {
                for (const auto& clipVar : *clipArr)
                {
                    SliceState::Clip clip;
                    clip.id = clipVar.getProperty ("id", var()).toString();
                    if (clip.id.isEmpty())
                        clip.id = nextClipId();
                    clip.name = clipVar.getProperty ("name", "Maolan Clip").toString();
                    clip.type = clipVar.getProperty ("type", "wave").toString();
                    clip.sourceKind = clipVar.getProperty ("sourceKind", "file").toString();
                    clip.sourcePath = clipVar.getProperty ("sourcePath", clipVar.getProperty ("file", var())).toString();
                    clip.startSeconds = jmax (0.0, (double) clipVar.getProperty ("startSeconds", clipVar.getProperty ("start", 0.0)));
                    clip.lengthSeconds = jmax (0.0, (double) clipVar.getProperty ("lengthSeconds", clipVar.getProperty ("length", 0.0)));
                    clip.offsetSeconds = jmax (0.0, (double) clipVar.getProperty ("offsetSeconds", clipVar.getProperty ("offset", 0.0)));
                    clip.gainDb = (double) clipVar.getProperty ("gainDb", 0.0);
                    clip.mute = (bool) clipVar.getProperty ("mute", false);
                    clip.frequencyHz = (double) clipVar.getProperty ("frequencyHz", 0.0);
                    clip.autoTempo = (bool) clipVar.getProperty ("autoTempo", false);
                    clip.sourceBpm = (double) clipVar.getProperty ("sourceBpm", 0.0);
                    clip.stretchMode = clipVar.getProperty ("stretchMode", String()).toString();
                    clip.warpSourceLengthSeconds = (double) clipVar.getProperty ("warpSourceLengthSeconds", 0.0);
                    if (clip.autoTempo && clip.warpSourceLengthSeconds <= 0.0)
                        clip.warpSourceLengthSeconds = clip.lengthSeconds;
                    const auto notes = clipVar.getProperty ("notes", var());
                    if (auto* noteArr = notes.getArray())
                    {
                        for (const auto& noteVar : *noteArr)
                        {
                            SliceState::Clip::Note note;
                            note.pitch = jlimit (0, 127, (int) noteVar.getProperty ("pitch", 60));
                            note.start = jmax (0.0, (double) noteVar.getProperty ("start", 0.0));
                            note.length = jmax (0.0625, (double) noteVar.getProperty ("length", 1.0));
                            note.velocity = jlimit (1, 127, (int) noteVar.getProperty ("velocity", 100));
                            clip.notes.push_back (note);
                        }
                    }
                    track.clips.push_back (clip);
                }
            }

            const auto plugins = trackVar.getProperty ("plugins", var());
            if (auto* pluginArr = plugins.getArray())
            {
                for (const auto& pluginVar : *pluginArr)
                {
                    SliceState::Plugin plugin;
                    plugin.id = pluginVar.getProperty ("id", var()).toString();
                    if (plugin.id.isEmpty())
                        plugin.id = "plugin-" + String ((int) track.plugins.size() + 1);
                    plugin.format = pluginVar.getProperty ("format", "vst3").toString();
                    const auto pluginPath = pluginVar.getProperty ("path", var()).toString();
                    if (pluginPath.isNotEmpty())
                    {
                        plugin.path = pluginPath;
                        state.pluginPath = pluginPath;
                    }
                    else
                    {
                        plugin.path = state.pluginPath;
                    }
                    plugin.name = pluginVar.getProperty ("name", pluginNameFromPath (plugin.path)).toString();
                    plugin.enabled = (bool) pluginVar.getProperty ("enabled", true);
                    plugin.isInstrument = (bool) pluginVar.getProperty ("isInstrument", false);

                    const auto params = pluginVar.getProperty ("params", var());
                    if (auto* paramArr = params.getArray())
                    {
                        for (const auto& paramVar : *paramArr)
                        {
                            SliceState::PluginParam param;
                            param.index = (int) paramVar.getProperty ("index", (int) plugin.params.size());
                            param.name = paramVar.getProperty ("name", "Param " + String (param.index)).toString();
                            param.value = jlimit (0.0, 1.0, (double) paramVar.getProperty ("value", 0.0));
                            auto points = paramVar.getProperty ("points", paramVar.getProperty ("automation", var()));
                            if (auto* pointArr = points.getArray())
                            {
                                for (const auto& pointVar : *pointArr)
                                {
                                    SliceState::PluginParam::AutomationPoint point;
                                    point.time = jmax (0.0, (double) pointVar.getProperty ("time", pointVar.getProperty ("t", 0.0)));
                                    point.value = jlimit (0.0, 1.0, (double) pointVar.getProperty ("value", pointVar.getProperty ("v", 0.0)));
                                    point.curve = (double) pointVar.getProperty ("curve", 0.0);
                                    param.points.push_back (point);
                                }
                                std::sort (param.points.begin(), param.points.end(),
                                           [] (const auto& a, const auto& b) { return a.time < b.time; });
                            }
                            plugin.params.push_back (param);
                        }
                    }

                    track.plugins.push_back (plugin);
                }
            }

            state.tracks.push_back (track);
        }
    }

    const auto buses = graph.getProperty ("buses", var());
    if (auto* busArr = buses.getArray())
    {
        for (const auto& busVar : *busArr)
        {
            SliceState::Bus bus;
            bus.bus = (int) busVar.getProperty ("bus", -1);
            bus.name = busVar.getProperty ("name", var()).toString();
            bus.trackId = busVar.getProperty ("trackId", var()).toString();
            if (bus.bus < 0)
                continue;
            if (bus.name.isEmpty())
                bus.name = "Bus " + String (bus.bus + 1);
            if (bus.trackId.isEmpty())
            {
                for (const auto& track : state.tracks)
                    if (track.isReturn && track.returnBus == bus.bus)
                    {
                        bus.trackId = track.id;
                        break;
                    }
            }
            if (findBus (bus.bus) == nullptr)
                state.buses.push_back (bus);
        }
    }

    for (const auto& track : state.tracks)
        if (track.isReturn && track.returnBus >= 0 && findBus (track.returnBus) == nullptr)
        {
            SliceState::Bus bus;
            bus.bus = track.returnBus;
            bus.name = track.name.isNotEmpty() ? track.name : String ("Bus ") + String (track.returnBus + 1);
            bus.trackId = track.id;
            state.buses.push_back (bus);
        }

    return true;
}

bool MaolanProcessBackend::writeSessionGraphFile (const File& file) const
{
    return file.replaceWithText (JSON::toString (buildSessionGraph(), true) + "\n");
}

var MaolanProcessBackend::operationDiagnostics (const String& commandId,
                                                double timingMs,
                                                const File& stdoutPath,
                                                const File& stderrPath,
                                                Array<var> artifactPaths) const
{
    auto d = makeEngineDiagnostics (backendId(), commandId);
    if (auto* o = d.getDynamicObject())
    {
        if (timingMs > 0.0)
            o->setProperty ("timingMs", timingMs);
        if (stdoutPath.getFullPathName().isNotEmpty())
            o->setProperty ("stdoutPath", stdoutPath.getFullPathName());
        if (stderrPath.getFullPathName().isNotEmpty())
            o->setProperty ("stderrPath", stderrPath.getFullPathName());
        o->setProperty ("artifactPaths", artifactPaths);
        o->setProperty ("artifacts", artifactPaths);
        if (state.outputDir.getFullPathName().isNotEmpty())
            o->setProperty ("outputDir", state.outputDir.getFullPathName());
    }
    return d;
}

void MaolanProcessBackend::appendCommandRecord (const String& operation,
                                                const var& args,
                                                bool ok,
                                                var diagnostics,
                                                var error)
{
    ensureEvidenceDir();
    auto* o = new DynamicObject();
    o->setProperty ("ts", Time::getCurrentTime().toMilliseconds());
    o->setProperty ("seq", ++state.seq);
    o->setProperty ("backend", backendId());
    o->setProperty ("operation", operation);
    o->setProperty ("args", args.isVoid() ? var (new DynamicObject()) : args);
    o->setProperty ("ok", ok);
    o->setProperty ("diagnostics", diagnostics);
    if (! error.isVoid())
        o->setProperty ("error", error);
    state.commandLog.appendText (JSON::toString (var (o), true) + "\n");
}

var MaolanProcessBackend::failOperation (const String& commandId,
                                         const String& code,
                                         const String& message,
                                         const var& args,
                                         var diagnostics)
{
    auto result = makeEngineError (backendId(), commandId, code, message, diagnostics);
    appendCommandRecord (commandId, args, false, diagnostics, result.getProperty ("error", var()));
    return result;
}

var MaolanProcessBackend::finishOperation (const String& commandId,
                                           const var& args,
                                           var data,
                                           var diagnostics)
{
    appendCommandRecord (commandId, args, true, diagnostics);
    return makeEngineResult (backendId(), commandId, data, diagnostics);
}

MaolanProcessBackend::CommandRun MaolanProcessBackend::runShell (const String& commandId,
                                                                 const String& shellBody,
                                                                 const File& stdoutLog,
                                                                 const File& stderrLog,
                                                                 int timeoutSeconds)
{
    CommandRun result;
    result.stdoutLog = stdoutLog;
    result.stderrLog = stderrLog;

    ensureEvidenceDir();
    const auto script = state.outputDir.getChildFile (File::createLegalFileName (commandId + ".sh"));
    writeUtf8File (script, "#!/usr/bin/env bash\nset -euo pipefail\n" + shellBody + "\n");

    const auto launcher = state.outputDir.getChildFile (File::createLegalFileName (commandId + "-launcher.sh"));
    const auto childPidFile = state.outputDir.getChildFile (File::createLegalFileName (commandId + ".pid"));
    childPidFile.deleteFile();

    const auto launcherBody =
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "export MOSH_ENGINE_CHILD_PID_FILE=" + shellQuote (childPidFile.getFullPathName()) + "\n"
        "exec /usr/bin/perl -MPOSIX=setsid -e 'setsid() or die \"setsid failed: $!\\n\"; "
        "open(my $fh, \">\", $ENV{\"MOSH_ENGINE_CHILD_PID_FILE\"}) or die \"pid file failed: $!\\n\"; "
        "print $fh $$ . \"\\n\"; close($fh); exec @ARGV or die \"exec failed: $!\\n\";' "
        "/bin/bash " + shellQuote (script.getFullPathName())
        + " > " + shellQuote (stdoutLog.getFullPathName())
        + " 2> " + shellQuote (stderrLog.getFullPathName()) + "\n";
    writeUtf8File (launcher, launcherBody);

    stdoutLog.replaceWithText ({});
    stderrLog.replaceWithText ({});

    const auto commandLine = "/bin/bash " + launcher.getFullPathName();
    ChildProcess process;
    const auto started = Time::getMillisecondCounterHiRes();

    if (! process.start (commandLine, 0))
    {
        stderrLog.replaceWithText ("Could not start " + commandId + ".\n");
        result.timingMs = Time::getMillisecondCounterHiRes() - started;
        return result;
    }

    int childProcessGroup = 0;
    for (int attempt = 0; attempt < 100 && childProcessGroup <= 0; ++attempt)
    {
        if (childPidFile.existsAsFile())
        {
            childProcessGroup = childPidFile.loadFileAsString().trim().getIntValue();
            if (childProcessGroup > 0)
                break;
        }
        Thread::sleep (10);
    }

    const auto timeoutMs = jlimit (1, 24 * 60 * 60, timeoutSeconds) * 1000;
    while (! process.waitForProcessToFinish (50))
    {
        if ((Time::getMillisecondCounterHiRes() - started) > (double) timeoutMs)
        {
            result.timedOut = true;
            if (childProcessGroup > 0)
                ::kill (-childProcessGroup, SIGTERM);
            process.kill();
            Thread::sleep (250);
            if (childProcessGroup > 0)
                ::kill (-childProcessGroup, SIGKILL);
            process.waitForProcessToFinish (3000);
            break;
        }
    }

    result.timingMs = Time::getMillisecondCounterHiRes() - started;
    result.exitCode = result.timedOut ? -1 : static_cast<int> (process.getExitCode());
    result.ok = ! result.timedOut && result.exitCode == 0;

    if (result.timedOut)
        stderrLog.appendText ("Timed out running " + commandId + ".\n");
    return result;
}

var MaolanProcessBackend::diagnostics() const
{
    auto d = makeEngineDiagnostics (backendId(), "diagnostics");
    if (auto* o = d.getDynamicObject())
    {
        const auto envFile = maolanEnvFile();
        const auto plugin = fixturePlugin();
        const auto script = contractScript();
        const auto harness = maolanMoshDir().getChildFile ("scripts").getChildFile ("mosh-maolan-integration-check.sh");

        o->setProperty ("displayName", displayName());
        o->setProperty ("mode", "process");
        o->setProperty ("repoRoot", context.repoRoot.getFullPathName());
        o->setProperty ("sessionDir", context.sessionDir.getFullPathName());
        o->setProperty ("envFile", envFile.getFullPathName());
        o->setProperty ("envFileExists", envFile.existsAsFile());
        o->setProperty ("maolanMoshDir", maolanMoshDir().getFullPathName());
        o->setProperty ("maolanMoshDirExists", maolanMoshDir().isDirectory());
        o->setProperty ("integrationCheck", harness.getFullPathName());
        o->setProperty ("integrationCheckExists", harness.existsAsFile());
        o->setProperty ("script", script.getFullPathName());
        o->setProperty ("scriptExists", script.existsAsFile());
        o->setProperty ("supportedDevice", "coreaudio:default");
        o->setProperty ("fixturePlugin", plugin.getFullPathName());
        o->setProperty ("fixturePluginExists", plugin.exists());
        o->setProperty ("outputDir", state.outputDir.getFullPathName());
        o->setProperty ("capabilities", capabilities());
    }
    return d;
}

var MaolanProcessBackend::createSession (const var& args)
{
    auto outputDir = defaultEvidenceDir();
    const auto requestedOutputDir = args.getProperty ("outputDir", var()).toString();
    if (requestedOutputDir.isNotEmpty())
        outputDir = File (requestedOutputDir);

    configureEvidenceDir (outputDir);
    state.sessionId = args.getProperty ("sessionId", state.sessionId).toString();
    if (state.sessionId.isEmpty())
        state.sessionId = "mosh-maolan-contract-slice";

    if (! writeSessionGraphFile (state.sessionGraph))
    {
        auto d = operationDiagnostics ("createSession", 0.0, {}, {}, paths ({ state.sessionGraph }));
        return failOperation ("createSession", "artifact_write_failed",
                              "Could not write session graph: " + state.sessionGraph.getFullPathName(), args, d);
    }

    auto d = operationDiagnostics ("createSession", 0.0, {}, {}, paths ({ state.sessionGraph }));
    return finishOperation ("createSession", args, objectWith ({
        { "sessionId", state.sessionId },
        { "outputDir", state.outputDir.getFullPathName() },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::openSession (const var& args)
{
    ensureEvidenceDir();
    const auto file = File (args.getProperty ("file", state.sessionGraph.getFullPathName()).toString());
    auto d = operationDiagnostics ("openSession", 0.0, {}, {},
                                  paths ({ file, state.sessionGraph, state.persistenceMaolanSessionJson }));

    if (! file.existsAsFile())
        return failOperation ("openSession", "missing_artifact",
                              "Session graph not found: " + file.getFullPathName(), args, d);

    auto parsed = JSON::parse (file.loadFileAsString());
    if (parsed.isVoid() || ! parsed.isObject())
        return failOperation ("openSession", "invalid_session_graph",
                              "Session graph is not valid JSON: " + file.getFullPathName(), args, d);

    applySessionGraph (parsed);
    if (! writeSessionGraphFile (state.sessionGraph))
        return failOperation ("openSession", "artifact_write_failed",
                              "Could not write opened session graph: " + state.sessionGraph.getFullPathName(), args, d);

    String sessionError;
    if (! writeMaolanSessionFolderTo (state.persistenceMaolanSessionDir,
                                      state.persistenceMaolanSessionAudioDir,
                                      state.persistenceMaolanSessionJson,
                                      sessionError))
        return failOperation ("openSession", "artifact_write_failed", sessionError, args, d);

    return finishOperation ("openSession", args, objectWith ({
        { "sessionId", state.sessionId },
        { "file", file.getFullPathName() },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
        { "maolanSessionDir", state.persistenceMaolanSessionDir.getFullPathName() },
        { "maolanSessionJson", state.persistenceMaolanSessionJson.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::selectAudioDevice (const var& args)
{
    ensureEvidenceDir();
    const auto requested = args.getProperty ("device", "coreaudio:default").toString();
    auto d = operationDiagnostics ("selectAudioDevice", 0.0, {}, {}, {});

    if (requested != "coreaudio:default")
        return failOperation ("selectAudioDevice", "unsupported_by_backend",
                              "Maolan process backend only supports coreaudio:default in this phase.", args, d);

    state.device = requested;
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("selectAudioDevice", args, objectWith ({
        { "device", state.device },
    }), d);
}

var MaolanProcessBackend::ensureSmokeRan (const var& args)
{
    ensureEvidenceDir();
    if (state.smokeRan)
        return makeEngineResult (backendId(), "scanPlugins", objectWith ({
            { "timingCsv", state.timingCsv.getFullPathName() },
            { "smokeDir", state.smokeDir.getFullPathName() },
        }), operationDiagnostics ("scanPlugins", 0.0, state.maolanStdout, state.maolanStderr,
                                  paths ({ state.timingCsv })));

    const auto envFile = maolanEnvFile();
    const auto harness = maolanMoshDir().getChildFile ("scripts").getChildFile ("mosh-maolan-integration-check.sh");
    auto d = operationDiagnostics ("scanPlugins", 0.0, state.maolanStdout, state.maolanStderr,
                                  paths ({ state.timingCsv }));

    if (! envFile.existsAsFile())
        return failOperation ("scanPlugins", "backend_unavailable",
                              "Missing Maolan private env file: " + envFile.getFullPathName(), args, d);
    if (! harness.existsAsFile())
        return failOperation ("scanPlugins", "backend_unavailable",
                              "Missing MaolanMosh integration check: " + harness.getFullPathName(), args, d);
    if (! fixturePlugin().exists())
        return failOperation ("scanPlugins", "missing_fixture",
                              "JamPilotTestGain.vst3 not found: " + fixturePlugin().getFullPathName(), args, d);

    const auto smokeCommand =
        "MOSH_MAOLAN_SMOKE_MAX_P95_WALL_S=\"${MOSH_MAOLAN_SMOKE_MAX_P95_WALL_S:-1.500}\""
        + String (" MOSH_MAOLAN_SMOKE_MAX_P95_LOAD_MS=\"${MOSH_MAOLAN_SMOKE_MAX_P95_LOAD_MS:-200}\"")
        + " MOSH_MAOLAN_EVIDENCE_DIR=" + shellQuote (state.smokeDir.getFullPathName())
        + " " + shellQuote (harness.getFullPathName());
    const auto shellBody =
        "set -a && source " + shellQuote (envFile.getFullPathName()) + " && set +a"
        + " && : \"${MAOLAN_APP_DIR:?MAOLAN_APP_DIR is required}\""
        + " && " + maolanLockedShellCommand (smokeCommand);
    const auto smokeCsv = state.smokeDir.getChildFile ("maolan-test-vst3-smoke.csv");
    const auto smokeSummary = state.smokeDir.getChildFile ("summary.json");
    auto artifactBackedPass = [&]
    {
        const auto smokeSummaryJson = smokeSummary.existsAsFile() ? JSON::parse (smokeSummary.loadFileAsString()) : var();
        return smokeCsv.existsAsFile()
               && smokeSummaryJson.getProperty ("status", var()).toString() == "PASS";
    };

    auto run = runShell ("scanPlugins", shellBody, state.maolanStdout, state.maolanStderr,
                         std::max (30, (int) args.getProperty ("timeoutSeconds", 900)));
    if (! run.ok && ! artifactBackedPass())
        run = runShell ("scanPlugins", shellBody, state.maolanStdout, state.maolanStderr,
                        std::max (30, (int) args.getProperty ("timeoutSeconds", 900)));

    d = operationDiagnostics ("scanPlugins", run.timingMs, state.maolanStdout, state.maolanStderr,
                             paths ({ state.timingCsv }));

    if (! run.ok && ! artifactBackedPass())
        return failOperation ("scanPlugins", run.timedOut ? "process_timeout" : "process_failed",
                              "Maolan VST3 smoke check failed with exit code " + String (run.exitCode) + ".", args, d);

    if (! smokeCsv.existsAsFile() || ! smokeCsv.copyFileTo (state.timingCsv))
        return failOperation ("scanPlugins", "missing_artifact",
                              "Maolan smoke check did not produce a timing CSV.", args, d);

    state.smokeRan = true;
    return makeEngineResult (backendId(), "scanPlugins", objectWith ({
        { "format", "vst3" },
        { "count", 1 },
        { "timingCsv", state.timingCsv.getFullPathName() },
        { "smokeDir", state.smokeDir.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::scanPlugins (const var& args)
{
    Array<var> plugins;
    var d;
    if (isPluginBlocked ("jampilot-test-gain-vst3", state.pluginPath))
    {
        ensureEvidenceDir();
        d = operationDiagnostics ("scanPlugins", 0.0, {}, {}, paths ({ state.sessionGraph }));
    }
    else
    {
        auto smoke = ensureSmokeRan (args);
        if (! (bool) smoke.getProperty ("ok", false))
            return smoke;

        d = smoke.getProperty ("diagnostics", var());
        plugins.add (objectWith ({
            { "id", "jampilot-test-gain-vst3" },
            { "format", "vst3" },
            { "path", state.pluginPath },
            { "name", pluginNameFromPath (state.pluginPath) },
        }));
    }

    return finishOperation ("scanPlugins", args, objectWith ({
        { "plugins", plugins },
        { "count", plugins.size() },
        { "timingCsv", state.timingCsv.getFullPathName() },
        { "blocklist", pluginBlocklistData().getProperty ("blocklist", Array<var>()) },
    }), d);
}

var MaolanProcessBackend::getPluginBlocklist (const var& args)
{
    ensureEvidenceDir();
    (void) args;
    return finishOperation ("getPluginBlocklist", args, pluginBlocklistData(),
                            operationDiagnostics ("getPluginBlocklist", 0.0, {}, {}, paths ({ state.sessionGraph })));
}

var MaolanProcessBackend::clearPluginBlocklist (const var& args)
{
    ensureEvidenceDir();
    state.pluginBlocklist.clear();
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("clearPluginBlocklist", args, pluginBlocklistData(),
                            operationDiagnostics ("clearPluginBlocklist", 0.0, {}, {}, paths ({ state.sessionGraph })));
}

var MaolanProcessBackend::blockPlugin (const var& args)
{
    ensureEvidenceDir();
    auto d = operationDiagnostics ("blockPlugin", 0.0, {}, {}, paths ({ state.sessionGraph }));
    auto pluginId = args.getProperty ("pluginId", var()).toString();
    if (pluginId.isEmpty())
        pluginId = args.getProperty ("id", var()).toString();
    if (pluginId.isEmpty())
        return failOperation ("blockPlugin", "invalid_argument", "Missing pluginId.", args, d);

    const auto fixturePath = state.pluginPath.isNotEmpty() ? state.pluginPath : fixturePlugin().getFullPathName();
    const bool matchesFixture = pluginId == "jampilot-test-gain-vst3"
                                || pluginId == fixturePath
                                || pluginId == File (fixturePath).getFileName()
                                || pluginId.contains ("JamPilotTestGain.vst3");
    if (! matchesFixture)
        return failOperation ("blockPlugin", "not_found",
                              "Plugin not found in Maolan process catalog: " + pluginId, args, d);

    const String blockKey = pluginId.contains ("JamPilotTestGain.vst3") ? fixturePath : String ("jampilot-test-gain-vst3");
    if (std::find (state.pluginBlocklist.begin(), state.pluginBlocklist.end(), blockKey) == state.pluginBlocklist.end())
        state.pluginBlocklist.push_back (blockKey);

    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("blockPlugin", args, pluginBlocklistData(), d);
}

var MaolanProcessBackend::createTrack (const var& args)
{
    ensureEvidenceDir();
    SliceState::Track track;
    track.id = args.getProperty ("trackId", var()).toString();
    if (track.id.isEmpty())
        track.id = nextTrackId();
    if (findTrack (track.id) != nullptr)
    {
        auto d = operationDiagnostics ("createTrack", 0.0, {}, {}, paths ({ state.sessionGraph }));
        return failOperation ("createTrack", "invalid_argument",
                              "Track already exists: " + track.id, args, d);
    }

    track.name = args.getProperty ("name", var()).toString();
    if (track.name.isEmpty())
        track.name = "Maolan Track " + String ((int) state.tracks.size() + 1);
    track.type = args.getProperty ("type", "audio").toString();
    if (track.type.isEmpty())
        track.type = "audio";
    state.tracks.push_back (track);

    writeSessionGraphFile (state.sessionGraph);
    auto d = operationDiagnostics ("createTrack", 0.0, {}, {}, paths ({ state.sessionGraph }));
    return finishOperation ("createTrack", args, objectWith ({
        { "trackId", track.id },
        { "name", track.name },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::renameTrack (const var& args)
{
    ensureEvidenceDir();
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto d = operationDiagnostics ("renameTrack", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (trackId.isEmpty())
        return failOperation ("renameTrack", "invalid_argument",
                              "Missing trackId.", args, d);

    auto* track = findTrack (trackId);
    if (track == nullptr)
        return failOperation ("renameTrack", "not_found",
                              "Track not found: " + trackId, args, d);

    auto name = args.getProperty ("name", var()).toString();
    if (name.isEmpty())
        name = "Untitled Track";
    track->name = name;
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("renameTrack", args, objectWith ({
        { "trackId", track->id },
        { "name", track->name },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::removeTrack (const var& args)
{
    ensureEvidenceDir();
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto d = operationDiagnostics ("removeTrack", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (trackId.isEmpty())
        return failOperation ("removeTrack", "invalid_argument",
                              "Missing trackId.", args, d);

    for (auto it = state.tracks.begin(); it != state.tracks.end(); ++it)
    {
        if (it->id == trackId)
        {
            const bool removedGroup = it->isGroup;
            state.tracks.erase (it);
            for (auto& track : state.tracks)
            {
                if (removedGroup && track.parentId == trackId)
                    track.parentId = {};
                if (track.outputKind == "track" && track.outputDestTrackId == trackId)
                {
                    track.outputKind = {};
                    track.outputDestTrackId = {};
                }
            }
            writeSessionGraphFile (state.sessionGraph);
            return finishOperation ("removeTrack", args, objectWith ({
                { "trackId", trackId },
                { "sessionGraph", state.sessionGraph.getFullPathName() },
            }), d);
        }
    }

    return failOperation ("removeTrack", "not_found",
                          "Track not found: " + trackId, args, d);
}

var MaolanProcessBackend::addClip (const var& args)
{
    ensureEvidenceDir();
    auto d = operationDiagnostics ("addClip", 0.0, {}, {}, paths ({ state.sessionGraph, state.clipsDir }));

    auto trackId = args.getProperty ("trackId", var()).toString();
    auto* track = trackId.isNotEmpty() ? findTrack (trackId) : firstTrack();
    if (track == nullptr)
        return failOperation ("addClip", "invalid_session_graph",
                              "Cannot add a clip before createTrack.", args, d);
    trackId = track->id;

    SliceState::Clip clip;
    clip.id = args.getProperty ("clipId", var()).toString();
    if (clip.id.isEmpty())
        clip.id = nextClipId();
    if (findClip (clip.id) != nullptr)
        return failOperation ("addClip", "invalid_argument",
                              "Clip already exists: " + clip.id, args, d);

    clip.sourceKind = args.getProperty ("sourceKind", args.getProperty ("type", "file")).toString();
    if (clip.sourceKind == "test_tone")
        clip.sourceKind = "test-tone";

    clip.name = args.getProperty ("name", var()).toString();
    if (clip.name.isEmpty())
        clip.name = clip.sourceKind == "test-tone" ? "Maolan Tone" : "Maolan Clip";
    clip.type = args.getProperty ("clipType", "wave").toString();
    clip.startSeconds = jmax (0.0, (double) args.getProperty ("startSeconds", args.getProperty ("start", 0.0)));
    clip.offsetSeconds = jmax (0.0, (double) args.getProperty ("offsetSeconds", args.getProperty ("offset", 0.0)));
    clip.gainDb = (double) args.getProperty ("gainDb", 0.0);
    clip.mute = (bool) args.getProperty ("mute", false);

    if (clip.sourceKind == "test-tone")
    {
        clip.frequencyHz = (double) args.getProperty ("frequencyHz", args.getProperty ("freq", 220.0));
        clip.lengthSeconds = jlimit (0.01, 60.0, (double) args.getProperty ("lengthSeconds", args.getProperty ("seconds", 2.0)));
        const auto file = state.clipsDir.getChildFile (File::createLegalFileName (clip.id + "-" + clip.name + ".wav"));
        if (! writeToneClipFile (file, clip.lengthSeconds, clip.frequencyHz))
            return failOperation ("addClip", "artifact_write_failed",
                                  "Could not write test-tone clip: " + file.getFullPathName(), args, d);
        clip.sourcePath = file.getFullPathName();
        d = operationDiagnostics ("addClip", 0.0, {}, {}, paths ({ state.sessionGraph, file }));
    }
    else
    {
        const auto filePath = args.getProperty ("file", args.getProperty ("sourcePath", var())).toString();
        if (filePath.isEmpty())
            return failOperation ("addClip", "invalid_argument",
                                  "Missing clip source file.", args, d);

        const File file (filePath);
        if (! file.existsAsFile())
            return failOperation ("addClip", "missing_artifact",
                                  "Clip source file not found: " + file.getFullPathName(), args, d);

        const auto length = audioFileLengthSeconds (file);
        if (length <= 0.0)
            return failOperation ("addClip", "invalid_argument",
                                  "Clip source is not a supported audio file: " + file.getFullPathName(), args, d);

        clip.sourceKind = "file";
        clip.sourcePath = file.getFullPathName();
        clip.lengthSeconds = jmax (0.01, (double) args.getProperty ("lengthSeconds", args.getProperty ("length", length)));
        if (clip.name == "Maolan Clip")
            clip.name = file.getFileNameWithoutExtension();
        d = operationDiagnostics ("addClip", 0.0, {}, {}, paths ({ state.sessionGraph, file }));
    }

    clip.warpSourceLengthSeconds = clip.lengthSeconds;
    track->clips.push_back (clip);
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("addClip", args, clipResultData (*track, track->clips.back()), d);
}

var MaolanProcessBackend::moveClip (const var& args)
{
    ensureEvidenceDir();
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto d = operationDiagnostics ("moveClip", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (clipId.isEmpty())
        return failOperation ("moveClip", "invalid_argument", "Missing clipId.", args, d);

    SliceState::Track* owner = nullptr;
    auto* clip = findClip (clipId, &owner);
    if (clip == nullptr || owner == nullptr)
        return failOperation ("moveClip", "not_found", "Clip not found: " + clipId, args, d);

    clip->startSeconds = jmax (0.0, (double) args.getProperty ("start", args.getProperty ("startSeconds", clip->startSeconds)));

    const auto destTrackId = args.getProperty ("trackId", var()).toString();
    if (destTrackId.isNotEmpty() && destTrackId != owner->id)
    {
        auto* dest = findTrack (destTrackId);
        if (dest == nullptr)
            return failOperation ("moveClip", "not_found", "Destination track not found: " + destTrackId, args, d);

        auto moved = *clip;
        auto& sourceClips = owner->clips;
        sourceClips.erase (std::remove_if (sourceClips.begin(), sourceClips.end(),
                                           [&clipId] (const SliceState::Clip& c) { return c.id == clipId; }),
                           sourceClips.end());
        dest->clips.push_back (moved);
        owner = dest;
        clip = &owner->clips.back();
    }

    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("moveClip", args, clipResultData (*owner, *clip), d);
}

var MaolanProcessBackend::trimClip (const var& args)
{
    ensureEvidenceDir();
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto d = operationDiagnostics ("trimClip", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (clipId.isEmpty())
        return failOperation ("trimClip", "invalid_argument", "Missing clipId.", args, d);

    SliceState::Track* owner = nullptr;
    auto* clip = findClip (clipId, &owner);
    if (clip == nullptr || owner == nullptr)
        return failOperation ("trimClip", "not_found", "Clip not found: " + clipId, args, d);

    clip->startSeconds = jmax (0.0, (double) args.getProperty ("start", args.getProperty ("startSeconds", clip->startSeconds)));
    clip->lengthSeconds = jmax (0.01, (double) args.getProperty ("length", args.getProperty ("lengthSeconds", clip->lengthSeconds)));
    clip->offsetSeconds = jmax (0.0, (double) args.getProperty ("offset", args.getProperty ("offsetSeconds", clip->offsetSeconds)));
    if (! clip->autoTempo)
        clip->warpSourceLengthSeconds = clip->lengthSeconds;

    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("trimClip", args, clipResultData (*owner, *clip), d);
}

var MaolanProcessBackend::splitClip (const var& args)
{
    ensureEvidenceDir();
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto d = operationDiagnostics ("splitClip", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (clipId.isEmpty())
        return failOperation ("splitClip", "invalid_argument", "Missing clipId.", args, d);

    SliceState::Track* owner = nullptr;
    auto* clip = findClip (clipId, &owner);
    if (clip == nullptr || owner == nullptr)
        return failOperation ("splitClip", "not_found", "Clip not found: " + clipId, args, d);
    if (clip->type != "wave")
        return failOperation ("splitClip", "unsupported_by_backend",
                              "The Maolan process slice only supports splitting wave clips.", args, d);

    const auto splitTime = (double) args.getProperty ("time", args.getProperty ("at", var()));
    const auto clipStart = clip->startSeconds;
    const auto clipEnd = clip->startSeconds + clip->lengthSeconds;
    constexpr double minSegmentSeconds = 0.01;
    if (splitTime <= clipStart + minSegmentSeconds || splitTime >= clipEnd - minSegmentSeconds)
        return failOperation ("splitClip", "invalid_argument",
                              "Split time must be inside the clip bounds.", args, d);

    auto right = *clip;
    right.id = args.getProperty ("newClipId", var()).toString();
    if (right.id.isEmpty())
        right.id = nextClipId();
    if (findClip (right.id) != nullptr)
        return failOperation ("splitClip", "invalid_argument",
                              "Clip already exists: " + right.id, args, d);

    const auto leftLength = splitTime - clipStart;
    const auto rightLength = clipEnd - splitTime;
    right.startSeconds = splitTime;
    right.lengthSeconds = rightLength;
    right.offsetSeconds = clip->offsetSeconds + leftLength;
    right.warpSourceLengthSeconds = rightLength;
    clip->lengthSeconds = leftLength;
    clip->warpSourceLengthSeconds = leftLength;

    const auto insertPos = std::find_if (owner->clips.begin(), owner->clips.end(),
                                         [&clipId] (const SliceState::Clip& existing)
                                         {
                                             return existing.id == clipId;
                                         });
    if (insertPos == owner->clips.end())
        return failOperation ("splitClip", "not_found", "Clip not found: " + clipId, args, d);

    const auto inserted = owner->clips.insert (insertPos + 1, right);
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("splitClip", args, objectWith ({
        { "trackId", owner->id },
        { "clipId", clipId },
        { "newClipId", inserted->id },
        { "leftClipId", clipId },
        { "rightClipId", inserted->id },
        { "splitTime", splitTime },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::duplicateClip (const var& args)
{
    ensureEvidenceDir();
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto d = operationDiagnostics ("duplicateClip", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (clipId.isEmpty())
        return failOperation ("duplicateClip", "invalid_argument", "Missing clipId.", args, d);

    SliceState::Track* owner = nullptr;
    auto* clip = findClip (clipId, &owner);
    if (clip == nullptr || owner == nullptr)
        return failOperation ("duplicateClip", "not_found", "Clip not found: " + clipId, args, d);
    if (clip->type != "wave")
        return failOperation ("duplicateClip", "unsupported_by_backend",
                              "The Maolan process slice only supports duplicating wave clips.", args, d);

    SliceState::Track* destination = owner;
    const auto destTrackId = args.getProperty ("trackId", var()).toString();
    if (destTrackId.isNotEmpty() && destTrackId != owner->id)
    {
        destination = findTrack (destTrackId);
        if (destination == nullptr)
            return failOperation ("duplicateClip", "not_found",
                                  "Destination track not found: " + destTrackId, args, d);
    }

    auto duplicate = *clip;
    duplicate.id = args.getProperty ("newClipId", var()).toString();
    if (duplicate.id.isEmpty())
        duplicate.id = nextClipId();
    if (findClip (duplicate.id) != nullptr)
        return failOperation ("duplicateClip", "invalid_argument",
                              "Clip already exists: " + duplicate.id, args, d);

    if (args.hasProperty ("name"))
        duplicate.name = args.getProperty ("name", duplicate.name).toString();

    duplicate.startSeconds = (double) args.getProperty (
        "start",
        args.getProperty ("startSeconds", clip->startSeconds + clip->lengthSeconds));

    const auto sourceFile = File (duplicate.sourcePath);
    d = operationDiagnostics ("duplicateClip", 0.0, {}, {}, paths ({ state.sessionGraph, sourceFile }));

    SliceState::Clip* inserted = nullptr;
    if (destination == owner)
    {
        const auto insertPos = std::find_if (owner->clips.begin(), owner->clips.end(),
                                             [&clipId] (const SliceState::Clip& existing)
                                             {
                                                 return existing.id == clipId;
                                             });
        if (insertPos == owner->clips.end())
            return failOperation ("duplicateClip", "not_found", "Clip not found: " + clipId, args, d);

        inserted = &*owner->clips.insert (insertPos + 1, duplicate);
    }
    else
    {
        destination->clips.push_back (duplicate);
        inserted = &destination->clips.back();
    }

    writeSessionGraphFile (state.sessionGraph);
    auto data = clipResultData (*destination, *inserted);
    if (auto* o = data.getDynamicObject())
    {
        o->setProperty ("newClipId", inserted->id);
        o->setProperty ("sourceClipId", clipId);
        o->setProperty ("originalClipId", clipId);
    }
    return finishOperation ("duplicateClip", args, data, d);
}

var MaolanProcessBackend::pasteClip (const var& args)
{
    ensureEvidenceDir();
    auto d = operationDiagnostics ("pasteClip", 0.0, {}, {}, paths ({ state.sessionGraph }));

    const auto trackId = args.getProperty ("trackId", var()).toString();
    if (trackId.isEmpty())
        return failOperation ("pasteClip", "invalid_argument", "Missing trackId.", args, d);

    auto* destination = findTrack (trackId);
    if (destination == nullptr)
        return failOperation ("pasteClip", "not_found", "Track not found: " + trackId, args, d);

    const auto clipVar = args.getProperty ("clip", var());
    if (! clipVar.isObject())
        return failOperation ("pasteClip", "invalid_argument", "Missing clip descriptor.", args, d);

    auto type = clipVar.getProperty ("type", "wave").toString();
    if (type.isEmpty())
        type = "wave";
    if (type != "wave")
        return failOperation ("pasteClip", "unsupported_by_backend",
                              "The Maolan process slice only supports pasting wave clips.", args, d);

    SliceState::Clip pasted;
    pasted.id = args.getProperty ("newClipId", clipVar.getProperty ("id", var())).toString();
    if (pasted.id.isEmpty())
        pasted.id = nextClipId();
    if (findClip (pasted.id) != nullptr)
        return failOperation ("pasteClip", "invalid_argument",
                              "Clip already exists: " + pasted.id, args, d);

    pasted.type = "wave";
    pasted.sourceKind = clipVar.getProperty ("sourceKind", "file").toString();
    pasted.sourcePath = clipVar.getProperty ("sourcePath", clipVar.getProperty ("sourceFile", clipVar.getProperty ("file", var()))).toString();
    if (pasted.sourcePath.isEmpty())
        return failOperation ("pasteClip", "invalid_argument", "Wave clip descriptor is missing sourcePath/sourceFile.", args, d);

    const File sourceFile (pasted.sourcePath);
    d = operationDiagnostics ("pasteClip", 0.0, {}, {}, paths ({ state.sessionGraph, sourceFile }));
    if (! sourceFile.existsAsFile())
        return failOperation ("pasteClip", "not_found", "Clip source file not found: " + pasted.sourcePath, args, d);

    pasted.name = args.getProperty ("name", clipVar.getProperty ("name", "Maolan Pasted Clip")).toString();
    if (pasted.name.isEmpty())
        pasted.name = "Maolan Pasted Clip";
    pasted.startSeconds = jmax (0.0, (double) args.getProperty ("start", args.getProperty ("startSeconds", 0.0)));
    pasted.lengthSeconds = jmax (0.0, (double) clipVar.getProperty ("lengthSeconds", clipVar.getProperty ("length", audioFileLengthSeconds (sourceFile))));
    pasted.offsetSeconds = jmax (0.0, (double) clipVar.getProperty ("offsetSeconds", clipVar.getProperty ("offset", 0.0)));
    pasted.gainDb = (double) clipVar.getProperty ("gainDb", 0.0);
    pasted.mute = (bool) clipVar.getProperty ("mute", false);
    pasted.frequencyHz = (double) clipVar.getProperty ("frequencyHz", 0.0);
    pasted.autoTempo = (bool) clipVar.getProperty ("autoTempo", false);
    pasted.sourceBpm = (double) clipVar.getProperty ("sourceBpm", 0.0);
    pasted.stretchMode = clipVar.getProperty ("stretchMode", String()).toString();
    pasted.warpSourceLengthSeconds = jmax (0.01, (double) clipVar.getProperty ("warpSourceLengthSeconds", pasted.lengthSeconds));

    destination->clips.push_back (pasted);
    auto& inserted = destination->clips.back();

    writeSessionGraphFile (state.sessionGraph);
    auto data = clipResultData (*destination, inserted);
    if (auto* o = data.getDynamicObject())
    {
        o->setProperty ("newClipId", inserted.id);
        o->setProperty ("sourceClipId", clipVar.getProperty ("id", var()));
        o->setProperty ("originalClipId", clipVar.getProperty ("id", var()));
    }
    return finishOperation ("pasteClip", args, data, d);
}

var MaolanProcessBackend::deleteTimeRange (const var& args)
{
    ensureEvidenceDir();
    auto d = operationDiagnostics ("deleteTimeRange", 0.0, {}, {}, paths ({ state.sessionGraph }));

    const auto start = jmax (0.0, (double) args.getProperty ("start", 0.0));
    const auto end = jmax (0.0, (double) args.getProperty ("end", 0.0));
    if (! (start < end))
        return failOperation ("deleteTimeRange", "invalid_argument", "start must be less than end.", args, d);

    std::vector<SliceState::Track*> targets;
    const auto trackIds = args.getProperty ("trackIds", var());
    if (auto* ids = trackIds.getArray())
    {
        for (const auto& idVar : *ids)
            if (auto* track = findTrack (idVar.toString()))
                if (std::find (targets.begin(), targets.end(), track) == targets.end())
                    targets.push_back (track);
    }
    else
    {
        for (auto& track : state.tracks)
            targets.push_back (&track);
    }

    StringArray usedIds;
    for (const auto& track : state.tracks)
        for (const auto& clip : track.clips)
            usedIds.addIfNotAlreadyThere (clip.id);

    auto nextFragmentId = [&usedIds] (const String& base)
    {
        auto candidateBase = base.isNotEmpty() ? base + "-after-delete" : String ("clip-after-delete");
        auto candidate = candidateBase;
        for (int suffix = 2; usedIds.contains (candidate); ++suffix)
            candidate = candidateBase + "-" + String (suffix);
        usedIds.add (candidate);
        return candidate;
    };

    int removed = 0;
    int splits = 0;
    constexpr double epsilon = 0.000001;

    for (auto* track : targets)
    {
        if (track == nullptr)
            continue;

        std::vector<SliceState::Clip> updated;
        updated.reserve (track->clips.size());

        for (const auto& clip : track->clips)
        {
            const auto clipStart = clip.startSeconds;
            const auto clipEnd = clip.startSeconds + clip.lengthSeconds;

            if (clipEnd <= start + epsilon || clipStart >= end - epsilon)
            {
                updated.push_back (clip);
                continue;
            }

            if (clip.type != "wave")
                return failOperation ("deleteTimeRange", "unsupported_by_backend",
                                      "The Maolan process slice only supports deleting time ranges across wave clips.", args, d);

            const bool keepLeft = clipStart < start - epsilon;
            const bool keepRight = clipEnd > end + epsilon;

            if (keepLeft)
            {
                auto left = clip;
                left.lengthSeconds = jmax (0.0, start - clipStart);
                updated.push_back (left);
                ++splits;
            }

            ++removed;

            if (keepRight)
            {
                auto right = clip;
                right.id = keepLeft ? nextFragmentId (clip.id) : clip.id;
                right.startSeconds = end;
                right.lengthSeconds = jmax (0.0, clipEnd - end);
                right.offsetSeconds = clip.offsetSeconds + jmax (0.0, end - clipStart);
                updated.push_back (right);
                ++splits;
            }
        }

        track->clips = std::move (updated);
    }

    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("deleteTimeRange", args, objectWith ({
        { "removed", removed },
        { "splits", splits },
        { "tracks", (int) targets.size() },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::renameClip (const var& args)
{
    ensureEvidenceDir();
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto d = operationDiagnostics ("renameClip", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (clipId.isEmpty())
        return failOperation ("renameClip", "invalid_argument", "Missing clipId.", args, d);

    SliceState::Track* owner = nullptr;
    auto* clip = findClip (clipId, &owner);
    if (clip == nullptr || owner == nullptr)
        return failOperation ("renameClip", "not_found", "Clip not found: " + clipId, args, d);

    auto name = args.getProperty ("name", var()).toString();
    if (name.isEmpty())
        name = "Untitled Clip";
    clip->name = name;

    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("renameClip", args, clipResultData (*owner, *clip), d);
}

var MaolanProcessBackend::removeClip (const var& args)
{
    ensureEvidenceDir();
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto d = operationDiagnostics ("removeClip", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (clipId.isEmpty())
        return failOperation ("removeClip", "invalid_argument", "Missing clipId.", args, d);

    for (auto& track : state.tracks)
    {
        const auto before = track.clips.size();
        track.clips.erase (std::remove_if (track.clips.begin(), track.clips.end(),
                                           [&clipId] (const SliceState::Clip& c) { return c.id == clipId; }),
                           track.clips.end());
        if (track.clips.size() != before)
        {
            writeSessionGraphFile (state.sessionGraph);
            return finishOperation ("removeClip", args, objectWith ({
                { "clipId", clipId },
                { "trackId", track.id },
                { "sessionGraph", state.sessionGraph.getFullPathName() },
            }), d);
        }
    }

    return failOperation ("removeClip", "not_found", "Clip not found: " + clipId, args, d);
}

var MaolanProcessBackend::setClipMute (const var& args)
{
    ensureEvidenceDir();
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto d = operationDiagnostics ("setClipMute", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (clipId.isEmpty())
        return failOperation ("setClipMute", "invalid_argument", "Missing clipId.", args, d);

    SliceState::Track* owner = nullptr;
    auto* clip = findClip (clipId, &owner);
    if (clip == nullptr || owner == nullptr)
        return failOperation ("setClipMute", "not_found", "Clip not found: " + clipId, args, d);

    clip->mute = (bool) args.getProperty ("mute", args.getProperty ("muted", false));
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("setClipMute", args, clipResultData (*owner, *clip), d);
}

var MaolanProcessBackend::setClipGain (const var& args)
{
    ensureEvidenceDir();
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto d = operationDiagnostics ("setClipGain", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (clipId.isEmpty())
        return failOperation ("setClipGain", "invalid_argument", "Missing clipId.", args, d);

    SliceState::Track* owner = nullptr;
    auto* clip = findClip (clipId, &owner);
    if (clip == nullptr || owner == nullptr)
        return failOperation ("setClipGain", "not_found", "Clip not found: " + clipId, args, d);

    clip->gainDb = (double) args.getProperty ("gainDb", args.getProperty ("gain", 0.0));
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("setClipGain", args, clipResultData (*owner, *clip), d);
}

var MaolanProcessBackend::setClipWarp (const var& args)
{
    ensureEvidenceDir();
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto d = operationDiagnostics ("setClipWarp", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (clipId.isEmpty())
        return failOperation ("setClipWarp", "invalid_argument", "Missing clipId.", args, d);
    if (! args.hasProperty ("autoTempo"))
        return failOperation ("setClipWarp", "invalid_argument", "Missing autoTempo.", args, d);

    SliceState::Track* owner = nullptr;
    auto* clip = findClip (clipId, &owner);
    if (clip == nullptr || owner == nullptr)
        return failOperation ("setClipWarp", "not_found", "Clip not found: " + clipId, args, d);
    if (clip->type != "wave")
        return failOperation ("setClipWarp", "unsupported_by_backend",
                              "The Maolan process slice only supports warp metadata for wave clips.", args, d);

    const bool on = (bool) args.getProperty ("autoTempo", false);
    if (on)
    {
        if (clip->warpSourceLengthSeconds <= 0.0 || ! clip->autoTempo)
            clip->warpSourceLengthSeconds = jmax (0.01, clip->lengthSeconds);
        clip->sourceBpm = jlimit (20.0, 999.0, (double) args.getProperty ("sourceBpm", bpmAtSeconds (clip->startSeconds)));
        clip->stretchMode = args.getProperty ("mode", args.getProperty ("stretchMode", "SoundTouch")).toString();
        if (clip->stretchMode.isEmpty())
            clip->stretchMode = "SoundTouch";
        clip->autoTempo = true;
        clip->lengthSeconds = warpedLengthSeconds (*clip);
    }
    else
    {
        if (clip->autoTempo && clip->warpSourceLengthSeconds > 0.0)
            clip->lengthSeconds = clip->warpSourceLengthSeconds;
        clip->autoTempo = false;
    }

    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("setClipWarp", args, clipResultData (*owner, *clip), d);
}

var MaolanProcessBackend::getClipPeaks (const var& args)
{
    ensureEvidenceDir();
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto d = operationDiagnostics ("getClipPeaks", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (clipId.isEmpty())
        return failOperation ("getClipPeaks", "invalid_argument", "Missing clipId.", args, d);

    SliceState::Track* owner = nullptr;
    auto* clip = findClip (clipId, &owner);
    if (clip == nullptr || owner == nullptr)
        return failOperation ("getClipPeaks", "not_found", "Clip not found: " + clipId, args, d);
    if (clip->type != "wave")
        return failOperation ("getClipPeaks", "unsupported_by_backend",
                              "The Maolan process slice only supports waveform peaks for wave clips.", args, d);

    const File sourceFile (clip->sourcePath);
    d = operationDiagnostics ("getClipPeaks", 0.0, {}, {}, paths ({ state.sessionGraph, sourceFile }));
    if (! sourceFile.existsAsFile())
        return failOperation ("getClipPeaks", "not_found", "Clip source file not found: " + clip->sourcePath, args, d);

    auto stream = sourceFile.createInputStream();
    if (stream == nullptr)
        return failOperation ("getClipPeaks", "io_error", "Could not open clip source file.", args, d);

    MemoryBlock bytes;
    stream->readIntoMemoryBlock (bytes);
    const auto* data = static_cast<const char*> (bytes.getData());
    const auto size = bytes.getSize();
    if (size < 44 || String::fromUTF8 (data, 4) != "RIFF" || String::fromUTF8 (data + 8, 4) != "WAVE")
        return failOperation ("getClipPeaks", "unsupported_by_backend",
                              "The Maolan process slice can only compute peaks from RIFF/WAVE sources.", args, d);

    uint16 audioFormat = 0;
    uint16 channels = 0;
    uint32 sampleRate = 0;
    uint16 bitsPerSample = 0;
    size_t dataOffset = 0;
    uint32 dataBytes = 0;

    size_t cursor = 12;
    while (cursor + 8 <= size)
    {
        const String chunkId = String::fromUTF8 (data + cursor, 4);
        const auto chunkSize = readU32LE (data + cursor + 4);
        const auto chunkData = cursor + 8;
        if (chunkData + chunkSize > size)
            break;

        if (chunkId == "fmt " && chunkSize >= 16)
        {
            audioFormat = readU16LE (data + chunkData);
            channels = readU16LE (data + chunkData + 2);
            sampleRate = readU32LE (data + chunkData + 4);
            bitsPerSample = readU16LE (data + chunkData + 14);
        }
        else if (chunkId == "data")
        {
            dataOffset = chunkData;
            dataBytes = chunkSize;
            break;
        }

        cursor = chunkData + chunkSize + (chunkSize % 2);
    }

    if (channels == 0 || sampleRate == 0 || bitsPerSample == 0 || dataOffset == 0 || dataBytes == 0)
        return failOperation ("getClipPeaks", "unsupported_by_backend",
                              "WAV source is missing a supported fmt/data chunk.", args, d);

    const auto bytesPerSample = (uint32) bitsPerSample / 8u;
    const auto bytesPerFrame = (uint32) channels * bytesPerSample;
    if (bytesPerSample == 0 || bytesPerFrame == 0 || dataOffset + dataBytes > size)
        return failOperation ("getClipPeaks", "unsupported_by_backend",
                              "WAV source has an unsupported sample layout.", args, d);
    if (! ((audioFormat == 1 && bitsPerSample == 16) || (audioFormat == 3 && bitsPerSample == 32)))
        return failOperation ("getClipPeaks", "unsupported_by_backend",
                              "The Maolan process slice only supports PCM16 or float32 WAV peaks.", args, d);

    const auto totalFrames = (uint32) (dataBytes / bytesPerFrame);
    const int requestedBuckets = jlimit (16, 4000, (int) args.getProperty ("buckets", 600));
    const uint32 perBucket = jmax ((uint32) 1, totalFrames / (uint32) requestedBuckets);
    Array<var> peaks;

    for (int bucket = 0; bucket < requestedBuckets; ++bucket)
    {
        const auto startFrame = (uint32) bucket * perBucket;
        if (startFrame >= totalFrames)
            break;

        const auto framesThisBucket = jmin (perBucket, totalFrames - startFrame);
        float minimum = 0.0f;
        float maximum = 0.0f;

        for (uint32 frame = 0; frame < framesThisBucket; ++frame)
        {
            const auto frameOffset = dataOffset + ((size_t) startFrame + frame) * bytesPerFrame;
            for (uint16 channel = 0; channel < channels; ++channel)
            {
                const auto sampleOffset = frameOffset + (size_t) channel * bytesPerSample;
                float sample = 0.0f;
                if (audioFormat == 1)
                    sample = (float) (int16) readU16LE (data + sampleOffset) / 32768.0f;
                else
                    sample = readF32LE (data + sampleOffset);

                minimum = jmin (minimum, sample);
                maximum = jmax (maximum, sample);
            }
        }

        Array<var> pair;
        pair.add (minimum);
        pair.add (maximum);
        peaks.add (var (pair));
    }

    return finishOperation ("getClipPeaks", args, objectWith ({
        { "clipId", clipId },
        { "buckets", peaks.size() },
        { "peaks", peaks },
    }), d);
}

var MaolanProcessBackend::addMidiClip (const var& args)
{
    ensureEvidenceDir();
    auto requestedTrackId = args.getProperty ("trackId", var()).toString();
    auto* track = requestedTrackId.isNotEmpty() ? findTrack (requestedTrackId) : firstTrack();
    if (track == nullptr)
    {
        SliceState::Track newTrack;
        newTrack.id = requestedTrackId.isNotEmpty() ? requestedTrackId : nextTrackId();
        if (newTrack.id.isEmpty())
            newTrack.id = nextTrackId();
        newTrack.name = "Maolan MIDI Track";
        state.tracks.push_back (newTrack);
        track = &state.tracks.back();
    }

    SliceState::Clip clip;
    clip.id = args.getProperty ("clipId", var()).toString();
    if (clip.id.isEmpty())
        clip.id = nextClipId();
    clip.name = args.getProperty ("name", "MIDI").toString();
    clip.type = "midi";
    clip.sourceKind = "midi";
    clip.startSeconds = jmax (0.0, (double) args.getProperty ("start", 0.0));
    clip.lengthSeconds = jmax (0.0625, (double) args.getProperty ("length", 2.0));

    const auto notes = args.getProperty ("notes", var());
    if (auto* noteArr = notes.getArray())
    {
        for (const auto& noteVar : *noteArr)
        {
            SliceState::Clip::Note note;
            note.pitch = jlimit (0, 127, (int) noteVar.getProperty ("pitch", 60));
            note.start = jmax (0.0, (double) noteVar.getProperty ("start", 0.0));
            note.length = jmax (0.0625, (double) noteVar.getProperty ("length", 1.0));
            note.velocity = jlimit (1, 127, (int) noteVar.getProperty ("velocity", 100));
            clip.notes.push_back (note);
        }
    }
    else
    {
        const int pattern[] = { 60, 64, 67, 72 };
        for (int i = 0; i < 4; ++i)
        {
            SliceState::Clip::Note note;
            note.pitch = pattern[i];
            note.start = (double) i;
            note.length = 1.0;
            note.velocity = 100;
            clip.notes.push_back (note);
        }
    }

    track->clips.push_back (clip);
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("addMidiClip", args, clipResultData (*track, track->clips.back()),
                            operationDiagnostics ("addMidiClip", 0.0, {}, {}, paths ({ state.sessionGraph })));
}

var MaolanProcessBackend::addNote (const var& args)
{
    ensureEvidenceDir();
    SliceState::Track* owner = nullptr;
    auto* clip = findClip (args.getProperty ("clipId", var()).toString(), &owner);
    auto d = operationDiagnostics ("addNote", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (clip == nullptr || owner == nullptr || clip->type != "midi")
        return failOperation ("addNote", "not_found", "MIDI clip not found.", args, d);

    SliceState::Clip::Note note;
    note.pitch = jlimit (0, 127, (int) args.getProperty ("pitch", 60));
    note.start = jmax (0.0, (double) args.getProperty ("start", 0.0));
    note.length = jmax (0.0625, (double) args.getProperty ("length", 1.0));
    note.velocity = jlimit (1, 127, (int) args.getProperty ("velocity", 100));
    clip->notes.push_back (note);
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("addNote", args, objectWith ({
        { "clipId", clip->id },
        { "trackId", owner->id },
        { "noteCount", (int) clip->notes.size() },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::removeNote (const var& args)
{
    ensureEvidenceDir();
    SliceState::Track* owner = nullptr;
    auto* clip = findClip (args.getProperty ("clipId", var()).toString(), &owner);
    const int noteIndex = (int) args.getProperty ("noteIndex", -1);
    auto d = operationDiagnostics ("removeNote", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (clip == nullptr || owner == nullptr || clip->type != "midi")
        return failOperation ("removeNote", "not_found", "MIDI clip not found.", args, d);
    if (noteIndex < 0 || noteIndex >= (int) clip->notes.size())
        return failOperation ("removeNote", "invalid_argument", "Bad noteIndex.", args, d);

    clip->notes.erase (clip->notes.begin() + noteIndex);
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("removeNote", args, objectWith ({
        { "clipId", clip->id },
        { "trackId", owner->id },
        { "noteCount", (int) clip->notes.size() },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::setNote (const var& args)
{
    ensureEvidenceDir();
    SliceState::Track* owner = nullptr;
    auto* clip = findClip (args.getProperty ("clipId", var()).toString(), &owner);
    const int noteIndex = (int) args.getProperty ("noteIndex", -1);
    auto d = operationDiagnostics ("setNote", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (clip == nullptr || owner == nullptr || clip->type != "midi")
        return failOperation ("setNote", "not_found", "MIDI clip not found.", args, d);
    if (noteIndex < 0 || noteIndex >= (int) clip->notes.size())
        return failOperation ("setNote", "invalid_argument", "Bad noteIndex.", args, d);

    auto& note = clip->notes[(size_t) noteIndex];
    if (args.hasProperty ("pitch"))
        note.pitch = jlimit (0, 127, (int) args.getProperty ("pitch", note.pitch));
    if (args.hasProperty ("start"))
        note.start = jmax (0.0, (double) args.getProperty ("start", note.start));
    if (args.hasProperty ("length"))
        note.length = jmax (0.0625, (double) args.getProperty ("length", note.length));
    if (args.hasProperty ("velocity"))
        note.velocity = jlimit (1, 127, (int) args.getProperty ("velocity", note.velocity));

    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("setNote", args, objectWith ({
        { "clipId", clip->id },
        { "trackId", owner->id },
        { "noteIndex", noteIndex },
        { "pitch", note.pitch },
        { "start", note.start },
        { "length", note.length },
        { "velocity", note.velocity },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::quantizeNotes (const var& args)
{
    ensureEvidenceDir();
    SliceState::Track* owner = nullptr;
    auto* clip = findClip (args.getProperty ("clipId", var()).toString(), &owner);
    auto d = operationDiagnostics ("quantizeNotes", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (clip == nullptr || owner == nullptr || clip->type != "midi")
        return failOperation ("quantizeNotes", "not_found", "MIDI clip not found.", args, d);

    const double division = jmax (0.03125, (double) args.getProperty ("division", 1.0));
    const double strength = jlimit (0.0, 1.0, (double) args.getProperty ("strength", 1.0));
    int moved = 0;
    for (auto& note : clip->notes)
    {
        const double quantized = std::round (note.start / division) * division;
        const double next = jmax (0.0, note.start + (quantized - note.start) * strength);
        if (std::abs (next - note.start) > 1.0e-6)
        {
            note.start = next;
            ++moved;
        }
    }

    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("quantizeNotes", args, objectWith ({
        { "clipId", clip->id },
        { "trackId", owner->id },
        { "moved", moved },
        { "noteCount", (int) clip->notes.size() },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::updateTrackMixer (const String& commandId,
                                            const String& propertyName,
                                            const var& value,
                                            const var& args)
{
    ensureEvidenceDir();
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto d = operationDiagnostics (commandId, 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (trackId.isEmpty())
        return failOperation (commandId, "invalid_argument",
                              "Missing trackId.", args, d);

    auto* track = findTrack (trackId);
    if (track == nullptr)
        return failOperation (commandId, "not_found",
                              "Track not found: " + trackId, args, d);

    if (propertyName == "volumeDb")
        track->volumeDb = (double) value;
    else if (propertyName == "pan")
        track->pan = jlimit (-1.0, 1.0, (double) value);
    else if (propertyName == "mute")
        track->mute = (bool) value;
    else if (propertyName == "solo")
        track->solo = (bool) value;

    writeSessionGraphFile (state.sessionGraph);
    return finishOperation (commandId, args, objectWith ({
        { "trackId", track->id },
        { "volumeDb", track->volumeDb },
        { "pan", track->pan },
        { "mute", track->mute },
        { "solo", track->solo },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::setTrackVolume (const var& args)
{
    return updateTrackMixer ("setTrackVolume", "volumeDb", args.getProperty ("db", 0.0), args);
}

var MaolanProcessBackend::setTrackPan (const var& args)
{
    return updateTrackMixer ("setTrackPan", "pan", args.getProperty ("pan", 0.0), args);
}

var MaolanProcessBackend::setTrackMute (const var& args)
{
    return updateTrackMixer ("setTrackMute", "mute", args.getProperty ("mute", false), args);
}

var MaolanProcessBackend::setTrackSolo (const var& args)
{
    return updateTrackMixer ("setTrackSolo", "solo", args.getProperty ("solo", false), args);
}

var MaolanProcessBackend::enableTrackMeter (const var& args)
{
    ensureEvidenceDir();
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto d = operationDiagnostics ("enableTrackMeter", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (trackId.isEmpty())
        return failOperation ("enableTrackMeter", "invalid_argument", "Missing trackId.", args, d);

    auto* track = findTrack (trackId);
    if (track == nullptr)
        return failOperation ("enableTrackMeter", "not_found", "Track not found: " + trackId, args, d);

    track->meterEnabled = true;
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("enableTrackMeter", args, objectWith ({
        { "trackId", track->id },
        { "meterEnabled", track->meterEnabled },
        { "applied", false },
        { "reason", "native Maolan level samples are not available in this process slice" },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::disableTrackMeter (const var& args)
{
    ensureEvidenceDir();
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto d = operationDiagnostics ("disableTrackMeter", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (trackId.isEmpty())
        return failOperation ("disableTrackMeter", "invalid_argument", "Missing trackId.", args, d);

    auto* track = findTrack (trackId);
    if (track == nullptr)
        return failOperation ("disableTrackMeter", "not_found", "Track not found: " + trackId, args, d);

    track->meterEnabled = false;
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("disableTrackMeter", args, objectWith ({
        { "trackId", track->id },
        { "meterEnabled", track->meterEnabled },
        { "applied", false },
        { "reason", "native Maolan level samples are not available in this process slice" },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::enableAllMeters (const var& args)
{
    ensureEvidenceDir();
    auto d = operationDiagnostics ("enableAllMeters", 0.0, {}, {}, paths ({ state.sessionGraph }));

    Array<var> enabledTracks;
    for (auto& track : state.tracks)
    {
        if (track.isGroup)
            continue;

        track.meterEnabled = true;
        enabledTracks.add (track.id);
    }

    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("enableAllMeters", args, objectWith ({
        { "enabledTracks", enabledTracks },
        { "count", enabledTracks.size() },
        { "applied", false },
        { "reason", "native Maolan level samples are not available in this process slice" },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::setMasterVolume (const var& args)
{
    ensureEvidenceDir();
    auto d = operationDiagnostics ("setMasterVolume", 0.0, {}, {}, paths ({ state.sessionGraph }));
    state.masterVolumeDb = jlimit (-48.0, 6.0, (double) args.getProperty ("db", 0.0));
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("setMasterVolume", args, objectWith ({
        { "volumeDb", state.masterVolumeDb },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::setMasterPan (const var& args)
{
    ensureEvidenceDir();
    auto d = operationDiagnostics ("setMasterPan", 0.0, {}, {}, paths ({ state.sessionGraph }));
    state.masterPan = jlimit (-1.0, 1.0, (double) args.getProperty ("pan", 0.0));
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("setMasterPan", args, objectWith ({
        { "pan", state.masterPan },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::createBus (const var& args)
{
    ensureEvidenceDir();
    auto d = operationDiagnostics ("createBus", 0.0, {}, {}, paths ({ state.sessionGraph }));
    const int busNumber = nextBusNumber();
    auto name = args.getProperty ("name", var()).toString();
    if (name.isEmpty())
        name = "Bus " + String (busNumber + 1);

    SliceState::Track returnTrack;
    returnTrack.id = args.getProperty ("trackId", var()).toString();
    if (returnTrack.id.isEmpty())
        returnTrack.id = nextTrackId();
    if (findTrack (returnTrack.id) != nullptr)
        return failOperation ("createBus", "invalid_argument",
                              "Track id already exists: " + returnTrack.id, args, d);
    returnTrack.name = name;
    returnTrack.type = "audio";
    returnTrack.isReturn = true;
    returnTrack.returnBus = busNumber;

    SliceState::Bus bus;
    bus.bus = busNumber;
    bus.name = name;
    bus.trackId = returnTrack.id;

    state.tracks.push_back (returnTrack);
    state.buses.push_back (bus);
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("createBus", args, objectWith ({
        { "bus", bus.bus },
        { "busNumber", bus.bus },
        { "trackId", bus.trackId },
        { "name", bus.name },
        { "applied", false },
        { "reason", "live aux summing is not available in the Maolan process slice" },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::addSend (const var& args)
{
    ensureEvidenceDir();
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int busNumber = (int) args.getProperty ("bus", -1);
    auto d = operationDiagnostics ("addSend", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (trackId.isEmpty())
        return failOperation ("addSend", "invalid_argument", "Missing trackId.", args, d);
    if (busNumber < 0)
        return failOperation ("addSend", "invalid_argument", "Missing bus.", args, d);
    auto* track = findTrack (trackId);
    if (track == nullptr)
        return failOperation ("addSend", "not_found", "Track not found: " + trackId, args, d);
    if (findBus (busNumber) == nullptr)
        return failOperation ("addSend", "not_found", "Bus not found: " + String (busNumber), args, d);
    for (const auto& send : track->sends)
        if (send.bus == busNumber)
            return failOperation ("addSend", "invalid_argument", "Send already exists.", args, d);

    SliceState::Track::Send send;
    send.bus = busNumber;
    send.db = jlimit (-60.0, 6.0, (double) args.getProperty ("db", 0.0));
    send.mute = (bool) args.getProperty ("mute", false);
    track->sends.push_back (send);
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("addSend", args, objectWith ({
        { "trackId", track->id },
        { "bus", send.bus },
        { "db", send.db },
        { "mute", send.mute },
        { "applied", false },
        { "reason", "live aux summing is not available in the Maolan process slice" },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::setSendLevel (const var& args)
{
    ensureEvidenceDir();
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int busNumber = (int) args.getProperty ("bus", -1);
    auto d = operationDiagnostics ("setSendLevel", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (trackId.isEmpty())
        return failOperation ("setSendLevel", "invalid_argument", "Missing trackId.", args, d);
    auto* track = findTrack (trackId);
    if (track == nullptr)
        return failOperation ("setSendLevel", "not_found", "Track not found: " + trackId, args, d);
    for (auto& send : track->sends)
        if (send.bus == busNumber)
        {
            send.db = jlimit (-100.0, 6.0, (double) args.getProperty ("db", 0.0));
            if (args.hasProperty ("mute"))
                send.mute = (bool) args.getProperty ("mute", false);
            writeSessionGraphFile (state.sessionGraph);
            return finishOperation ("setSendLevel", args, objectWith ({
                { "trackId", track->id },
                { "bus", send.bus },
                { "db", send.db },
                { "mute", send.mute },
                { "applied", false },
                { "reason", "live aux summing is not available in the Maolan process slice" },
                { "sessionGraph", state.sessionGraph.getFullPathName() },
            }), d);
        }

    return failOperation ("setSendLevel", "not_found",
                          "Send not found for bus: " + String (busNumber), args, d);
}

var MaolanProcessBackend::removeSend (const var& args)
{
    ensureEvidenceDir();
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int busNumber = (int) args.getProperty ("bus", -1);
    auto d = operationDiagnostics ("removeSend", 0.0, {}, {}, paths ({ state.sessionGraph }));
    auto* track = findTrack (trackId);
    if (track == nullptr)
        return failOperation ("removeSend", "not_found", "Track not found: " + trackId, args, d);
    for (auto it = track->sends.begin(); it != track->sends.end(); ++it)
        if (it->bus == busNumber)
        {
            track->sends.erase (it);
            writeSessionGraphFile (state.sessionGraph);
            return finishOperation ("removeSend", args, objectWith ({
                { "trackId", track->id },
                { "bus", busNumber },
                { "sessionGraph", state.sessionGraph.getFullPathName() },
            }), d);
        }

    return failOperation ("removeSend", "not_found",
                          "Send not found for bus: " + String (busNumber), args, d);
}

var MaolanProcessBackend::removeBus (const var& args)
{
    ensureEvidenceDir();
    const int busNumber = (int) args.getProperty ("bus", -1);
    auto d = operationDiagnostics ("removeBus", 0.0, {}, {}, paths ({ state.sessionGraph }));
    auto* bus = findBus (busNumber);
    if (bus == nullptr)
        return failOperation ("removeBus", "not_found", "Bus not found: " + String (busNumber), args, d);
    const auto trackId = bus->trackId;

    state.buses.erase (std::remove_if (state.buses.begin(), state.buses.end(),
                                       [busNumber] (const SliceState::Bus& candidate)
                                       {
                                           return candidate.bus == busNumber;
                                       }),
                       state.buses.end());
    state.tracks.erase (std::remove_if (state.tracks.begin(), state.tracks.end(),
                                        [&trackId] (const SliceState::Track& track)
                                        {
                                            return track.id == trackId;
                                        }),
                        state.tracks.end());
    for (auto& track : state.tracks)
        track.sends.erase (std::remove_if (track.sends.begin(), track.sends.end(),
                                           [busNumber] (const SliceState::Track::Send& send)
                                           {
                                               return send.bus == busNumber;
                                           }),
                           track.sends.end());

    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("removeBus", args, objectWith ({
        { "bus", busNumber },
        { "trackId", trackId },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::renameBus (const var& args)
{
    ensureEvidenceDir();
    const int busNumber = (int) args.getProperty ("bus", -1);
    auto name = args.getProperty ("name", var()).toString();
    auto d = operationDiagnostics ("renameBus", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (name.isEmpty())
        name = "Bus " + String (busNumber + 1);
    auto* bus = findBus (busNumber);
    if (bus == nullptr)
        return failOperation ("renameBus", "not_found", "Bus not found: " + String (busNumber), args, d);
    bus->name = name;
    if (auto* returnTrack = findTrack (bus->trackId))
        returnTrack->name = name;

    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("renameBus", args, objectWith ({
        { "bus", bus->bus },
        { "busNumber", bus->bus },
        { "trackId", bus->trackId },
        { "name", bus->name },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::createGroupTrack (const var& args)
{
    ensureEvidenceDir();
    auto d = operationDiagnostics ("createGroupTrack", 0.0, {}, {}, paths ({ state.sessionGraph }));

    SliceState::Track group;
    group.id = args.getProperty ("groupId", args.getProperty ("trackId", var())).toString();
    if (group.id.isEmpty())
        group.id = nextTrackId();
    if (findTrack (group.id) != nullptr)
        return failOperation ("createGroupTrack", "invalid_argument",
                              "Track id already exists: " + group.id, args, d);

    group.name = args.getProperty ("name", var()).toString();
    if (group.name.isEmpty())
        group.name = "Group";
    group.type = "group";
    group.isGroup = true;

    int moved = 0;
    int unknown = 0;
    const auto idsVar = args.getProperty ("trackIds", var());
    if (auto* ids = idsVar.getArray())
    {
        for (const auto& idVar : *ids)
        {
            const auto id = idVar.toString();
            if (id.isEmpty() || id == group.id)
                continue;

            if (auto* member = findTrack (id))
            {
                if (! member->isGroup)
                {
                    member->parentId = group.id;
                    ++moved;
                }
            }
            else
            {
                ++unknown;
            }
        }
    }

    state.tracks.push_back (group);
    writeSessionGraphFile (state.sessionGraph);

    return finishOperation ("createGroupTrack", args, objectWith ({
        { "groupId", group.id },
        { "trackId", group.id },
        { "name", group.name },
        { "moved", moved },
        { "unknownTrackIds", unknown },
        { "applied", false },
        { "reason", "native submix summing is not available in the Maolan process slice" },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::ungroupTrack (const var& args)
{
    ensureEvidenceDir();
    const auto groupId = args.getProperty ("trackId", args.getProperty ("groupId", var())).toString();
    auto d = operationDiagnostics ("ungroupTrack", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (groupId.isEmpty())
        return failOperation ("ungroupTrack", "invalid_argument", "Missing trackId.", args, d);

    auto* group = findTrack (groupId);
    if (group == nullptr || ! group->isGroup)
        return failOperation ("ungroupTrack", "not_found", "Group track not found: " + groupId, args, d);

    int hoisted = 0;
    for (auto& track : state.tracks)
    {
        if (track.parentId == groupId)
        {
            track.parentId = {};
            ++hoisted;
        }
    }

    state.tracks.erase (std::remove_if (state.tracks.begin(), state.tracks.end(),
                                        [&groupId] (const SliceState::Track& track)
                                        {
                                            return track.id == groupId;
                                        }),
                        state.tracks.end());

    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("ungroupTrack", args, objectWith ({
        { "groupId", groupId },
        { "trackId", groupId },
        { "hoisted", hoisted },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::setTrackInput (const var& args)
{
    ensureEvidenceDir();
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const auto deviceId = args.getProperty ("deviceID", var()).toString();
    auto d = operationDiagnostics ("setTrackInput", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (trackId.isEmpty())
        return failOperation ("setTrackInput", "invalid_argument", "Missing trackId.", args, d);
    if (deviceId.isEmpty())
        return failOperation ("setTrackInput", "invalid_argument", "Missing deviceID.", args, d);

    auto* track = findTrack (trackId);
    if (track == nullptr)
        return failOperation ("setTrackInput", "not_found", "Track not found: " + trackId, args, d);

    track->inputDeviceId = deviceId;
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("setTrackInput", args, objectWith ({
        { "trackId", track->id },
        { "deviceID", track->inputDeviceId },
        { "applied", false },
        { "reason", "live input binding is not available in the Maolan process slice" },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::setTrackOutput (const var& args)
{
    ensureEvidenceDir();
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto d = operationDiagnostics ("setTrackOutput", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (trackId.isEmpty())
        return failOperation ("setTrackOutput", "invalid_argument", "Missing trackId.", args, d);

    auto* track = findTrack (trackId);
    if (track == nullptr)
        return failOperation ("setTrackOutput", "not_found", "Track not found: " + trackId, args, d);

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->id);
    data->setProperty ("sessionGraph", state.sessionGraph.getFullPathName());

    if (args.hasProperty ("destTrackId"))
    {
        const auto destId = args.getProperty ("destTrackId", var()).toString();
        auto* dest = findTrack (destId);
        if (dest == nullptr)
            return failOperation ("setTrackOutput", "not_found", "Destination track not found: " + destId, args, d);
        if (dest->id == track->id)
            return failOperation ("setTrackOutput", "invalid_argument", "A track cannot output to itself.", args, d);

        auto* cursor = dest;
        while (cursor != nullptr && cursor->outputKind == "track")
        {
            if (cursor->outputDestTrackId == track->id)
                return failOperation ("setTrackOutput", "invalid_argument", "Routing would create a cycle.", args, d);
            cursor = findTrack (cursor->outputDestTrackId);
        }

        track->outputKind = "track";
        track->outputDestTrackId = dest->id;
        track->outputDeviceId = {};
        data->setProperty ("destTrackId", dest->id);
    }
    else if (args.hasProperty ("deviceID"))
    {
        const auto deviceId = args.getProperty ("deviceID", var()).toString();
        if (deviceId.isEmpty())
            return failOperation ("setTrackOutput", "invalid_argument", "deviceID cannot be empty.", args, d);

        track->outputKind = "device";
        track->outputDeviceId = deviceId;
        track->outputDestTrackId = {};
        data->setProperty ("deviceID", deviceId);
    }
    else if (args.getProperty ("output", var()).toString() == "default")
    {
        track->outputKind = {};
        track->outputDeviceId = {};
        track->outputDestTrackId = {};
        data->setProperty ("output", "default");
    }
    else
    {
        return failOperation ("setTrackOutput", "invalid_argument",
                              "Expected destTrackId, deviceID, or output:'default'.", args, d);
    }

    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("setTrackOutput", args, var (data), d);
}

var MaolanProcessBackend::armTrack (const var& args)
{
    ensureEvidenceDir();
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto d = operationDiagnostics ("armTrack", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (trackId.isEmpty())
        return failOperation ("armTrack", "invalid_argument", "Missing trackId.", args, d);

    auto* track = findTrack (trackId);
    if (track == nullptr)
        return failOperation ("armTrack", "not_found", "Track not found: " + trackId, args, d);

    track->armed = (bool) args.getProperty ("armed", false);
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("armTrack", args, objectWith ({
        { "trackId", track->id },
        { "armed", track->armed },
        { "applied", false },
        { "reason", "live input binding is not available in the Maolan process slice" },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::setInputMonitor (const var& args)
{
    ensureEvidenceDir();
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto d = operationDiagnostics ("setInputMonitor", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (trackId.isEmpty())
        return failOperation ("setInputMonitor", "invalid_argument", "Missing trackId.", args, d);

    auto* track = findTrack (trackId);
    if (track == nullptr)
        return failOperation ("setInputMonitor", "not_found", "Track not found: " + trackId, args, d);

    String mode;
    if (args.hasProperty ("mode"))
        mode = args.getProperty ("mode", var()).toString();
    else if (args.hasProperty ("monitor"))
        mode = ((bool) args.getProperty ("monitor", false)) ? "on" : "off";
    else
        mode = "automatic";

    if (mode != "off" && mode != "on" && mode != "automatic")
        return failOperation ("setInputMonitor", "invalid_argument", "Bad monitor mode: " + mode, args, d);

    track->monitor = mode;
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("setInputMonitor", args, objectWith ({
        { "trackId", track->id },
        { "mode", track->monitor },
        { "applied", false },
        { "reason", "live input binding is not available in the Maolan process slice" },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::stopRecording (const var& args)
{
    ensureEvidenceDir();
    Array<var> clips;
    auto d = operationDiagnostics ("stopRecording", 0.0, {}, {}, paths ({ state.sessionGraph }));
    return finishOperation ("stopRecording", args, objectWith ({
        { "applied", false },
        { "discarded", (bool) args.getProperty ("discardRecordings", false) },
        { "clips", clips },
        { "reason", "live recording is not available in the Maolan process slice" },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::setTempo (const var& args)
{
    ensureEvidenceDir();
    state.tempoBpm = jlimit (20.0, 999.0, (double) args.getProperty ("bpm", 120.0));
    if (state.tempoMap.empty())
        state.tempoMap.push_back ({ 0.0, state.tempoBpm, 1.0 });
    state.tempoMap.front().time = 0.0;
    state.tempoMap.front().bpm = state.tempoBpm;
    refreshWarpedClipLengths();
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("setTempo", args, objectWith ({
        { "bpm", state.tempoBpm },
        { "tempoMap", buildSessionGraph().getProperty ("tempoMap", var()) },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), operationDiagnostics ("setTempo", 0.0, {}, {}, paths ({ state.sessionGraph })));
}

var MaolanProcessBackend::insertTempoChange (const var& args)
{
    ensureEvidenceDir();
    auto d = operationDiagnostics ("insertTempoChange", 0.0, {}, {}, paths ({ state.sessionGraph }));
    const double time = (double) args.getProperty ("time", -1.0);
    const double bpm = (double) args.getProperty ("bpm", 0.0);
    if (time < 0.0)
        return failOperation ("insertTempoChange", "invalid_argument", "missing/negative 'time'", args, d);
    if (bpm < 20.0 || bpm > 999.0)
        return failOperation ("insertTempoChange", "invalid_argument", "bpm must be 20..999", args, d);

    SliceState::TempoPoint point;
    point.time = time;
    point.bpm = bpm;
    point.curve = (double) args.getProperty ("curve", 1.0);

    if (state.tempoMap.empty())
        state.tempoMap.push_back ({ 0.0, state.tempoBpm, 1.0 });

    int index = -1;
    for (int i = 0; i < (int) state.tempoMap.size(); ++i)
        if (std::abs (state.tempoMap[(size_t) i].time - time) < 0.0001)
        {
            state.tempoMap[(size_t) i] = point;
            index = i;
            break;
        }

    if (index < 0)
    {
        state.tempoMap.push_back (point);
        std::sort (state.tempoMap.begin(), state.tempoMap.end(),
                   [] (const SliceState::TempoPoint& a, const SliceState::TempoPoint& b)
                   {
                       return a.time < b.time;
                   });
        for (int i = 0; i < (int) state.tempoMap.size(); ++i)
            if (std::abs (state.tempoMap[(size_t) i].time - time) < 0.0001)
                index = i;
    }

    state.tempoMap.front().time = 0.0;
    state.tempoBpm = state.tempoMap.front().bpm;
    refreshWarpedClipLengths();
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("insertTempoChange", args, objectWith ({
        { "index", index },
        { "time", time },
        { "bpm", bpm },
        { "curve", point.curve },
        { "tempoMap", buildSessionGraph().getProperty ("tempoMap", var()) },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::removeTempoChange (const var& args)
{
    ensureEvidenceDir();
    auto d = operationDiagnostics ("removeTempoChange", 0.0, {}, {}, paths ({ state.sessionGraph }));
    const int index = (int) args.getProperty ("index", -1);
    if (index <= 0 || index >= (int) state.tempoMap.size())
        return failOperation ("removeTempoChange", "invalid_argument",
                              "index must be 1..numTempos-1", args, d);

    state.tempoMap.erase (state.tempoMap.begin() + index);
    state.tempoBpm = state.tempoMap.empty() ? state.tempoBpm : state.tempoMap.front().bpm;
    refreshWarpedClipLengths();
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("removeTempoChange", args, objectWith ({
        { "removedIndex", index },
        { "tempoMap", buildSessionGraph().getProperty ("tempoMap", var()) },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::setTempoCurve (const var& args)
{
    ensureEvidenceDir();
    auto d = operationDiagnostics ("setTempoCurve", 0.0, {}, {}, paths ({ state.sessionGraph }));
    const int index = (int) args.getProperty ("index", -1);
    if (index < 0 || index >= (int) state.tempoMap.size())
        return failOperation ("setTempoCurve", "invalid_argument",
                              "index must be 0..numTempos-1", args, d);
    if (! args.hasProperty ("curve"))
        return failOperation ("setTempoCurve", "invalid_argument", "missing 'curve'", args, d);

    state.tempoMap[(size_t) index].curve = (double) args.getProperty ("curve", 1.0);
    refreshWarpedClipLengths();
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("setTempoCurve", args, objectWith ({
        { "index", index },
        { "curve", state.tempoMap[(size_t) index].curve },
        { "tempoMap", buildSessionGraph().getProperty ("tempoMap", var()) },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::setTimeSignature (const var& args)
{
    ensureEvidenceDir();
    const int numerator = jlimit (1, 32, (int) args.getProperty ("numerator", 4));
    const int denominator = (int) args.getProperty ("denominator", 4);
    const bool denominatorOk = denominator == 1 || denominator == 2 || denominator == 4
                               || denominator == 8 || denominator == 16 || denominator == 32;
    auto d = operationDiagnostics ("setTimeSignature", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (! denominatorOk)
        return failOperation ("setTimeSignature", "invalid_argument",
                              "denominator must be a power of two (1..32)", args, d);

    state.timeSigNumerator = numerator;
    state.timeSigDenominator = denominator;
    if (state.timeSigMap.empty())
        state.timeSigMap.push_back ({ 0.0, state.timeSigNumerator, state.timeSigDenominator });
    state.timeSigMap.front().time = 0.0;
    state.timeSigMap.front().numerator = state.timeSigNumerator;
    state.timeSigMap.front().denominator = state.timeSigDenominator;
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("setTimeSignature", args, objectWith ({
        { "numerator", state.timeSigNumerator },
        { "denominator", state.timeSigDenominator },
        { "timeSigMap", buildSessionGraph().getProperty ("timeSigMap", var()) },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::insertTimeSigChange (const var& args)
{
    ensureEvidenceDir();
    auto d = operationDiagnostics ("insertTimeSigChange", 0.0, {}, {}, paths ({ state.sessionGraph }));
    const double time = (double) args.getProperty ("time", -1.0);
    const int numerator = jlimit (1, 32, (int) args.getProperty ("numerator", 4));
    const int denominator = (int) args.getProperty ("denominator", 4);
    const bool denominatorOk = denominator == 1 || denominator == 2 || denominator == 4
                               || denominator == 8 || denominator == 16 || denominator == 32;
    if (time < 0.0)
        return failOperation ("insertTimeSigChange", "invalid_argument", "missing/negative 'time'", args, d);
    if (! denominatorOk)
        return failOperation ("insertTimeSigChange", "invalid_argument",
                              "denominator must be a power of two (1..32)", args, d);

    SliceState::TimeSigPoint point;
    point.time = time;
    point.numerator = numerator;
    point.denominator = denominator;
    if (state.timeSigMap.empty())
        state.timeSigMap.push_back ({ 0.0, state.timeSigNumerator, state.timeSigDenominator });

    int index = -1;
    for (int i = 0; i < (int) state.timeSigMap.size(); ++i)
        if (std::abs (state.timeSigMap[(size_t) i].time - time) < 0.0001)
        {
            state.timeSigMap[(size_t) i] = point;
            index = i;
            break;
        }

    if (index < 0)
    {
        state.timeSigMap.push_back (point);
        std::sort (state.timeSigMap.begin(), state.timeSigMap.end(),
                   [] (const SliceState::TimeSigPoint& a, const SliceState::TimeSigPoint& b)
                   {
                       return a.time < b.time;
                   });
        for (int i = 0; i < (int) state.timeSigMap.size(); ++i)
            if (std::abs (state.timeSigMap[(size_t) i].time - time) < 0.0001)
                index = i;
    }

    state.timeSigMap.front().time = 0.0;
    state.timeSigNumerator = state.timeSigMap.front().numerator;
    state.timeSigDenominator = state.timeSigMap.front().denominator;
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("insertTimeSigChange", args, objectWith ({
        { "index", index },
        { "time", time },
        { "numerator", numerator },
        { "denominator", denominator },
        { "timeSigMap", buildSessionGraph().getProperty ("timeSigMap", var()) },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::removeTimeSigChange (const var& args)
{
    ensureEvidenceDir();
    auto d = operationDiagnostics ("removeTimeSigChange", 0.0, {}, {}, paths ({ state.sessionGraph }));
    const int index = (int) args.getProperty ("index", -1);
    if (index <= 0 || index >= (int) state.timeSigMap.size())
        return failOperation ("removeTimeSigChange", "invalid_argument",
                              "index must be 1..numTimeSigs-1", args, d);

    state.timeSigMap.erase (state.timeSigMap.begin() + index);
    state.timeSigNumerator = state.timeSigMap.empty() ? state.timeSigNumerator : state.timeSigMap.front().numerator;
    state.timeSigDenominator = state.timeSigMap.empty() ? state.timeSigDenominator : state.timeSigMap.front().denominator;
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("removeTimeSigChange", args, objectWith ({
        { "removedIndex", index },
        { "timeSigMap", buildSessionGraph().getProperty ("timeSigMap", var()) },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::setMetronome (const var& args)
{
    ensureEvidenceDir();
    state.metronome = (bool) args.getProperty ("enabled", false);
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("setMetronome", args, objectWith ({
        { "metronome", state.metronome },
        { "enabled", state.metronome },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), operationDiagnostics ("setMetronome", 0.0, {}, {}, paths ({ state.sessionGraph })));
}

var MaolanProcessBackend::setProjectSettings (const var& args)
{
    ensureEvidenceDir();
    auto d = operationDiagnostics ("setProjectSettings", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (args.hasProperty ("sampleRate"))
    {
        const double sampleRate = (double) args.getProperty ("sampleRate", 0.0);
        if (sampleRate < 7000.0)
            return failOperation ("setProjectSettings", "invalid_argument",
                                  "sampleRate must be >= 7000", args, d);
    }
    if (args.hasProperty ("bitDepth"))
    {
        const int bitDepth = (int) args.getProperty ("bitDepth", 0);
        if (bitDepth != 16 && bitDepth != 24 && bitDepth != 32)
            return failOperation ("setProjectSettings", "invalid_argument",
                                  "bitDepth must be one of 16, 24, 32", args, d);
    }
    if (args.hasProperty ("timeBase"))
    {
        const auto timeBase = args.getProperty ("timeBase", var()).toString();
        if (timeBase != "seconds" && timeBase != "barsBeats")
            return failOperation ("setProjectSettings", "invalid_argument",
                                  "timeBase must be 'seconds' or 'barsBeats'", args, d);
    }

    if (args.hasProperty ("sampleRate"))
        state.projectSampleRate = (double) args.getProperty ("sampleRate", state.projectSampleRate);
    if (args.hasProperty ("bitDepth"))
        state.projectBitDepth = (int) args.getProperty ("bitDepth", state.projectBitDepth);
    if (args.hasProperty ("timeBase"))
        state.projectTimeBase = args.getProperty ("timeBase", state.projectTimeBase).toString();

    writeSessionGraphFile (state.sessionGraph);
    const auto project = buildSessionGraph().getProperty ("project", var());
    return finishOperation ("setProjectSettings", args, objectWith ({
        { "sampleRate", project.getProperty ("sampleRate", state.projectSampleRate) },
        { "bitDepth", project.getProperty ("bitDepth", state.projectBitDepth) },
        { "timeBase", project.getProperty ("timeBase", state.projectTimeBase) },
        { "project", project },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::loadPlugin (const var& args)
{
    ensureEvidenceDir();
    auto requestedTrackId = args.getProperty ("trackId", var()).toString();
    SliceState::Track* track = requestedTrackId.isNotEmpty() ? findTrack (requestedTrackId) : firstTrack();
    if (track == nullptr)
    {
        auto d = operationDiagnostics ("loadPlugin", 0.0, state.maolanStdout, state.maolanStderr,
                                      paths ({ state.timingCsv }));
        return failOperation ("loadPlugin", "invalid_session_graph",
                              "Cannot load a plugin before createTrack.", args, d);
    }
    requestedTrackId = track->id;

    const auto requestedPath = args.getProperty ("pluginPath", state.pluginPath).toString();
    if (requestedPath.isNotEmpty())
        state.pluginPath = requestedPath;
    if (! state.pluginPath.contains ("JamPilotTestGain.vst3"))
    {
        auto d = operationDiagnostics ("loadPlugin", 0.0, state.maolanStdout, state.maolanStderr,
                                      paths ({ state.timingCsv }));
        return failOperation ("loadPlugin", "unsupported_by_backend",
                              "The first Maolan slice only supports JamPilotTestGain.vst3.", args, d);
    }

    const auto requestedPluginId = args.getProperty ("pluginId", "jampilot-test-gain-vst3").toString();
    if (isPluginBlocked (requestedPluginId, state.pluginPath))
    {
        auto d = operationDiagnostics ("loadPlugin", 0.0, state.maolanStdout, state.maolanStderr,
                                      paths ({ state.timingCsv, state.sessionGraph }));
        return failOperation ("loadPlugin", "blocked_plugin",
                              "Plugin is blocked in the Maolan process catalog: " + requestedPluginId,
                              args, d);
    }

    auto smoke = ensureSmokeRan (args);
    if (! (bool) smoke.getProperty ("ok", false))
        return smoke;

    SliceState::Plugin plugin;
    plugin.id = requestedPluginId.isNotEmpty() ? requestedPluginId : "plugin-" + String ((int) track->plugins.size() + 1);
    if (plugin.id.isEmpty())
        plugin.id = "plugin-" + String ((int) track->plugins.size() + 1);
    plugin.format = "vst3";
    plugin.path = state.pluginPath;
    plugin.name = pluginNameFromPath (state.pluginPath);
    plugin.enabled = true;
    plugin.isInstrument = false;

    const int requestedIndex = (int) args.getProperty ("index", -1);
    int pluginIndex = requestedIndex >= 0 ? requestedIndex : (int) track->plugins.size();
    pluginIndex = jlimit (0, (int) track->plugins.size(), pluginIndex);
    track->plugins.insert (track->plugins.begin() + pluginIndex, plugin);

    writeSessionGraphFile (state.sessionGraph);

    auto d = operationDiagnostics ("loadPlugin", 0.0, state.maolanStdout, state.maolanStderr,
                                  paths ({ state.timingCsv, state.sessionGraph }));
    return finishOperation ("loadPlugin", args, pluginResultData (*track, track->plugins[(size_t) pluginIndex], pluginIndex), d);
}

var MaolanProcessBackend::removePlugin (const var& args)
{
    ensureEvidenceDir();
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int index = (int) args.getProperty ("index", -1);
    auto d = operationDiagnostics ("removePlugin", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (trackId.isEmpty())
        return failOperation ("removePlugin", "invalid_argument", "Missing trackId.", args, d);

    auto* track = findTrack (trackId);
    if (track == nullptr)
        return failOperation ("removePlugin", "not_found", "Track not found: " + trackId, args, d);
    if (findPlugin (*track, index) == nullptr)
        return failOperation ("removePlugin", "not_found", "Plugin not found at index " + String (index) + ".", args, d);

    track->plugins.erase (track->plugins.begin() + index);
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("removePlugin", args, objectWith ({
        { "trackId", track->id },
        { "index", index },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::reorderPlugin (const var& args)
{
    ensureEvidenceDir();
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int from = (int) args.getProperty ("index", -1);
    const int requestedTo = (int) args.getProperty ("toIndex", -1);
    auto d = operationDiagnostics ("reorderPlugin", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (trackId.isEmpty())
        return failOperation ("reorderPlugin", "invalid_argument", "Missing trackId.", args, d);

    auto* track = findTrack (trackId);
    if (track == nullptr)
        return failOperation ("reorderPlugin", "not_found", "Track not found: " + trackId, args, d);
    if (from < 0 || from >= (int) track->plugins.size())
        return failOperation ("reorderPlugin", "invalid_argument", "Bad plugin index " + String (from) + ".", args, d);
    if (requestedTo < 0)
        return failOperation ("reorderPlugin", "invalid_argument", "Missing or invalid toIndex.", args, d);

    const int to = jlimit (0, (int) track->plugins.size() - 1, requestedTo);
    auto plugin = track->plugins[(size_t) from];
    track->plugins.erase (track->plugins.begin() + from);
    track->plugins.insert (track->plugins.begin() + to, plugin);

    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("reorderPlugin", args, pluginResultData (*track, track->plugins[(size_t) to], to), d);
}

var MaolanProcessBackend::setPluginParam (const var& args)
{
    ensureEvidenceDir();
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int pluginIndex = (int) args.getProperty ("index", -1);
    const int paramIndex = (int) args.getProperty ("paramIndex", -1);
    auto d = operationDiagnostics ("setPluginParam", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (trackId.isEmpty())
        return failOperation ("setPluginParam", "invalid_argument", "Missing trackId.", args, d);
    if (paramIndex < 0)
        return failOperation ("setPluginParam", "invalid_argument", "Missing or invalid paramIndex.", args, d);

    auto* track = findTrack (trackId);
    if (track == nullptr)
        return failOperation ("setPluginParam", "not_found", "Track not found: " + trackId, args, d);
    auto* plugin = findPlugin (*track, pluginIndex);
    if (plugin == nullptr)
        return failOperation ("setPluginParam", "not_found", "Plugin not found at index " + String (pluginIndex) + ".", args, d);

    auto& param = findOrCreatePluginParam (*plugin, paramIndex);
    param.value = jlimit (0.0, 1.0, (double) args.getProperty ("value", 0.0));

    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("setPluginParam", args, pluginResultData (*track, *plugin, pluginIndex), d);
}

var MaolanProcessBackend::bypassPlugin (const var& args)
{
    ensureEvidenceDir();
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int pluginIndex = (int) args.getProperty ("index", -1);
    auto d = operationDiagnostics ("bypassPlugin", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (trackId.isEmpty())
        return failOperation ("bypassPlugin", "invalid_argument", "Missing trackId.", args, d);

    auto* track = findTrack (trackId);
    if (track == nullptr)
        return failOperation ("bypassPlugin", "not_found", "Track not found: " + trackId, args, d);
    auto* plugin = findPlugin (*track, pluginIndex);
    if (plugin == nullptr)
        return failOperation ("bypassPlugin", "not_found", "Plugin not found at index " + String (pluginIndex) + ".", args, d);

    const bool bypassed = (bool) args.getProperty ("bypassed", false);
    plugin->enabled = ! bypassed;
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("bypassPlugin", args, pluginResultData (*track, *plugin, pluginIndex), d);
}

var MaolanProcessBackend::addAutomationPoint (const var& args)
{
    ensureEvidenceDir();
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int pluginIndex = (int) args.getProperty ("pluginIndex", args.getProperty ("index", -1));
    const int paramIndex = (int) args.getProperty ("paramIndex", -1);
    auto d = operationDiagnostics ("addAutomationPoint", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (trackId.isEmpty())
        return failOperation ("addAutomationPoint", "invalid_argument", "Missing trackId.", args, d);
    if (paramIndex < 0)
        return failOperation ("addAutomationPoint", "invalid_argument", "Missing or invalid paramIndex.", args, d);

    auto* track = findTrack (trackId);
    if (track == nullptr)
        return failOperation ("addAutomationPoint", "not_found", "Track not found: " + trackId, args, d);
    auto* plugin = findPlugin (*track, pluginIndex);
    if (plugin == nullptr)
        return failOperation ("addAutomationPoint", "not_found", "Plugin not found at index " + String (pluginIndex) + ".", args, d);

    auto& param = findOrCreatePluginParam (*plugin, paramIndex);
    SliceState::PluginParam::AutomationPoint point;
    point.time = jmax (0.0, (double) args.getProperty ("time", 0.0));
    point.value = jlimit (0.0, 1.0, (double) args.getProperty ("value", param.value));
    point.curve = (double) args.getProperty ("curve", 0.0);
    param.points.push_back (point);
    std::sort (param.points.begin(), param.points.end(),
               [] (const auto& a, const auto& b) { return a.time < b.time; });

    int pointIndex = 0;
    for (int i = 0; i < (int) param.points.size(); ++i)
        if (std::abs (param.points[(size_t) i].time - point.time) < 0.000001
            && std::abs (param.points[(size_t) i].value - point.value) < 0.000001)
            pointIndex = i;

    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("addAutomationPoint", args,
                            pluginParamAutomationData (*track, *plugin, pluginIndex, param, pointIndex), d);
}

var MaolanProcessBackend::removeAutomationPoint (const var& args)
{
    ensureEvidenceDir();
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int pluginIndex = (int) args.getProperty ("pluginIndex", args.getProperty ("index", -1));
    const int paramIndex = (int) args.getProperty ("paramIndex", -1);
    const int pointIndex = (int) args.getProperty ("pointIndex", -1);
    auto d = operationDiagnostics ("removeAutomationPoint", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (trackId.isEmpty())
        return failOperation ("removeAutomationPoint", "invalid_argument", "Missing trackId.", args, d);
    if (paramIndex < 0)
        return failOperation ("removeAutomationPoint", "invalid_argument", "Missing or invalid paramIndex.", args, d);

    auto* track = findTrack (trackId);
    if (track == nullptr)
        return failOperation ("removeAutomationPoint", "not_found", "Track not found: " + trackId, args, d);
    auto* plugin = findPlugin (*track, pluginIndex);
    if (plugin == nullptr)
        return failOperation ("removeAutomationPoint", "not_found", "Plugin not found at index " + String (pluginIndex) + ".", args, d);
    auto* param = findPluginParam (*plugin, paramIndex);
    if (param == nullptr)
        return failOperation ("removeAutomationPoint", "not_found", "Parameter not found: " + String (paramIndex), args, d);
    if (pointIndex < 0 || pointIndex >= (int) param->points.size())
        return failOperation ("removeAutomationPoint", "invalid_argument", "Invalid pointIndex: " + String (pointIndex), args, d);

    param->points.erase (param->points.begin() + pointIndex);
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("removeAutomationPoint", args,
                            pluginParamAutomationData (*track, *plugin, pluginIndex, *param, -1), d);
}

var MaolanProcessBackend::setAutomationPoint (const var& args)
{
    ensureEvidenceDir();
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int pluginIndex = (int) args.getProperty ("pluginIndex", args.getProperty ("index", -1));
    const int paramIndex = (int) args.getProperty ("paramIndex", -1);
    const int pointIndex = (int) args.getProperty ("pointIndex", -1);
    auto d = operationDiagnostics ("setAutomationPoint", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (trackId.isEmpty())
        return failOperation ("setAutomationPoint", "invalid_argument", "Missing trackId.", args, d);
    if (paramIndex < 0)
        return failOperation ("setAutomationPoint", "invalid_argument", "Missing or invalid paramIndex.", args, d);

    auto* track = findTrack (trackId);
    if (track == nullptr)
        return failOperation ("setAutomationPoint", "not_found", "Track not found: " + trackId, args, d);
    auto* plugin = findPlugin (*track, pluginIndex);
    if (plugin == nullptr)
        return failOperation ("setAutomationPoint", "not_found", "Plugin not found at index " + String (pluginIndex) + ".", args, d);
    auto* param = findPluginParam (*plugin, paramIndex);
    if (param == nullptr)
        return failOperation ("setAutomationPoint", "not_found", "Parameter not found: " + String (paramIndex), args, d);
    if (pointIndex < 0 || pointIndex >= (int) param->points.size())
        return failOperation ("setAutomationPoint", "invalid_argument", "Invalid pointIndex: " + String (pointIndex), args, d);

    auto& point = param->points[(size_t) pointIndex];
    point.time = jmax (0.0, (double) args.getProperty ("time", point.time));
    point.value = jlimit (0.0, 1.0, (double) args.getProperty ("value", point.value));
    point.curve = (double) args.getProperty ("curve", point.curve);

    const auto changedPoint = point;
    std::sort (param->points.begin(), param->points.end(),
               [] (const auto& a, const auto& b) { return a.time < b.time; });

    int newPointIndex = pointIndex;
    for (int i = 0; i < (int) param->points.size(); ++i)
        if (std::abs (param->points[(size_t) i].time - changedPoint.time) < 0.000001
            && std::abs (param->points[(size_t) i].value - changedPoint.value) < 0.000001)
            newPointIndex = i;

    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("setAutomationPoint", args,
                            pluginParamAutomationData (*track, *plugin, pluginIndex, *param, newPointIndex), d);
}

var MaolanProcessBackend::clearAutomation (const var& args)
{
    ensureEvidenceDir();
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int pluginIndex = (int) args.getProperty ("pluginIndex", args.getProperty ("index", -1));
    const int paramIndex = (int) args.getProperty ("paramIndex", -1);
    auto d = operationDiagnostics ("clearAutomation", 0.0, {}, {}, paths ({ state.sessionGraph }));
    if (trackId.isEmpty())
        return failOperation ("clearAutomation", "invalid_argument", "Missing trackId.", args, d);
    if (paramIndex < 0)
        return failOperation ("clearAutomation", "invalid_argument", "Missing or invalid paramIndex.", args, d);

    auto* track = findTrack (trackId);
    if (track == nullptr)
        return failOperation ("clearAutomation", "not_found", "Track not found: " + trackId, args, d);
    auto* plugin = findPlugin (*track, pluginIndex);
    if (plugin == nullptr)
        return failOperation ("clearAutomation", "not_found", "Plugin not found at index " + String (pluginIndex) + ".", args, d);
    auto* param = findPluginParam (*plugin, paramIndex);
    if (param == nullptr)
        return failOperation ("clearAutomation", "not_found", "Parameter not found: " + String (paramIndex), args, d);

    param->points.clear();
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("clearAutomation", args,
                            pluginParamAutomationData (*track, *plugin, pluginIndex, *param, -1), d);
}

var MaolanProcessBackend::setTransport (const var& args)
{
    ensureEvidenceDir();
    auto d = operationDiagnostics ("setTransport", 0.0, state.playbackStdout, state.playbackStderr,
                                  paths ({ state.sessionGraph, state.maolanSessionJson, state.playbackStats }));

    const auto action = args.getProperty ("action", args.getProperty ("state", var())).toString().toLowerCase();
    const bool wantsPlay = action == "play"
                           || (args.hasProperty ("playing") && (bool) args.getProperty ("playing", false));
    const bool wantsRecord = action == "record" || action == "recording";
    if (wantsRecord)
        return failOperation ("setTransport", "unsupported_by_backend",
                              "Maolan process backend does not expose record through MoshOps yet.",
                              args, d);

    if (wantsPlay)
    {
        const auto envFile = maolanEnvFile();
        if (! envFile.existsAsFile())
            return failOperation ("setTransport", "backend_unavailable",
                                  "Missing Maolan private env file: " + envFile.getFullPathName(), args, d);

        String sessionError;
        if (! writeMaolanSessionFolder (sessionError))
            return failOperation ("setTransport", "artifact_write_failed", sessionError, args, d);

        const double durationSeconds = jlimit (0.1, 10.0, (double) args.getProperty ("durationSeconds", 0.5));
        const auto playCommand =
            "source scripts/macos-build-env.sh"
            + String (" && maolan_cargo run --bin maolan-play-session-smoke -- --session-dir ")
            + shellQuote (state.maolanSessionDir.getFullPathName())
            + " --stats " + shellQuote (state.playbackStats.getFullPathName())
            + " --device " + shellQuote (state.device)
            + " --sample-rate 48000"
            + " --duration-seconds " + String (durationSeconds, 3)
            + " --timeout-seconds " + String (std::max (30, (int) args.getProperty ("timeoutSeconds", 900)));

        const auto shellBody =
            "set -a && source " + shellQuote (envFile.getFullPathName()) + " && set +a"
            + " && : \"${MAOLAN_APP_DIR:?MAOLAN_APP_DIR is required}\""
            + " && : \"${MAOLAN_ENGINE_LOCAL_DIR:?MAOLAN_ENGINE_LOCAL_DIR is required}\""
            + " && cd \"$MAOLAN_APP_DIR\""
            + " && export MAOLAN_SKIP_BREW_INSTALL=1"
            + " && export MAOLAN_ENGINE_LOCAL_DIR"
            + " && " + maolanLockedShellCommand (playCommand);

        const auto run = runShell ("setTransport", shellBody, state.playbackStdout, state.playbackStderr,
                                   std::max (30, (int) args.getProperty ("timeoutSeconds", 900)));
        d = operationDiagnostics ("setTransport", run.timingMs, state.playbackStdout, state.playbackStderr,
                                 paths ({ state.sessionGraph, state.maolanSessionJson, state.playbackStats }));

        const bool playbackStatsOk = state.playbackStats.existsAsFile();
        auto stats = playbackStatsOk ? JSON::parse (state.playbackStats.loadFileAsString()) : var();
        const bool statsReportPass = stats.getDynamicObject() != nullptr
                                     && stats.getProperty ("status", String()).toString() == "PASS";

        if (! run.ok && (run.timedOut || ! (playbackStatsOk && statsReportPass)))
            return failOperation ("setTransport", run.timedOut ? "process_timeout" : "process_failed",
                                  "Maolan playback smoke failed with exit code " + String (run.exitCode) + ".",
                                  args, d);

        if (! run.ok)
        {
            if (auto* o = d.getDynamicObject())
            {
                o->setProperty ("processExitCode", run.exitCode);
                o->setProperty ("processWarning", "maolan_cli_nonzero_after_valid_playback_artifacts");
            }
        }

        if (! playbackStatsOk)
            return failOperation ("setTransport", "missing_artifact",
                                  "Maolan playback stats missing: " + state.playbackStats.getFullPathName(), args, d);

        if (! (bool) stats.getProperty ("play_started", false) || ! (bool) stats.getProperty ("stop_confirmed", false))
            return failOperation ("setTransport", "backend_playback_failed",
                                  "Maolan playback stats did not confirm start/stop.", args, d);

        const auto stopped = stats.getProperty ("stopped", var());
        state.transportPosition = (double) stopped.getProperty ("transport_sample", 0) / 48000.0;
        state.transportPlaying = false;
        writeSessionGraphFile (state.sessionGraph);
        return finishOperation ("setTransport", args, objectWith ({
            { "playing", state.transportPlaying },
            { "position", state.transportPosition },
            { "state", "stopped" },
            { "playbackStats", state.playbackStats.getFullPathName() },
            { "playback", stats },
            { "sessionGraph", state.sessionGraph.getFullPathName() },
            { "maolanSessionDir", state.maolanSessionDir.getFullPathName() },
            { "maolanSessionJson", state.maolanSessionJson.getFullPathName() },
        }), d);
    }

    if (action == "to_start" || action == "rewind")
        state.transportPosition = 0.0;
    else if (args.hasProperty ("position"))
        state.transportPosition = (double) args.getProperty ("position", state.transportPosition);
    else if (args.hasProperty ("time"))
        state.transportPosition = (double) args.getProperty ("time", state.transportPosition);

    if (state.transportPosition < 0.0)
        return failOperation ("setTransport", "invalid_argument",
                              "Transport position must be non-negative.", args, d);

    state.transportPlaying = false;
    writeSessionGraphFile (state.sessionGraph);
    return finishOperation ("setTransport", args, objectWith ({
        { "playing", state.transportPlaying },
        { "position", state.transportPosition },
        { "state", "stopped" },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::renderExport (const var& args)
{
    ensureEvidenceDir();
    const auto envFile = maolanEnvFile();
    const bool renderSessionGraph = hasRenderableClips();
    const bool renderPluginGraph = renderSessionGraph && hasLoadedPlugins();
    const auto renderSource = renderSessionGraph
                                  ? (renderPluginGraph ? String ("maolan-offline-bounce")
                                                       : String ("maolan-session-export"))
                                  : String ("maolan-render-smoke");
    auto d = operationDiagnostics ("renderExport", 0.0, state.renderStdout, state.renderStderr,
                                  paths ({ state.renderWav, state.renderStats, state.maolanSessionJson }));

    if (! envFile.existsAsFile())
        return failOperation ("renderExport", "backend_unavailable",
                              "Missing Maolan private env file: " + envFile.getFullPathName(), args, d);

    if (renderSessionGraph)
    {
        String sessionError;
        if (! writeMaolanSessionFolder (sessionError))
            return failOperation ("renderExport", "artifact_write_failed", sessionError, args, d);
    }

    const auto exportBase = state.renderDir.getChildFile ("maolan-render-smoke").getFullPathName();
    const auto renderCommand =
        "source scripts/macos-build-env.sh"
        + (renderSessionGraph
               ? (" && maolan_cargo run --bin "
                  + (renderPluginGraph ? String ("maolan-export-session-bounced") : String ("maolan-export-session"))
                  + " -- --session-dir "
                  + shellQuote (state.maolanSessionDir.getFullPathName())
                  + " --export-base " + shellQuote (exportBase)
                  + " --stats " + shellQuote (state.renderStats.getFullPathName())
                  + (renderPluginGraph ? (" --device " + shellQuote (state.device)) : String())
                  + " --sample-rate 48000 --channels 2")
               : (" && maolan_cargo run --bin maolan-render-smoke -- --output-dir "
                  + shellQuote (state.renderDir.getFullPathName())));

    const auto shellBody =
        "set -a && source " + shellQuote (envFile.getFullPathName()) + " && set +a"
        + " && : \"${MAOLAN_APP_DIR:?MAOLAN_APP_DIR is required}\""
        + " && : \"${MAOLAN_ENGINE_LOCAL_DIR:?MAOLAN_ENGINE_LOCAL_DIR is required}\""
        + " && cd \"$MAOLAN_APP_DIR\""
        + " && export MAOLAN_SKIP_BREW_INSTALL=1"
        + " && export MAOLAN_ENGINE_LOCAL_DIR"
        + " && " + maolanLockedShellCommand (renderCommand);

    state.renderWav.deleteFile();
    state.renderStats.deleteFile();

    auto run = runShell ("renderExport", shellBody, state.renderStdout, state.renderStderr,
                         std::max (30, (int) args.getProperty ("timeoutSeconds", 900)));
    int renderAttempts = 1;

    auto renderArtifactsReportPass = [&]() -> bool
    {
        if (! (state.renderWav.existsAsFile() && state.renderWav.getSize() > 0 && state.renderStats.existsAsFile()))
            return false;

        const auto parsed = JSON::parse (state.renderStats.loadFileAsString());
        return parsed.getDynamicObject() != nullptr
               && parsed.getProperty ("status", String()).toString() == "PASS";
    };

    if (! run.ok && ! run.timedOut && ! renderArtifactsReportPass())
    {
        state.renderStdout.copyFileTo (state.outputDir.getChildFile ("render-attempt-1.stdout.log"));
        state.renderStderr.copyFileTo (state.outputDir.getChildFile ("render-attempt-1.stderr.log"));
        state.renderWav.deleteFile();
        state.renderStats.deleteFile();
        Thread::sleep (500);
        run = runShell ("renderExport", shellBody, state.renderStdout, state.renderStderr,
                        std::max (30, (int) args.getProperty ("timeoutSeconds", 900)));
        renderAttempts = 2;
    }

    d = operationDiagnostics ("renderExport", run.timingMs, state.renderStdout, state.renderStderr,
                             paths ({ state.renderWav, state.renderStats, state.maolanSessionJson }));
    if (auto* o = d.getDynamicObject())
        o->setProperty ("attempts", renderAttempts);

    const bool renderWavOk = state.renderWav.existsAsFile() && state.renderWav.getSize() > 0;
    const bool renderStatsOk = state.renderStats.existsAsFile();
    auto stats = renderStatsOk ? JSON::parse (state.renderStats.loadFileAsString()) : var();
    const bool statsReportPass = stats.getDynamicObject() != nullptr
                                 && stats.getProperty ("status", String()).toString() == "PASS";

    if (! run.ok && (run.timedOut || ! (renderWavOk && renderStatsOk && statsReportPass)))
        return failOperation ("renderExport", run.timedOut ? "process_timeout" : "process_failed",
                              (renderSessionGraph ? (String ("Maolan ") + renderSource + " failed with exit code ")
                                                  : "Maolan render smoke failed with exit code ")
                                  + String (run.exitCode) + ".", args, d);

    if (! run.ok)
    {
        if (auto* o = d.getDynamicObject())
        {
            o->setProperty ("processExitCode", run.exitCode);
            o->setProperty ("processWarning", "maolan_cli_nonzero_after_valid_render_artifacts");
        }
    }

    if (! renderWavOk)
        return failOperation ("renderExport", "missing_artifact",
                              "Maolan render WAV missing or empty: " + state.renderWav.getFullPathName(), args, d);
    if (! renderStatsOk)
        return failOperation ("renderExport", "missing_artifact",
                              "Maolan render stats missing: " + state.renderStats.getFullPathName(), args, d);

    state.renderRan = true;
    writeSessionGraphFile (state.sessionGraph);
    const auto reportedRenderSource = stats.getProperty ("render_source", renderSource).toString();
    return finishOperation ("renderExport", args, objectWith ({
        { "file", state.renderWav.getFullPathName() },
        { "statsPath", state.renderStats.getFullPathName() },
        { "stats", stats },
        { "renderSource", reportedRenderSource.isNotEmpty() ? reportedRenderSource : renderSource },
        { "maolanSessionDir", state.maolanSessionDir.getFullPathName() },
        { "maolanSessionJson", state.maolanSessionJson.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::saveSessionGraph (const var& args)
{
    ensureEvidenceDir();
    const auto file = File (args.getProperty ("file", state.sessionGraph.getFullPathName()).toString());
    auto d = operationDiagnostics ("saveSessionGraph", 0.0, {}, {},
                                  paths ({ file, state.persistenceMaolanSessionJson }));
    if (! writeSessionGraphFile (file))
        return failOperation ("saveSessionGraph", "artifact_write_failed",
                              "Could not write session graph: " + file.getFullPathName(), args, d);

    if (file != state.sessionGraph)
        file.copyFileTo (state.sessionGraph);

    String sessionError;
    if (! writeMaolanSessionFolderTo (state.persistenceMaolanSessionDir,
                                      state.persistenceMaolanSessionAudioDir,
                                      state.persistenceMaolanSessionJson,
                                      sessionError))
        return failOperation ("saveSessionGraph", "artifact_write_failed", sessionError, args, d);

    return finishOperation ("saveSessionGraph", args, objectWith ({
        { "file", file.getFullPathName() },
        { "maolanSessionDir", state.persistenceMaolanSessionDir.getFullPathName() },
        { "maolanSessionJson", state.persistenceMaolanSessionJson.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::restoreSessionGraph (const var& args)
{
    ensureEvidenceDir();
    const auto source = File (args.getProperty ("file", state.sessionGraph.getFullPathName()).toString());
    const auto dest = File (args.getProperty ("restoredFile", state.restoredSessionGraph.getFullPathName()).toString());
    auto d = operationDiagnostics ("restoreSessionGraph", 0.0, {}, {},
                                  paths ({ dest, state.sessionGraph, state.persistenceMaolanSessionJson }));

    if (! source.existsAsFile())
        return failOperation ("restoreSessionGraph", "missing_artifact",
                              "Session graph not found: " + source.getFullPathName(), args, d);
    if (! source.copyFileTo (dest))
        return failOperation ("restoreSessionGraph", "artifact_write_failed",
                              "Could not write restored graph: " + dest.getFullPathName(), args, d);

    const auto restored = JSON::parse (dest.loadFileAsString());
    if (restored.isVoid() || ! restored.isObject())
        return failOperation ("restoreSessionGraph", "invalid_session_graph",
                              "Restored graph is not valid JSON: " + dest.getFullPathName(), args, d);

    applySessionGraph (restored);
    if (! writeSessionGraphFile (state.sessionGraph))
        return failOperation ("restoreSessionGraph", "artifact_write_failed",
                              "Could not write restored session graph: " + state.sessionGraph.getFullPathName(), args, d);

    String sessionError;
    if (! writeMaolanSessionFolderTo (state.persistenceMaolanSessionDir,
                                      state.persistenceMaolanSessionAudioDir,
                                      state.persistenceMaolanSessionJson,
                                      sessionError))
        return failOperation ("restoreSessionGraph", "artifact_write_failed", sessionError, args, d);

    return finishOperation ("restoreSessionGraph", args, objectWith ({
        { "file", source.getFullPathName() },
        { "restoredFile", dest.getFullPathName() },
        { "restored", true },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
        { "maolanSessionDir", state.persistenceMaolanSessionDir.getFullPathName() },
        { "maolanSessionJson", state.persistenceMaolanSessionJson.getFullPathName() },
    }), d);
}

var MaolanProcessBackend::writeSummary()
{
    ensureEvidenceDir();
    auto renderStats = state.renderStats.existsAsFile() ? JSON::parse (state.renderStats.loadFileAsString()) : var();
    auto maolanSummaryFile = state.smokeDir.getChildFile ("summary.json");
    auto maolanSummary = maolanSummaryFile.existsAsFile() ? JSON::parse (maolanSummaryFile.loadFileAsString()) : var();

    const bool restoredEqual = state.sessionGraph.existsAsFile()
                               && state.restoredSessionGraph.existsAsFile()
                               && JSON::toString (JSON::parse (state.sessionGraph.loadFileAsString()), false)
                                  == JSON::toString (JSON::parse (state.restoredSessionGraph.loadFileAsString()), false);
    auto renderSource = renderStats.getProperty ("render_source", var()).toString();
    if (renderSource.isEmpty())
        renderSource = renderStats.getProperty ("session_dir", var()).isVoid()
                           ? String ("maolan-render-smoke")
                           : String ("maolan-session-export");

    auto artifacts = objectWith ({
        { "summary", state.summary.getFullPathName() },
        { "command_log", state.commandLog.getFullPathName() },
        { "timing_csv", state.timingCsv.getFullPathName() },
        { "render_wav", state.renderWav.getFullPathName() },
        { "render_stats", state.renderStats.getFullPathName() },
        { "session_graph", state.sessionGraph.getFullPathName() },
        { "restored_session_graph", state.restoredSessionGraph.getFullPathName() },
        { "clips_dir", state.clipsDir.getFullPathName() },
        { "maolan_stdout", state.maolanStdout.getFullPathName() },
        { "maolan_stderr", state.maolanStderr.getFullPathName() },
        { "render_stdout", state.renderStdout.getFullPathName() },
        { "render_stderr", state.renderStderr.getFullPathName() },
        { "playback_stdout", state.playbackStdout.getFullPathName() },
        { "playback_stderr", state.playbackStderr.getFullPathName() },
        { "playback_stats", state.playbackStats.getFullPathName() },
        { "maolan_session_dir", state.maolanSessionDir.getFullPathName() },
        { "maolan_session_json", state.maolanSessionJson.getFullPathName() },
        { "persistence_maolan_session_dir", state.persistenceMaolanSessionDir.getFullPathName() },
        { "persistence_maolan_session_json", state.persistenceMaolanSessionJson.getFullPathName() },
    });

    auto summary = objectWith ({
        { "status", "PASS" },
        { "backend", backendId() },
        { "device", state.device },
        { "plugin_path", state.pluginPath },
        { "track_count", static_cast<int> (state.tracks.size()) },
        { "clip_count", state.tracks.empty() ? 0 : static_cast<int> (state.tracks.front().clips.size()) },
        { "session_graph_restored", restoredEqual },
        { "maolanmosh_summary", maolanSummaryFile.getFullPathName() },
        { "maolanmosh_status", maolanSummary.getProperty ("status", var()).toString() },
        { "latest_gate_evidence", maolanSummary.getProperty ("latest_gate_evidence", var()).toString() },
        { "tracktion_comparison_csv", maolanSummary.getProperty ("tracktion_vst3_csv", var()).toString() },
        { "artifacts", artifacts },
        { "render", objectWith ({
            { "bytes", renderStats.getProperty ("bytes", var()) },
            { "duration_seconds", renderStats.getProperty ("duration_seconds", var()) },
            { "peak", renderStats.getProperty ("peak", var()) },
            { "rms", renderStats.getProperty ("rms", var()) },
            { "sample_rate", renderStats.getProperty ("sample_rate", var()) },
            { "frames", renderStats.getProperty ("frames", var()) },
            { "source", renderSource },
        }) },
        { "playback", state.playbackStats.existsAsFile()
                          ? JSON::parse (state.playbackStats.loadFileAsString())
                          : var (new DynamicObject()) },
    });

    state.summary.replaceWithText (JSON::toString (summary, true) + "\n");
    auto d = operationDiagnostics ("diagnostics", 0.0, {}, {}, paths ({ state.summary, state.commandLog }));
    appendCommandRecord ("diagnostics", objectWith ({{ "summary", state.summary.getFullPathName() }}), true, d);
    return summary;
}

var MaolanProcessBackend::runContractSlice (const var& args)
{
    auto result = createSession (args);
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = selectAudioDevice (objectWith ({{ "device", "coreaudio:default" }}));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = setTempo (objectWith ({{ "bpm", 137.5 }}));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = setTimeSignature (objectWith ({{ "numerator", 7 }, { "denominator", 8 }}));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = setMetronome (objectWith ({{ "enabled", true }}));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = setProjectSettings (objectWith ({{ "sampleRate", 96000.0 }, { "bitDepth", 16 }, { "timeBase", "barsBeats" }}));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = scanPlugins (objectWith ({
        { "format", "vst3" },
        { "fixture", fixturePlugin().getFullPathName() },
        { "timeoutSeconds", args.getProperty ("timeoutSeconds", 900) },
    }));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = createTrack (objectWith ({{ "trackId", "track-1" }, { "name", "Maolan Contract Track" }}));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = setTrackVolume (objectWith ({{ "trackId", "track-1" }, { "db", -3.0 }}));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = setTrackPan (objectWith ({{ "trackId", "track-1" }, { "pan", 0.25 }}));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = setTrackMute (objectWith ({{ "trackId", "track-1" }, { "mute", false }}));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = setTrackSolo (objectWith ({{ "trackId", "track-1" }, { "solo", false }}));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = addClip (objectWith ({
        { "trackId", "track-1" },
        { "clipId", "clip-1" },
        { "sourceKind", "test-tone" },
        { "name", "Maolan Tone Clip" },
        { "seconds", 2.0 },
        { "freq", 330.0 },
        { "start", 0.0 },
    }));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = getClipPeaks (objectWith ({{ "clipId", "clip-1" }, { "buckets", 64 }}));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = moveClip (objectWith ({{ "clipId", "clip-1" }, { "start", 0.25 }}));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = trimClip (objectWith ({{ "clipId", "clip-1" }, { "start", 0.25 }, { "length", 1.25 }, { "offset", 0.1 }}));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = renameClip (objectWith ({{ "clipId", "clip-1" }, { "name", "Maolan Edited Tone" }}));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = setClipGain (objectWith ({{ "clipId", "clip-1" }, { "gainDb", -2.5 }}));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = setClipMute (objectWith ({{ "clipId", "clip-1" }, { "mute", false }}));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = splitClip (objectWith ({{ "clipId", "clip-1" }, { "time", 0.75 }, { "newClipId", "clip-1-split" }}));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = duplicateClip (objectWith ({{ "clipId", "clip-1-split" }, { "newClipId", "clip-1-copy" }}));
    if (! (bool) result.getProperty ("ok", false)) return result;

    const auto* pasteSource = findClip ("clip-1-split");
    result = pasteClip (objectWith ({
        { "trackId", "track-1" },
        { "newClipId", "clip-1-paste" },
        { "start", 2.25 },
        { "clip", objectWith ({
            { "id", "clip-1-split" },
            { "type", "wave" },
            { "name", "Maolan Pasted Tone" },
            { "sourcePath", pasteSource != nullptr ? pasteSource->sourcePath : String() },
            { "length", pasteSource != nullptr ? pasteSource->lengthSeconds : 0.0 },
            { "offset", pasteSource != nullptr ? pasteSource->offsetSeconds : 0.0 },
            { "gainDb", pasteSource != nullptr ? pasteSource->gainDb : 0.0 },
            { "mute", pasteSource != nullptr ? pasteSource->mute : false },
        }) },
    }));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = addClip (objectWith ({
        { "trackId", "track-1" },
        { "clipId", "clip-1-delete" },
        { "sourceKind", "test-tone" },
        { "name", "Maolan Delete Range Tone" },
        { "seconds", 1.0 },
        { "freq", 440.0 },
        { "start", 3.0 },
    }));
    if (! (bool) result.getProperty ("ok", false)) return result;

    Array<var> deleteTrackIds;
    deleteTrackIds.add ("track-1");
    result = deleteTimeRange (objectWith ({
        { "start", 3.25 },
        { "end", 3.5 },
        { "trackIds", deleteTrackIds },
    }));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = loadPlugin (objectWith ({
        { "trackId", "track-1" },
        { "pluginId", "plugin-1" },
        { "pluginPath", fixturePlugin().getFullPathName() },
        { "timeoutSeconds", args.getProperty ("timeoutSeconds", 900) },
    }));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = setPluginParam (objectWith ({{ "trackId", "track-1" }, { "index", 0 }, { "paramIndex", 0 }, { "value", 0.42 }}));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = bypassPlugin (objectWith ({{ "trackId", "track-1" }, { "index", 0 }, { "bypassed", true }}));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = loadPlugin (objectWith ({
        { "trackId", "track-1" },
        { "pluginId", "plugin-remove-probe" },
        { "pluginPath", fixturePlugin().getFullPathName() },
        { "timeoutSeconds", args.getProperty ("timeoutSeconds", 900) },
    }));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = removePlugin (objectWith ({{ "trackId", "track-1" }, { "index", 1 }}));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = setTransport (objectWith ({
        { "action", "play" },
        { "durationSeconds", 0.5 },
        { "timeoutSeconds", args.getProperty ("timeoutSeconds", 900) },
    }));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = renderExport (objectWith ({{ "trackId", "track-1" }, { "timeoutSeconds", args.getProperty ("timeoutSeconds", 900) }}));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = saveSessionGraph (objectWith ({{ "file", state.sessionGraph.getFullPathName() }}));
    if (! (bool) result.getProperty ("ok", false)) return result;

    result = restoreSessionGraph (objectWith ({
        { "file", state.sessionGraph.getFullPathName() },
        { "restoredFile", state.restoredSessionGraph.getFullPathName() },
    }));
    if (! (bool) result.getProperty ("ok", false)) return result;

    auto summary = writeSummary();
    auto d = operationDiagnostics ("run_engine_contract_slice", 0.0, {}, {}, paths ({
        state.summary, state.commandLog, state.timingCsv, state.renderWav, state.renderStats,
        state.playbackStats, state.sessionGraph, state.restoredSessionGraph
    }));

    return makeEngineResult (backendId(), "run_engine_contract_slice", objectWith ({
        { "outputDir", state.outputDir.getFullPathName() },
        { "summaryPath", state.summary.getFullPathName() },
        { "summary", summary },
        { "commandLog", state.commandLog.getFullPathName() },
        { "timingCsv", state.timingCsv.getFullPathName() },
        { "renderWav", state.renderWav.getFullPathName() },
        { "renderStats", state.renderStats.getFullPathName() },
        { "playbackStats", state.playbackStats.getFullPathName() },
        { "sessionGraph", state.sessionGraph.getFullPathName() },
        { "restoredSessionGraph", state.restoredSessionGraph.getFullPathName() },
    }), d);
}

} // namespace mosh
