#include "MoshOps.h"
#include "DrumPattern.h"
#include "ExportRange.h"
#include "ScanProgress.h"
#include "StemExport.h"
#include "engine/SourceRef.h"
#include "engine/RenderArtifacts.h"
#include "state/Ids.h"
#include "state/RenderLayer.h"
#include "state/Migrations.h"
#include "state/CountIn.h"
#include "state/Section.h"
#include "state/Annotation.h"
#include "state/Lyrics.h"
#include "multiplayer/LogicalId.h"
#include "multiplayer/TrackCommit.h"
#include "plugins/moshfx/MoshFxPlugins.h"
#if MOSH_HAVE_ANIRA
 #include "plugins/transform/RaveInsertPlugin.h"
#endif
#include <thread>

namespace mosh
{
using namespace juce;

namespace
{
   #if MOSH_HAVE_ANIRA
    RaveInsertPlugin* asRave (te::Plugin* p) { return dynamic_cast<RaveInsertPlugin*> (p); }
   #endif

    // AL-008 — the id of the wave clip a render-layer landed on the "Neural Renders"
    // lane via accept_render. Stored on the MOSH_RENDERLAYER node so bypass_layer can
    // mute/un-mute THAT clip (the real audio re-route), not just flip a status flag.
    // File-local on purpose: this is a MoshOps mechanism detail, not a schema field in
    // src/state (the RenderLayer node is an open ValueTree; an extra string property is
    // round-trip-safe through save/load and ignored by the fingerprint).
    const juce::Identifier kLandedClipId ("landedClipId");

    // Phase 2 — discriminates the drum/MIDI "hidden audio beneath the MIDI" model from the
    // legacy "Neural Renders" lane landing. When true, the render-layer auto-applied beneath a
    // MIDI/drum clip: kLandedClipId is the HIDDEN audio clip (on the SAME track) and the source
    // MIDI clip was MUTED by us. Reset/remove use it to know to remove the hidden clip + un-mute
    // (vs the legacy lane, which never touches the source clip). File-local, round-trip-safe.
    const juce::Identifier kSourceMutedByLayer ("sourceMutedByLayer");

    bool lyricTextIsCompleteForSing (const juce::String& text)
    {
        const auto t = text.trim();
        if (t.isEmpty() || t.contains ("___"))
            return false;
        for (auto p = t.getCharPointer(); ! p.isEmpty(); ++p)
            if (juce::CharacterFunctions::isLetterOrDigit (*p))
                return true;
        return false;
    }

    bool lyricLineIsAssertedForSing (const juce::ValueTree& line)
    {
        return line.hasProperty (ids::lyricScore)
            && line[ids::status].toString() == "asserted"
            && lyricTextIsCompleteForSing (line[ids::lyricText].toString());
    }

    juce::String noAssertedWordsToSingMessage()
    {
        return juce::String (juce::CharPointer_UTF8 ("no asserted words to sing \xe2\x80\x94 assert the lyric line first"));
    }

    // Phase 3 — a one-shot lambda timer used for the per-clip reactive-render debounce. Calls fn ONCE
    // after the delay (it stops itself first), so each reactiveTouch just restarts it (coalescing a
    // burst of edits into a single re-render). Fires on the message thread (juce::Timer's thread).
    struct LambdaTimer : public juce::Timer
    {
        std::function<void()> fn;
        void timerCallback() override { stopTimer(); if (fn) fn(); }
    };

    // G14 — make a VolumeAndPanPlugin fader change UNDOABLE.
    //
    // vp->setVolumeDb()/setPan() route through the AutomatableParameter, whose
    // ValueTree writeback uses a NULL UndoManager (AttachedFloatValue::handleAsyncUpdate
    // -> CachedValue::setValue(.., nullptr)). So writing the fader inside a MoshOps
    // transaction produced an EMPTY transaction — undo restored nothing even though the
    // command logged undoable:true. A bare ValueTree write through the UndoManager would
    // record the property change, but on undo Tracktion deliberately refreshes only the
    // CachedValue and does NOT push the value back into the parameter's currentValue (the
    // atomic getVolumeDb()/getPan() — and thus snapshot() — read). So the parameter must
    // be replayed on perform/undo/redo, but without nesting another UndoManager action
    // while JUCE is already inside this UndoableAction. Tracktion's Mosh patch exposes
    // setParameterWithoutUndo for that replay path.
    struct SetFaderValueAction final : public juce::UndoableAction
    {
        SetFaderValueAction (te::VolumeAndPanPlugin& p, bool panNotVol, float newValue)
            : plugin (p), isPan (panNotVol), valueAfter (newValue),
              valueBefore (panNotVol ? p.getPan() : p.getVolumeDb()) {}

        bool perform() override     { apply (valueAfter);  return true; }
        bool undo() override        { apply (valueBefore); return true; }
        int  getSizeInUnits() override { return (int) sizeof (*this); }

        void apply (float v)
        {
            if (isPan)
            {
                if (v >= -0.005f && v <= 0.005f)
                    v = 0.0f;

                plugin.panParam->setParameterWithoutUndo (juce::jlimit (-1.0f, 1.0f, v),
                                                          juce::sendNotification);
            }
            else
            {
                plugin.volParam->setParameterWithoutUndo (juce::jlimit (0.0f, 1.0f,
                                                                         te::decibelsToVolumeFaderPosition (v)),
                                                          juce::sendNotification);
            }
        }

        te::VolumeAndPanPlugin& plugin;
        const bool  isPan;
        const float valueAfter;
        const float valueBefore;
    };

    // G10 — generalizes SetFaderValueAction (above) to ANY te::AutomatableParameter,
    // not just a VolumeAndPanPlugin's vol/pan pair. cmdSetPluginParam previously called
    // param->setParameter() directly, which is the SAME undo-broken path SetFaderValueAction
    // was built to fix: setParameter() -> setParameterValue(value, false, useUndoManager=true)
    // sets the ATOMIC currentValue member unconditionally, then separately writes the backing
    // ValueTree property through a real UndoManager (attachedValue->setValue). On undo, that
    // ValueTree-backed write correctly reverts the persisted property, but
    // AutomatableParameter::valueTreePropertyChanged deliberately does NOT resync currentValue
    // from it (the engine's own comment: "we shouldn't call attachedValue->updateParameterFromValue
    // here as this will set the base value of the parameter") — so getCurrentValue() /
    // getCurrentNormalisedValue() (what the snapshot's params[].value reads) stays STALE at the
    // pre-undo value. Replaying via setParameterWithoutUndo on both perform() and undo() (same as
    // SetFaderValueAction) keeps the atomic mirror and the persisted property in lockstep both
    // ways, with THIS action — not JUCE's built-in property-undo — owning the transaction.
    struct SetPluginParamValueAction final : public juce::UndoableAction
    {
        SetPluginParamValueAction (te::AutomatableParameter& p, float newValue)
            : param (p), valueAfter (newValue), valueBefore (p.getCurrentValue()) {}

        bool perform() override        { apply (valueAfter);  return true; }
        bool undo() override           { apply (valueBefore); return true; }
        int  getSizeInUnits() override { return (int) sizeof (*this); }

        void apply (float v)
        {
            param.setParameterWithoutUndo (param.getValueRange().clipValue (v), juce::sendNotification);
        }

        te::AutomatableParameter& param;
        const float valueAfter;
        const float valueBefore;
    };

    // Tracktion's compiled-in built-in plugin palette (registered unconditionally
    // by PluginManager). These ship inside the engine — no scan, no third-party
    // dependency — so the FX palette and built-in instruments are pure surface
    // work over the existing plugin command path. xmlTypeName strings are the
    // stable serialization ids createNewPlugin(type, {}) dispatches on.
    struct BuiltinSpec { const char* type; const char* name; const char* category; bool isInstrument; };
    static const BuiltinSpec kBuiltins[] = {
        { "4osc",         "4OSC Synth",            "Instrument", true  },
        { "sampler",      "Sampler",               "Instrument", true  },
        { "4bandEq",      "4-Band EQ",             "EQ",         false },
        { "compressor",   "Compressor",            "Dynamics",   false },
        { "reverb",       "Reverb",                "Reverb",     false },
        { "delay",        "Delay",                 "Delay",      false },
        { "chorus",       "Chorus",                "Modulation", false },
        { "phaser",       "Phaser",                "Modulation", false },
        { "lowpass",      "Low / High-Pass Filter","Filter",     false },
        { "pitchShifter", "Pitch Shifter",         "Pitch",      false },
        { "moshAutoTune", "Mosh AutoTune",         "Mosh FX",    false },
        { "moshOTT",      "Mosh OTT",              "Mosh FX",    false },
        { "moshXFeedback","Mosh X-FDBK",           "Mosh FX",    false },
    };

    const BuiltinSpec* findBuiltin (const juce::String& type)
    {
        for (auto& b : kBuiltins)
            if (type == b.type)
                return &b;
        return nullptr;
    }

    juce::var feedbackCandidatesToVar (const std::vector<moshfx::FeedbackCandidate>& candidates,
                                       bool includeDepth)
    {
        juce::Array<juce::var> arr;
        for (const auto& c : candidates)
        {
            auto* o = new juce::DynamicObject();
            o->setProperty ("frequencyHz", c.frequencyHz);
            o->setProperty ("score", c.score);
            if (includeDepth)
                o->setProperty ("depthDb", c.depthDb);
            arr.add (juce::var (o));
        }
        return juce::var (arr);
    }

    std::vector<float> readXFeedbackPreviewSamples (te::AudioTrack& track, double& sampleRate)
    {
        sampleRate = 0.0;
        for (auto* clip : track.getClips())
            if (auto* wave = dynamic_cast<te::WaveAudioClip*> (clip))
            {
                juce::AudioFormatManager fm;
                fm.registerBasicFormats();
                std::unique_ptr<juce::AudioFormatReader> reader (fm.createReaderFor (wave->getCurrentSourceFile()));
                if (reader == nullptr || reader->sampleRate <= 0.0 || reader->lengthInSamples <= 0)
                    continue;

                const int samples = juce::jlimit (0, 16384, (int) reader->lengthInSamples);
                juce::AudioBuffer<float> buffer (1, samples);
                if (! reader->read (&buffer, 0, samples, 0, true, true))
                    continue;

                sampleRate = reader->sampleRate;
                std::vector<float> out ((size_t) samples);
                std::copy (buffer.getReadPointer (0), buffer.getReadPointer (0) + samples, out.begin());
                return out;
            }

        return {};
    }

    juce::var xFeedbackPreviewReadout (te::AudioTrack& track, te::Plugin& plugin)
    {
        auto normParam = [&plugin] (int index, float fallback)
        {
            if (auto p = plugin.getAutomatableParameter (index))
                return p->getCurrentNormalisedValue();
            return fallback;
        };

        moshfx::XFeedbackSettings settings;
        settings.sensitivity = normParam (0, 0.65f);
        settings.maxCuts = juce::jlimit (1, 4, juce::roundToInt (1.0f + normParam (1, 1.0f / 3.0f) * 3.0f));
        settings.maxDepthDb = 3.0f + normParam (2, 15.0f / 33.0f) * 33.0f;
        settings.autoSuppress = normParam (4, 0.0f) >= 0.5f;

        double sampleRate = 0.0;
        auto samples = readXFeedbackPreviewSamples (track, sampleRate);
        auto candidates = moshfx::detectFeedbackCandidates (samples.data(), (int) samples.size(), sampleRate, settings);

        auto* o = new juce::DynamicObject();
        o->setProperty ("kind", "feedback");
        o->setProperty ("candidates", feedbackCandidatesToVar (candidates, false));
        o->setProperty ("activeCuts", settings.autoSuppress ? feedbackCandidatesToVar (candidates, true)
                                                            : juce::var (juce::Array<juce::var>()));
        return juce::var (o);
    }

    bool isGeneratedRecipeCommandAllowed (const juce::String& name)
    {
        return name == "set_tempo"
            || name == "set_key"
            || name == "set_time_signature"
            || name == "create_track"
            || name == "assign_sample"
            || name == "add_midi_clip"
            || name == "import_clip";
    }

    bool generatedRecipeRefName (const juce::String& value, juce::String& name)
    {
        if (value.startsWith ("${") && value.endsWithChar ('}') && value.length() > 3)
        {
            name = value.substring (2, value.length() - 1);
            return name.isNotEmpty();
        }
        return false;
    }

    juce::var resolveGeneratedRecipeRefs (const juce::var& value, const juce::NamedValueSet& refs,
                                          juce::StringArray& missing)
    {
        if (value.isString())
        {
            juce::String name;
            const auto s = value.toString();
            if (generatedRecipeRefName (s, name))
            {
                if (const auto* found = refs.getVarPointer (juce::Identifier (name)))
                    return *found;
                missing.add (s);
            }
            return value;
        }

        if (auto* arr = value.getArray())
        {
            juce::Array<juce::var> out;
            for (auto& item : *arr)
                out.add (resolveGeneratedRecipeRefs (item, refs, missing));
            return juce::var (out);
        }

        if (auto* obj = value.getDynamicObject())
        {
            auto* out = new juce::DynamicObject();
            auto& props = obj->getProperties();
            for (int i = 0; i < props.size(); ++i)
            {
                const auto name = props.getName (i);
                out->setProperty (name, resolveGeneratedRecipeRefs (props.getValueAt (i), refs, missing));
            }
            return juce::var (out);
        }

        return value;
    }

    void captureGeneratedRecipeRefs (const juce::var& call, const juce::var& result,
                                     juce::NamedValueSet& refs)
    {
        auto data = result.getProperty ("data", juce::var());
        if (! data.isObject())
            return;

        auto capture = call.getProperty ("capture", juce::var());
        if (auto* obj = capture.getDynamicObject())
        {
            auto& props = obj->getProperties();
            for (int i = 0; i < props.size(); ++i)
            {
                const auto name = props.getName (i);
                auto value = data.getProperty (props.getValueAt (i).toString(), juce::var());
                if (! value.isVoid())
                    refs.set (name, value);
            }
        }

        const auto bind = call.getProperty ("bind", juce::var()).toString();
        if (bind.isNotEmpty())
        {
            auto value = data.getProperty ("trackId", juce::var());
            if (value.isVoid()) value = data.getProperty ("clipId", juce::var());
            if (value.isVoid()) value = data.getProperty ("id", juce::var());
            if (! value.isVoid())
                refs.set (juce::Identifier (bind), value);
        }
    }

    // DRM-001 — the bundled default drum kit. Each pad is a synthesised one-shot
    // (resources/drumkits/mosh-kit, generated by generate_kit.py) mapped to the GM
    // percussion pitch the UI drum sequencer uses (ui/src/ui/drumGrid.ts →
    // DRUM_LANES). The pitches here MUST mirror DRUM_LANES exactly.
    struct DrumPad { const char* file; const char* name; int pitch; };
    // Row order mirrors DRUM_LANES exactly (so the indices line up 1:1, not just the
    // pitch set); the sampler still maps each pad by pitch, so order is cosmetic here.
    static const DrumPad kDefaultKit[] = {
        { "kick.wav",       "Kick",       36 },
        { "snare.wav",      "Snare",      38 },
        { "clap.wav",       "Clap",       39 },
        { "hat_closed.wav", "Closed Hat", 42 },
        { "hat_open.wav",   "Open Hat",   46 },
        { "tom_low.wav",    "Low Tom",    45 },
        { "tom_mid.wav",    "Mid Tom",    47 },
        { "crash.wav",      "Crash",      49 },
    };

    bool isSerumPlugin (te::ExternalPlugin& plugin)
    {
        const auto name = plugin.getName();
        const auto vendor = plugin.getVendor();
        const auto file = plugin.desc.fileOrIdentifier;
        return vendor == "Xfer Records"
               && (name == "Serum 2"
                   || name == "Serum 2 FX"
                   || file.containsIgnoreCase ("Serum2.vst3"));
    }

    void addExternalPluginMetadata (DynamicObject& o, te::ExternalPlugin& plugin)
    {
        o.setProperty ("manufacturer", plugin.getVendor());
        o.setProperty ("file", plugin.desc.fileOrIdentifier);
        o.setProperty ("identifier", te::createIdentifierString (plugin.desc));
        o.setProperty ("numInputs", plugin.getNumInputs());
        o.setProperty ("numOutputs", plugin.getNumOutputs());
        o.setProperty ("pluginInstanceLoaded", plugin.getAudioPluginInstance() != nullptr);
        o.setProperty ("isNonRealtime", plugin.getAudioPluginInstance() != nullptr
                                            && plugin.getAudioPluginInstance()->isNonRealtime());
    }

    // Downsample a reader to `buckets` [min,max] pairs for a waveform overview.
    // Shared by get_clip_peaks (clip source) and file_peaks (un-imported file).
    juce::Array<juce::var> bucketedPeaks (juce::AudioFormatReader& reader, int buckets)
    {
        const auto total = (juce::int64) reader.lengthInSamples;
        const int chans = (int) reader.numChannels;
        const juce::int64 perBucket = juce::jmax ((juce::int64) 1, total / juce::jmax (1, buckets));

        juce::Array<juce::var> peaks;
        juce::AudioBuffer<float> buf (juce::jmax (1, chans), (int) juce::jmin (perBucket, (juce::int64) 65536));
        for (int b = 0; b < buckets; ++b)
        {
            const juce::int64 startSample = (juce::int64) b * perBucket;
            if (startSample >= total) break;
            const int n = (int) juce::jmin (perBucket, total - startSample, (juce::int64) buf.getNumSamples());
            buf.clear();
            reader.read (&buf, 0, n, startSample, true, chans > 1);
            float mn = 0.0f, mx = 0.0f;
            for (int c = 0; c < buf.getNumChannels(); ++c)
            {
                auto r = juce::FloatVectorOperations::findMinAndMax (buf.getReadPointer (c), n);
                mn = juce::jmin (mn, r.getStart());
                mx = juce::jmax (mx, r.getEnd());
            }
            juce::Array<juce::var> pair; pair.add (mn); pair.add (mx);
            peaks.add (juce::var (pair));
        }
        return peaks;
    }

    String findSerumRealtimeRenderReason (te::Edit& edit)
    {
        for (auto* track : te::getAudioTracks (edit))
            for (auto* plugin : track->pluginList.getPlugins())
                if (auto* ext = dynamic_cast<te::ExternalPlugin*> (plugin))
                    if (ext->isEnabled() && isSerumPlugin (*ext))
                        return "Serum compatibility: " + ext->getName();

        return {};
    }

    constexpr int kCommandLogInspectorMaxEntries = 500;

    bool looksLikeCommandLogRecord (const juce::String& line)
    {
        const auto t = line.trim();
        return t.startsWithChar ('{')
               && t.endsWithChar ('}')
               && t.contains ("\"ts\"")
               && t.contains ("\"seq\"")
               && t.contains ("\"command\"")
               && t.contains ("\"ok\"")
               && t.contains ("\"undoable\"");
    }

    juce::var makeCommandLogInspectorEntry (const juce::var& parsed)
    {
        if (! parsed.isObject())
            return {};

        auto* o = new juce::DynamicObject();
        o->setProperty ("ts",       parsed.getProperty ("ts", juce::var()));
        o->setProperty ("seq",      parsed.getProperty ("seq", juce::var()));
        o->setProperty ("command",  parsed.getProperty ("command", juce::var()));
        o->setProperty ("ok",       (bool) parsed.getProperty ("ok", false));
        o->setProperty ("undoable", (bool) parsed.getProperty ("undoable", false));
        if (parsed.hasProperty ("error"))
            o->setProperty ("error", parsed.getProperty ("error", juce::var()));
        return juce::var (o);
    }
}

MoshOps::MoshOps (MoshEngine& engineToUse)
    : eng (engineToUse), pluginHost (engineToUse.engine()),
      trainerRegistry (engineToUse.sessionDir())
{
    logFile = eng.sessionDir().getChildFile ("mosh-log.jsonl");
    invalidateCommandLogCache();
    initRecoveryJournal();                    // A3 — read a crashed tail into memory, then start fresh
    pluginHost.initialise();                 // formats + curated VST3 scan
    previewFormats.registerBasicFormats();   // audition (file preview) reader formats
    startTimerHz (30);                       // telemetry decimated to 30 Hz, never per-block

    // MP-001 — the live session. Its background poll loop calls back here (on the
    // message thread) to apply peer commits, feed the lock guard, and push presence
    // to the WebView. No relay echo: a remote apply repaints locally only.
    mpSession_ = std::make_unique<MultiplayerSession> (
        [this] (const juce::var& msg) { applyMultiplayerCommitMessage (msg); },
        [this] (const juce::String& type, juce::var payload) { emit (type, payload); },
        [this] (bool active, const juce::String& self, const std::map<juce::String, juce::String>& locks)
        {
            if (active) { lockManager_.activate (self); lockManager_.setLocks (locks); }
            else        { lockManager_.deactivate(); }
        },
        // PR-2: the message-thread part ONLY (content-address + serialize; NO
        // upload) -- the session's own worker uploads the returned stemFiles[]
        // before publishing bootstrap_state. cmdMpSerializeProject (the public,
        // directly-callable command) is UNCHANGED and keeps uploading synchronously
        // itself, so existing direct-call tests stay valid.
        [this] { return serializeProjectForBootstrapAnswer(); },   // provide
        [this] (const juce::var& bundle) { cmdMpApplyBootstrap (bundle); },             // adopt
        [this] (const juce::var& msg) { cmdMpApplyStructural (msg); });                 // structural
    refreshMpStemDir();
}

void MoshOps::applyMultiplayerCommitForSelfTest (const juce::var& msg)
{
    applyMultiplayerCommitMessage (msg);
}

// PR-2: MultiplayerSession's stemBaseDir_ (worker-thread-only, mutex-guarded) must
// be refreshed from the message thread whenever eng.editFile() can change (a fresh
// project, an open, a Save As) or a session starts — the worker must NEVER call
// eng.editFile() itself (same torn-refcount reasoning as MultiplayerClient.h's
// roomCode_/etc: a juce::String is refcounted, so an unsynchronized cross-thread
// read/write is a crash risk, not just staleness).
void MoshOps::refreshMpStemDir()
{
    if (mpSession_ != nullptr)
        mpSession_->setStemBaseDir (eng.editFile().getParentDirectory().getFullPathName());
}

void MoshOps::applyMultiplayerCommitMessage (const juce::var& msg)
{
    // PR-2: the session's transfer worker has ALREADY prefetched every audioRef this
    // commit carries (routeStateMutatingJob's prefetch stage, before this apply stage
    // runs) — no download loop needed here anymore. applyMultiplayerCommitForSelfTest
    // calling this directly (bypassing the session/worker) therefore no longer
    // downloads stems either; a future direct-callback test needs its own prefetch
    // (mirroring what the session does) or should drive the download separately first.
    auto* applyArgs = new DynamicObject();
    applyArgs->setProperty ("blob", msg.getProperty ("blob", var()));
    auto* command = new DynamicObject();
    command->setProperty ("command", "apply_remote_track");
    command->setProperty ("args", var (applyArgs));
    auto applied = execute (var (command));
    if ((bool) applied.getProperty ("ok", false))
        emitSnapshotInvalidated();
}

MoshOps::~MoshOps()
{
    stopTimer();
    unregisterAllMeterClients();       // balances addClient() for the per-track meter taps only —
                                        // masterClient is a separate registration (see below)
    // masterClient (line ~736's ctx->masterLevels.addClient) is never balanced by the
    // per-track path above. Main.cpp's shutdown() destroys MoshOps BEFORE the engine
    // (moshOps.reset() precedes engine.reset()), so if a playback context is still
    // live here (quit-while-playing), its master LevelMeasurer keeps a raw pointer to
    // masterClient — which is about to be freed with the rest of `this`. The audio
    // thread would then write through that dangling pointer on the next block. Mirror
    // the addClient bookkeeping (lastSeenContext tracks exactly the context we last
    // registered with, and is nulled out everywhere the context is freed) to remove it
    // here while the context — and `this` — are both still valid.
    if (lastSeenContext != nullptr)
    {
        lastSeenContext->masterLevels.removeClient (masterClient);
        lastSeenContext = nullptr;
    }
    if (previewWired) adm().removeAudioCallback (&previewPlayer);   // stop audio-thread access first
    stopAudition();
}

void MoshOps::invalidateCommandLogCache()
{
    const juce::ScopedLock sl (commandLogCacheLock_);
    commandLogRecentEntries_.clearQuick();
    commandLogTotal_ = 0;
    commandLogBytes_ = -1;
    commandLogPath_.clear();
    commandLogCachePrimed_ = false;
}

void MoshOps::refreshCommandLogCacheIfNeeded (const juce::File& file)
{
    const auto filePath = file.getFullPathName();
    const auto fileBytes = file.existsAsFile() ? file.getSize() : 0;
    const juce::ScopedLock sl (commandLogCacheLock_);

    if (commandLogCachePrimed_ && commandLogPath_ == filePath && commandLogBytes_ == fileBytes)
        return;

    commandLogRecentEntries_.clearQuick();
    commandLogTotal_ = 0;
    commandLogBytes_ = fileBytes;
    commandLogPath_ = filePath;
    commandLogCachePrimed_ = true;

    if (! file.existsAsFile())
        return;

    if (auto stream = file.createInputStream())
    {
        while (! stream->isExhausted())
        {
            const auto line = stream->readNextLine().trim();
            if (! looksLikeCommandLogRecord (line))
                continue;

            ++commandLogTotal_;

            juce::var parsed;
            if (juce::JSON::parse (line, parsed).failed())
                continue;

            auto entry = makeCommandLogInspectorEntry (parsed);
            if (! entry.isObject())
                continue;

            commandLogRecentEntries_.add (entry);
            if (commandLogRecentEntries_.size() > kCommandLogInspectorMaxEntries)
                commandLogRecentEntries_.remove (0);
        }
    }
}

// ── Metering helpers (Wave 9) ────────────────────────────────────────────────
te::LevelMeterPlugin* MoshOps::findTrackMeter (te::AudioTrack& t)
{
    for (auto* p : t.pluginList.getPlugins())
        if (auto* m = dynamic_cast<te::LevelMeterPlugin*> (p))
            return m;
    return nullptr;
}

te::LevelMeterPlugin* MoshOps::ensureTrackMeter (te::AudioTrack& t)
{
    if (auto* lm = findTrackMeter (t)) return lm;
    auto plugin = eng.edit().getPluginCache().createNewPlugin (te::LevelMeterPlugin::xmlTypeName, {});
    if (plugin == nullptr) return nullptr;
    auto* lm = dynamic_cast<te::LevelMeterPlugin*> (plugin.get());
    t.pluginList.insertPlugin (plugin, t.pluginList.getPlugins().size(), nullptr);   // append → post-fader
    return lm;                                                // client is wired by reconcileMeterClients()
}

// Sync the client map to the LIVE meter taps in the edit. Robust against undo/
// redo/remove destroying a meter plugin: we only ever read our OWN Client (alive),
// never a stale measurer. A tap whose track no longer has a meter is dropped
// WITHOUT removeClient (its measurer is already gone); a fresh meter gets a client
// added to its (live) measurer. Called every frame before reading levels.
void MoshOps::reconcileMeterClients()
{
    std::map<juce::String, te::LevelMeterPlugin*> live;
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr)
            if (auto* lm = findTrackMeter (*t))
                live[t->itemID.toString()] = lm;

    for (auto it = meterClients.begin(); it != meterClients.end();)
    {
        if (live.find (it->first) == live.end())
            it = meterClients.erase (it);                    // plugin gone (undo/remove) — drop, no removeClient
        else
            ++it;
    }
    for (auto& [id, lm] : live)
    {
        auto& slot = meterClients[id];
        if (slot == nullptr) slot = std::make_unique<MeterTap>();
        if (slot->plugin != lm)                              // new / replaced instance — (re)register our client
        {
            slot->plugin = lm;
            lm->measurer.addClient (slot->client);
        }
    }
}

void MoshOps::unregisterAllMeterClients()
{
    // Detach our clients, but ONLY from measurers that are still live — a track
    // removed since the last reconcile leaves a stale plugin pointer we must not
    // deref. Build the live set and match by value.
    juce::Array<te::LevelMeterPlugin*> live;
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr)
            if (auto* lm = findTrackMeter (*t))
                live.add (lm);
    for (auto& [id, tap] : meterClients)
        if (tap != nullptr && tap->plugin != nullptr && live.contains (tap->plugin))
            tap->plugin->measurer.removeClient (tap->client);
    meterClients.clear();
}

// ── master spectral feed (Moshi reactivity) ──────────────────────────────────
MasterSpectralTapPlugin* MoshOps::findMasterSpectralTap()
{
    for (auto* p : eng.edit().getMasterPluginList().getPlugins())
        if (auto* t = dynamic_cast<MasterSpectralTapPlugin*> (p))
            return t;
    return nullptr;
}

MasterSpectralTapPlugin* MoshOps::ensureMasterSpectralTap()
{
    if (auto* t = findMasterSpectralTap()) return t;
    auto plugin = eng.edit().getPluginCache().createNewPlugin (MasterSpectralTapPlugin::xmlTypeName, {});
    if (plugin == nullptr) return nullptr;
    auto* t = dynamic_cast<MasterSpectralTapPlugin*> (plugin.get());
    auto& list = eng.edit().getMasterPluginList();
    list.insertPlugin (plugin, list.getPlugins().size(), nullptr);   // append → taps the final master output
    return t;
}

// Drain the tap (message thread), window + Goertzel into 12 log-spaced bands +
// overall level + spectral flux, and emit the `spectrum` event (mirrors `levels`).
void MoshOps::emitSpectrum (bool playing)
{
    if (! playing)
    {
        Array<var> z; for (int b = 0; b < 12; ++b) z.add (0.0f);
        spectralPrevBands.fill (0.0f);
        auto* zp = new DynamicObject(); zp->setProperty ("bands", z); zp->setProperty ("level", 0.0f); zp->setProperty ("flux", 0.0f);
        emit ("spectrum", var (zp));
        return;
    }

    auto* tap = ensureMasterSpectralTap();
    if (tap == nullptr) return;

    float scratch[2048];
    const int got = tap->read (scratch, 2048);
    for (int i = 0; i < got; ++i) { spectralRing[(size_t) spectralRingPos] = scratch[i]; if (++spectralRingPos >= 1024) spectralRingPos = 0; }

    float win[1024];
    double sumsq = 0.0;
    for (int i = 0; i < 1024; ++i)
    {
        const int idx = (spectralRingPos + i) & 1023;
        const float wnd = 0.5f - 0.5f * std::cos (juce::MathConstants<float>::twoPi * (float) i / 1023.0f);
        const float s = spectralRing[(size_t) idx] * wnd;
        win[i] = s; sumsq += (double) s * (double) s;
    }
    const float levelDb = 20.0f * std::log10 ((float) std::sqrt (sumsq / 1024.0) + 1e-9f);
    const float level = juce::jlimit (0.0f, 1.0f, (levelDb + 60.0f) / 60.0f);

    const double sr = tap->getSampleRate() > 0.0 ? tap->getSampleRate() : 48000.0;
    static const float centers[12] = { 55, 80, 120, 180, 260, 380, 550, 800, 1200, 2000, 3500, 7000 };
    Array<var> bandsVar; float flux = 0.0f;
    for (int b = 0; b < 12; ++b)
    {
        const float f = centers[b] / (float) sr;
        float nb = 0.0f;
        if (f < 0.5f)
        {
            const double w = juce::MathConstants<double>::twoPi * (double) f;
            const double coeff = 2.0 * std::cos (w);
            double sp = 0.0, sp2 = 0.0;
            for (int i = 0; i < 1024; ++i) { const double s = (double) win[i] + coeff * sp - sp2; sp2 = sp; sp = s; }
            const double power = sp2 * sp2 + sp * sp - coeff * sp * sp2;
            const double mag = std::sqrt (juce::jmax (0.0, power)) / 512.0;
            const float db = 20.0f * std::log10 ((float) mag + 1e-9f);
            nb = juce::jlimit (0.0f, 1.0f, (db + 66.0f) / 60.0f);
        }
        flux += juce::jmax (0.0f, nb - spectralPrevBands[(size_t) b]);
        spectralPrevBands[(size_t) b] = nb;
        bandsVar.add (nb);
    }
    flux = juce::jlimit (0.0f, 1.0f, flux / 3.0f);

    auto* p = new DynamicObject();
    p->setProperty ("bands", bandsVar);
    p->setProperty ("level", level);
    p->setProperty ("flux", flux);
    emit ("spectrum", var (p));
}

void MoshOps::timerCallback()
{
    // Push a decimated transport delta while playing (and once on the
    // play-to-stop edge) so the UI playhead animates without polling (02 §4.2).
    auto& transport = eng.edit().getTransport();
    const bool playing = transport.isPlaying();
    if (playing || wasPlaying)
        emit ("transport", transportToVar());
    wasPlaying = playing;

    // Lane A — drive the render-ahead scheduler off the transport clock while a Live clip plays.
    // Gated on hasAudio() so headless --selftest (which never arms it) is untouched.
    if (renderAhead_.active && playing && eng.hasAudio())
        renderAheadTick (transport.getPosition().inSeconds());

    if (mpSession_ != nullptr && mpSession_->active())
    {
        const auto nowMs = Time::getMillisecondCounterHiRes();
        if (nowMs - lastPresenceBroadcastMs >= 250.0)
        {
            lastPresenceBroadcastMs = nowMs;
            mpSession_->broadcastPresence (transport.getPosition().inSeconds(),
                                           transport.isPlaying(),
                                           transport.isRecording());
        }
    }

    // Decimated level meters (Wave 9). Reconcile first (undo/redo-safe), then each
    // client reports the peak since the last read (getAndClear resets to -100);
    // master comes from the playback context's measurer (null headless → -100).
    reconcileMeterClients();
    if (! meterClients.empty())
    {
        Array<var> trackLevels;
        for (auto& [trackId, tap] : meterClients)
        {
            if (tap == nullptr) continue;
            const float l = tap->client.getAndClearAudioLevel (0).dB;
            const int chans = tap->client.getNumChannelsUsed();
            const float r = chans >= 2 ? tap->client.getAndClearAudioLevel (1).dB : l;
            auto* o = new DynamicObject();
            o->setProperty ("id", trackId);
            o->setProperty ("l", l);
            o->setProperty ("r", r);
            trackLevels.add (var (o));
        }

        float ml = -100.0f, mr = -100.0f;
        if (auto* ctx = transport.getCurrentPlaybackContext())
        {
            if (ctx != lastSeenContext) { ctx->masterLevels.addClient (masterClient); lastSeenContext = ctx; }
            ml = masterClient.getAndClearAudioLevel (0).dB;
            mr = masterClient.getAndClearAudioLevel (1).dB;
        }
        else
            lastSeenContext = nullptr;

        auto* master = new DynamicObject(); master->setProperty ("l", ml); master->setProperty ("r", mr);
        auto* payload = new DynamicObject();
        payload->setProperty ("tracks", trackLevels);
        payload->setProperty ("master", var (master));
        emit ("levels", var (payload));
    }

    // Master spectral feed (Moshi reactivity). Only live with a real playback context
    // (an audio device) — headless / --selftest has none, so the tap is NEVER inserted
    // and the edit state is untouched. One zero on the play→stop edge so Moshi settles.
    const bool spectrumLive = playing && transport.getCurrentPlaybackContext() != nullptr;
    if (spectrumLive)            { emitSpectrum (true);  spectrumActive = true; }
    else if (spectrumActive)     { emitSpectrum (false); spectrumActive = false; }

    // FIT-003 — live running-count progress for an in-flight async plugin rescan.
    // cmdRescanPlugins' AU/deep branch sets scanSampling_ before spawning its detached
    // scan thread and clears it in that thread's callAsync completion; both of those
    // run on the message thread, same as this timer, so scanSampling_/scanFormat_/
    // scanStartMs_/lastScanCount_/lastScanEmitMs_ (all MoshOps-private) need no
    // synchronization. getNumTypes() itself IS a genuine cross-thread read: the
    // background scan thread concurrently mutates the SAME KnownPluginList via
    // addType()/scanAndAddFile() inside PluginHost::rescan(). That's safe because
    // KnownPluginList internally guards its type array with its own CriticalSection
    // (typesArrayLock in juce_KnownPluginList.h) — getNumTypes()/addType() both take
    // it, so this is an ordinary locked read, not a race. Decimated: emit only when
    // the catalog grew, or ~500 ms have passed, so a fast VST3 tail doesn't spam 30 Hz
    // and a stalled AU still ticks `elapsedMs` forward for the UI.
    if (scanSampling_)
    {
        const auto now = Time::getMillisecondCounterHiRes();
        const int count = eng.engine().getPluginManager().knownPluginList.getNumTypes();
        if (count != lastScanCount_ || (now - lastScanEmitMs_) >= 500.0)
        {
            lastScanCount_ = count;
            lastScanEmitMs_ = now;
            emit ("plugin_scan_progress",
                  makeScanProgressPayload (scanFormat_, count, /*done=*/false,
                                            (int) (now - scanStartMs_)));
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::execute (const juce::var& command)
{
    auto result = executeImpl (command);
    // A3 — feed the crash-recovery journal (single chokepoint; skipped during a replay).
    if (! replayingRecovery_)
        appendRecoveryJournal (command.getProperty ("command", var()).toString(),
                               command.getProperty ("args", var()), result);
    return result;
}

juce::var MoshOps::executeImpl (const juce::var& command)
{
    const auto name = command.getProperty ("command", var()).toString();
    const auto args = command.getProperty ("args", var (new DynamicObject()));

    if (name.isEmpty())
        return errResult (name, "missing 'command'");

    // MP-001 lock guard — the single chokepoint. When a multiplayer session is
    // active, reject any mutation to a track / clip / structure currently locked by
    // the OTHER peer (fail-closed: unclassified commands need the session lock).
    // No session => no-op, so single-player behaviour is unchanged. A REMOTE apply
    // (applyingRemote_) bypasses the guard — it is the peer's change landing, not a
    // local edit, so it must not be blocked by the peer's own lock.
    if (lockManager_.isActive() && ! applyingRemote_)
    {
        const auto scope = LockManager::classify (name);
        if (scope != LockManager::Scope::Unguarded)
        {
            const auto decision = lockManager_.decide (scope, lockKeyFor (scope, args));
            if (! decision.allow)
                return errResult (name, "blocked: " + decision.reason);
        }
    }

    if (name == "create_track")      return cmdCreateTrack (args);
    if (name == "rename_track")      return cmdRenameTrack (args);
    if (name == "create_section")    return cmdCreateSection (args);
    if (name == "rename_section")    return cmdRenameSection (args);
    if (name == "move_section")      return cmdMoveSection (args);
    if (name == "remove_section")    return cmdRemoveSection (args);
    // LYR-001 — Finish-My-Song lyric sheet (per-track).
    if (name == "create_lyric_sheet")   return cmdCreateLyricSheet (args);
    if (name == "remove_lyric_sheet")   return cmdRemoveLyricSheet (args);
    if (name == "set_lyric_constraint") return cmdSetLyricConstraint (args);
    if (name == "set_lyric_line")       return cmdSetLyricLine (args);
    if (name == "remove_lyric_line")    return cmdRemoveLyricLine (args);
    if (name == "get_rhymes")           return cmdGetRhymes (args);
    if (name == "complete_lyrics")      return cmdCompleteLyrics (args);
    if (name == "fill_lyric_gap")       return cmdFillLyricGap (args);
    if (name == "suggest_next_line")    return cmdSuggestNextLine (args);
    if (name == "regenerate_lyric")     return cmdRegenerateLyric (args);
    if (name == "cancel_lyric_job")     return cmdCancelLyricJob (args);
    if (name == "accept_lyric_proposal") return cmdAcceptLyricProposal (args);
    if (name == "assert_lyric_line")    return cmdAssertLyricLine (args);
    if (name == "reject_lyric_proposal") return cmdRejectLyricProposal (args);
    if (name == "analyze_lyrics")       return cmdAnalyzeLyrics (args);
    if (name == "get_lyric_corpus_stats") return cmdGetLyricCorpusStats (args);
    if (name == "build_lyrics_from_clip") return cmdBuildLyricsFromClip (args);
    if (name == "build_skeleton_from_clip") return cmdBuildSkeletonFromClip (args);
    if (name == "confirm_skeleton")     return cmdConfirmSkeleton (args);
    // Annotations broadcast over MP (shared collaborator comments). create self-broadcasts
    // its resolved cross-peer id; the rest address by that id via the generic wrapper.
    if (name == "create_annotation") return cmdCreateAnnotation (args);
    if (name == "edit_annotation")   return broadcastStructuralIfActive (name, args, cmdEditAnnotation (args));
    if (name == "move_annotation")   return broadcastStructuralIfActive (name, args, cmdMoveAnnotation (args));
    if (name == "remove_annotation") return broadcastStructuralIfActive (name, args, cmdRemoveAnnotation (args));
    if (name == "remove_track")      return cmdRemoveTrack (args);
    if (name == "import_clip")       return cmdImportClip (args);
    if (name == "import_clip_data")  return cmdImportClipData (args);
    if (name == "add_test_tone_clip")return cmdAddTestTone (args);
    if (name == "set_transport")     return cmdSetTransport (args);
    if (name == "set_tempo")         return broadcastStructuralIfActive (name, args, cmdSetTempo (args));
    if (name == "set_time_signature")return broadcastStructuralIfActive (name, args, cmdSetTimeSignature (args));
    if (name == "set_metronome")     return broadcastStructuralIfActive (name, args, cmdSetMetronome (args));
    if (name == "undo")              return cmdUndo (args);
    if (name == "redo")              return cmdRedo (args);
    if (name == "batch_begin")       return cmdBatchBegin (args);
    if (name == "batch_end")         return cmdBatchEnd (args);
    if (name == "save")              return cmdSave (args);
    if (name == "reload")            return cmdReload (args);
    if (name == "recover_session")   return cmdRecoverSession (args);   // A3 — replay the crash tail
    if (name == "discard_recovery")  return cmdDiscardRecovery (args);  // A3 — drop the crash tail
    if (name == "add_render_layer")  return cmdAddRenderLayer (args);
    if (name == "move_clip")         return cmdMoveClip (args);
    if (name == "trim_clip")         return cmdTrimClip (args);
    if (name == "split_clip")        return cmdSplitClip (args);
    if (name == "remove_clip")       return cmdRemoveClip (args);
    if (name == "rename_clip")       return cmdRenameClip (args);
    if (name == "set_clip_mute")     return cmdSetClipMute (args);
    if (name == "set_clip_gain")     return cmdSetClipGain (args);
    if (name == "set_clip_fade")     return cmdSetClipFade (args);
    if (name == "relink_clip")       return cmdRelinkClip (args);
    if (name == "set_clip_warp")     return cmdSetClipWarp (args);
    if (name == "stretch_clip")      return cmdStretchClip (args);
    if (name == "detect_clip_bpm")   return cmdDetectClipBpm (args);
    if (name == "duplicate_clip")    return cmdDuplicateClip (args);
    if (name == "delete_time_range") return cmdDeleteTimeRange (args);
    if (name == "paste_clip")        return cmdPasteClip (args);
    if (name == "set_track_volume")  return cmdSetTrackVolume (args);
    if (name == "set_track_pan")     return cmdSetTrackPan (args);
    if (name == "set_track_mute")    return cmdSetTrackMute (args);
    if (name == "set_track_solo")    return cmdSetTrackSolo (args);
    if (name == "arm_track")         return cmdArmTrack (args);
    if (name == "stop_recording")    return cmdStopRecording (args);
    if (name == "set_input_monitor") return cmdSetInputMonitor (args);
    if (name == "list_takes")        return cmdListTakes (args);
    if (name == "set_current_take")  return cmdSetCurrentTake (args);
    if (name == "keep_take")         return cmdKeepTake (args);
    if (name == "mark_take")         return cmdMarkTake (args);
    if (name == "set_master_volume") return broadcastStructuralIfActive (name, args, cmdSetMasterVolume (args));
    if (name == "set_master_pan")    return broadcastStructuralIfActive (name, args, cmdSetMasterPan (args));
    if (name == "enable_track_meter")  return cmdEnableTrackMeter (args);
    if (name == "disable_track_meter") return cmdDisableTrackMeter (args);
    if (name == "enable_all_meters")   return cmdEnableAllMeters (args);
    if (name == "create_bus")        return cmdCreateBus (args);
    if (name == "add_send")          return cmdAddSend (args);
    if (name == "set_send_level")    return cmdSetSendLevel (args);
    if (name == "remove_send")       return cmdRemoveSend (args);
    if (name == "remove_bus")        return cmdRemoveBus (args);
    if (name == "rename_bus")        return cmdRenameBus (args);
    if (name == "get_clip_peaks")    return cmdGetClipPeaks (args);
    if (name == "file_peaks")        return cmdFilePeaks (args);
    if (name == "list_plugins")      return cmdListPlugins (args);
    if (name == "list_builtins")     return cmdListBuiltins (args);
    if (name == "load_plugin")       return cmdLoadPlugin (args);
    if (name == "load_builtin")      return cmdLoadBuiltin (args);
    if (name == "set_track_type")    return cmdSetTrackType (args);
    if (name == "load_drum_kit")     return cmdLoadDrumKit (args);
    if (name == "assign_sample")     return cmdAssignSample (args);
    if (name == "set_drum_lane")     return cmdSetDrumLane (args);
    if (name == "remove_plugin")     return cmdRemovePlugin (args);
    if (name == "reorder_plugin")    return cmdReorderPlugin (args);
    if (name == "set_plugin_param")  return cmdSetPluginParam (args);
    if (name == "bypass_plugin")     return cmdBypassPlugin (args);
    if (name == "rescan_plugins")        return cmdRescanPlugins (args);
    if (name == "get_plugin_blocklist")  return cmdGetPluginBlocklist (args);
    if (name == "clear_plugin_blocklist")return cmdClearPluginBlocklist (args);
    if (name == "block_plugin")          return cmdBlockPlugin (args);
    if (name == "add_automation_point")    return cmdAddAutomationPoint (args);
    if (name == "remove_automation_point") return cmdRemoveAutomationPoint (args);
    if (name == "set_automation_point")    return cmdSetAutomationPoint (args);
    if (name == "clear_automation")        return cmdClearAutomation (args);
    if (name == "open_plugin_editor")return cmdOpenPluginEditor (args);
    if (name == "add_midi_clip")     return cmdAddMidiClip (args);
    if (name == "add_drum_pattern")  return cmdAddDrumPattern (args);
    if (name == "transcribe_clip")   return cmdTranscribeClip (args);
    if (name == "sketch_beatbox")    return cmdSketchBeatbox (args);
    if (name == "generate_beat_recipe") return cmdGenerateBeatRecipe (args);
    if (name == "add_note")          return cmdAddNote (args);
    if (name == "remove_note")       return cmdRemoveNote (args);
    if (name == "set_note")          return cmdSetNote (args);
    if (name == "quantize_notes")    return cmdQuantizeNotes (args);
    if (name == "create_render_layer") return cmdCreateRenderLayer (args);
    if (name == "set_render_param")  return cmdSetRenderParam (args);
    if (name == "render_layer")      return cmdRenderLayer (args);
    if (name == "compile_render")    return cmdCompileRender (args);
    if (name == "cancel_render")     return cmdCancelRender (args);
    if (name == "accept_render")     return cmdAcceptRender (args);
    if (name == "reject_render")     return cmdRejectRender (args);
    if (name == "reset_render_layer") return cmdResetRenderLayer (args);
    if (name == "render_ahead_arm")  return cmdRenderAheadArm (args);   // Lane A — arm/disarm "Live"
    if (name == "render_ahead_tick") return cmdRenderAheadTick (args);  // Lane A — explicit clock tick (run-script)
    if (name == "bypass_layer")      return cmdBypassLayer (args);
    if (name == "freeze_layer")      return cmdFreezeLayer (args);
    if (name == "bounce_layer_to_clip") return cmdBounceLayerToClip (args);
    if (name == "remove_render_layer") return cmdRemoveRenderLayer (args);
    if (name == "list_colors")       return cmdListColors (args);
    if (name == "list_loras")        return cmdListLoras (args);
    if (name == "list_transform_targets") return cmdListTransformTargets (args);
    if (name == "list_rave_models")  return cmdListRaveModels (args);   // Lane B — non-gated fs scan
   #if MOSH_HAVE_ANIRA
    if (name == "add_rave_insert")   return cmdAddRaveInsert (args);
    if (name == "set_rave_param")    return cmdSetRaveParam (args);
    if (name == "load_rave_model")   return cmdLoadRaveModel (args);
    if (name == "reset_rave")        return cmdResetRave (args);
   #endif
    if (name == "export_audio")      return cmdExportAudio (args);
    if (name == "export_stems")      return cmdExportStems (args);
    if (name == "list_audio_devices")return cmdListAudioDevices (args);
    if (name == "list_midi_inputs")  return cmdListMidiInputs (args);
    if (name == "get_command_log")   return cmdGetCommandLog (args);
    if (name == "set_audio_device")  return cmdSetAudioDevice (args);
    if (name == "set_buffer_size")   return cmdSetBufferSize (args);
    if (name == "set_audio_threads") return cmdSetAudioThreads (args);
    if (name == "list_directory")    return cmdListDirectory (args);
    if (name == "audition_file")     return cmdAuditionFile (args);
    if (name == "stop_audition")     return cmdStopAudition (args);
    if (name == "new_project")       return cmdNewProject (args);
    if (name == "open_project")      return cmdOpenProject (args);
    if (name == "open_recent")       return cmdOpenRecent (args);
    if (name == "save_as")           return cmdSaveAs (args);
    if (name == "set_project_settings") return cmdSetProjectSettings (args);
    if (name == "set_key")           return broadcastStructuralIfActive (name, args, cmdSetKey (args));
    if (name == "set_count_in")      return broadcastStructuralIfActive (name, args, cmdSetCountIn (args));
    if (name == "create_group_track") return cmdCreateGroupTrack (args);
    if (name == "mp_serialize_track") return cmdMpSerializeTrack (args);
    if (name == "apply_remote_track") return cmdApplyRemoteTrack (args);
    if (name == "mp_sync_locks")      return cmdMpSyncLocks (args);
    if (name == "mp_create_session")  return cmdMpCreateSession (args);
    if (name == "mp_join_session")    return cmdMpJoinSession (args);
    if (name == "mp_leave_session")   return cmdMpLeaveSession (args);
    if (name == "mp_claim_track")     return cmdMpClaimTrack (args);
    if (name == "mp_commit_track")    return cmdMpCommitTrack (args);
    if (name == "mp_broadcast_selection") return cmdMpBroadcastSelection (args);
    if (name == "mp_send_signal")    return cmdMpSendSignal (args);
    if (name == "mp_serialize_project") return cmdMpSerializeProject (args);
    if (name == "mp_apply_bootstrap")   return cmdMpApplyBootstrap (args);
    if (name == "mp_fetch_missing_stems") return cmdMpFetchMissingStems (args);
    if (name == "mp_apply_structural")  return cmdMpApplyStructural (args);
    if (name == "ungroup_track")      return cmdUngroupTrack (args);
    if (name == "list_wave_inputs")   return cmdListWaveInputs (args);
    if (name == "set_track_input")    return cmdSetTrackInput (args);
    if (name == "list_track_outputs") return cmdListTrackOutputs (args);
    if (name == "set_track_output")   return cmdSetTrackOutput (args);
    if (name == "insert_tempo_change")    return cmdInsertTempoChange (args);
    if (name == "set_tempo_curve")        return cmdSetTempoCurve (args);
    if (name == "remove_tempo_change")    return cmdRemoveTempoChange (args);
    if (name == "insert_time_sig_change") return cmdInsertTimeSigChange (args);
    if (name == "remove_time_sig_change") return cmdRemoveTimeSigChange (args);
    // Stage 7 — type-beat LoRA training
    if (name == "import_training_source")  return cmdImportTrainingSource (args);
    if (name == "list_training_sources")   return cmdListTrainingSources (args);
    if (name == "approve_training_source") return cmdApproveTrainingSource (args);
    if (name == "build_training_corpus")   return cmdBuildTrainingCorpus (args);
    if (name == "submit_training_job")     return cmdSubmitTrainingJob (args);
    if (name == "training_job_status")     return cmdTrainingJobStatus (args);
    if (name == "cancel_training_job")     return cmdCancelTrainingJob (args);
    if (name == "import_lora_adapter")     return cmdImportLoraAdapter (args);
    if (name == "activate_lora_adapter")   return cmdActivateLoraAdapter (args);
    if (name == "list_lora_adapters")      return cmdListLoraAdapters (args);

    return errResult (name, "unknown command: " + name);
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdCreateTrack (const juce::var& args)
{
    // DRM-001 — optional track type. "drum" stamps the type flag and auto-loads the
    // working sampler + bundled kit so drum clips sound immediately ("audio" default).
    const auto type = args.getProperty ("type", "audio").toString();
    if (type != "audio" && type != "drum")
        return errResult ("create_track", "type must be 'audio' or 'drum'");

    beginTxn ("create_track");
    auto* track = createAudioTrack (args.getProperty ("name", var()).toString());
    if (track == nullptr)
    {
        logLine ("create_track", args, false, "insert failed", true);
        return errResult ("create_track", "insert failed");
    }

    if (type == "drum")
    {
        track->state.setProperty (ids::trackType, "drum", &undoManager());
        ensureDefaultInstrument (*track, true);   // sampler + kit
    }

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("type", type);
    data->setProperty ("isInstrument", trackHasInstrument (*track));
    logLine ("create_track", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("create_track", var (data));
}

juce::var MoshOps::cmdRenameTrack (const juce::var& args)
{
    const auto id = args.getProperty ("trackId", var()).toString();
    te::Track* track = findTrack (id);
    if (track == nullptr) track = findGroupTrack (id);   // MIX-008: groups rename too
    if (track == nullptr) return errResult ("rename_track", "no track: " + id);

    beginTxn ("rename_track");
    track->setName (args.getProperty ("name", var()).toString());
    logLine ("rename_track", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("rename_track");
}

juce::var MoshOps::cmdRemoveTrack (const juce::var& args)
{
    const auto id = args.getProperty ("trackId", var()).toString();
    auto* track = findTrack (id);
    if (track == nullptr) return errResult ("remove_track", "no track: " + id);

    beginTxn ("remove_track");
    eng.edit().deleteTrack (track);
    logLine ("remove_track", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_track");
}

// ── SEC-001 — named song sections (MOSH_SECTIONS tree on the Edit) ────────────
// Beat-range regions with a name + colour; create/rename/move/remove are undoable
// writes to the Edit's own ValueTree, so they save/reload with the .tracktionedit
// and ride the one undo system. Section ids are engine-assigned UUIDs.
juce::var MoshOps::cmdCreateSection (const juce::var& args)
{
    const auto name = args.getProperty ("name", var()).toString();
    const double startBeat = (double) args.getProperty ("startBeat", 0.0);
    const double endBeat = (double) args.getProperty ("endBeat", startBeat + 16.0);
    const auto color = args.getProperty ("color", var()).toString();

    beginTxn ("create_section");
    auto state = eng.edit().state;
    auto sections = state.getChildWithName (ids::MOSH_SECTIONS);
    if (! sections.isValid())
    {
        sections = juce::ValueTree (ids::MOSH_SECTIONS);
        state.appendChild (sections, &undoManager());
    }
    const auto sectionId = juce::Uuid().toString();
    sections.appendChild (mosh::Section::create (sectionId, name, startBeat, endBeat, color), &undoManager());

    auto* data = new DynamicObject(); data->setProperty ("sectionId", sectionId);
    logLine ("create_section", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("create_section", var (data));
}

juce::var MoshOps::cmdRenameSection (const juce::var& args)
{
    const auto sectionId = args.getProperty ("sectionId", var()).toString();
    const auto name = args.getProperty ("name", var()).toString();
    auto sections = eng.edit().state.getChildWithName (ids::MOSH_SECTIONS);
    auto node = sections.getChildWithProperty (ids::id, sectionId);
    if (! node.isValid()) return errResult ("rename_section", "no section: " + sectionId);

    beginTxn ("rename_section");
    node.setProperty (ids::sectionName, name, &undoManager());
    logLine ("rename_section", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("rename_section");
}

juce::var MoshOps::cmdMoveSection (const juce::var& args)
{
    const auto sectionId = args.getProperty ("sectionId", var()).toString();
    const double startBeat = (double) args.getProperty ("startBeat", 0.0);
    const double endBeat = (double) args.getProperty ("endBeat", 0.0);
    auto sections = eng.edit().state.getChildWithName (ids::MOSH_SECTIONS);
    auto node = sections.getChildWithProperty (ids::id, sectionId);
    if (! node.isValid()) return errResult ("move_section", "no section: " + sectionId);

    beginTxn ("move_section");
    node.setProperty (ids::sectionStartBeat, startBeat, &undoManager());
    node.setProperty (ids::sectionEndBeat, endBeat, &undoManager());
    logLine ("move_section", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("move_section");
}

juce::var MoshOps::cmdRemoveSection (const juce::var& args)
{
    const auto sectionId = args.getProperty ("sectionId", var()).toString();
    auto sections = eng.edit().state.getChildWithName (ids::MOSH_SECTIONS);
    auto node = sections.getChildWithProperty (ids::id, sectionId);
    if (! node.isValid()) return errResult ("remove_section", "no section: " + sectionId);

    beginTxn ("remove_section");
    sections.removeChild (node, &undoManager());
    logLine ("remove_section", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_section");
}

juce::var MoshOps::sectionsToVar()
{
    Array<var> out;
    auto sections = eng.edit().state.getChildWithName (ids::MOSH_SECTIONS);
    if (sections.isValid())
        for (int i = 0; i < sections.getNumChildren(); ++i)
        {
            auto s = sections.getChild (i);
            auto* o = new DynamicObject();
            o->setProperty ("id", s[ids::id].toString());
            o->setProperty ("name", s[ids::sectionName].toString());
            o->setProperty ("startBeat", (double) s[ids::sectionStartBeat]);
            o->setProperty ("endBeat", (double) s[ids::sectionEndBeat]);
            if (s.hasProperty (ids::sectionColor))
                o->setProperty ("color", s[ids::sectionColor].toString());
            out.add (var (o));
        }
    return out;
}

// ── LYR-001 — Finish-My-Song lyric sheet (per-track MOSH_LYRICSHEET) ───────────

juce::var MoshOps::cmdCreateLyricSheet (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult ("create_lyric_sheet", "no track: " + trackId);
    if (t->state.getChildWithName (ids::MOSH_LYRICSHEET).isValid())
        return errResult ("create_lyric_sheet", "track already has a lyric sheet");

    const auto grid     = args.getProperty ("grid", "1/16").toString();
    const auto language = args.getProperty ("language", "en").toString();

    beginTxn ("create_lyric_sheet");
    const auto sheetId = juce::Uuid().toString();
    auto sheet = mosh::LyricSheet::create (sheetId, grid, language);
    if (args.hasProperty ("topic"))    sheet.setProperty (ids::lyricTopic,    args.getProperty ("topic", var()), nullptr);
    if (args.hasProperty ("mood"))     sheet.setProperty (ids::lyricMood,     args.getProperty ("mood", var()), nullptr);
    if (args.hasProperty ("explicit")) sheet.setProperty (ids::lyricExplicit, args.getProperty ("explicit", var()), nullptr);
    t->state.appendChild (sheet, &undoManager());

    auto* data = new DynamicObject();
    data->setProperty ("sheetId", sheetId);
    data->setProperty ("trackId", trackId);
    logLine ("create_lyric_sheet", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("create_lyric_sheet", var (data));
}

juce::var MoshOps::cmdRemoveLyricSheet (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult ("remove_lyric_sheet", "no track: " + trackId);
    auto sheet = t->state.getChildWithName (ids::MOSH_LYRICSHEET);
    if (! sheet.isValid()) return errResult ("remove_lyric_sheet", "track has no lyric sheet");

    beginTxn ("remove_lyric_sheet");
    t->state.removeChild (sheet, &undoManager());
    logLine ("remove_lyric_sheet", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_lyric_sheet");
}

juce::var MoshOps::cmdSetLyricConstraint (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult ("set_lyric_constraint", "no track: " + trackId);
    auto sheet = t->state.getChildWithName (ids::MOSH_LYRICSHEET);
    if (! sheet.isValid()) return errResult ("set_lyric_constraint", "track has no lyric sheet");

    beginTxn ("set_lyric_constraint");
    if (args.hasProperty ("grid"))            sheet.setProperty (ids::lyricGrid,            args.getProperty ("grid", var()), &undoManager());
    if (args.hasProperty ("topic"))           sheet.setProperty (ids::lyricTopic,           args.getProperty ("topic", var()), &undoManager());
    if (args.hasProperty ("mood"))            sheet.setProperty (ids::lyricMood,            args.getProperty ("mood", var()), &undoManager());
    if (args.hasProperty ("explicit"))        sheet.setProperty (ids::lyricExplicit,        args.getProperty ("explicit", var()), &undoManager());
    if (args.hasProperty ("rhymeStrictness")) sheet.setProperty (ids::lyricRhymeStrictness, args.getProperty ("rhymeStrictness", var()), &undoManager());
    if (args.hasProperty ("styleBias"))       sheet.setProperty (ids::lyricStyleBias,       (bool) args.getProperty ("styleBias", false), &undoManager());
    logLine ("set_lyric_constraint", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_lyric_constraint");
}

juce::var MoshOps::cmdSetLyricLine (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult ("set_lyric_line", "no track: " + trackId);
    auto sheet = t->state.getChildWithName (ids::MOSH_LYRICSHEET);
    if (! sheet.isValid()) return errResult ("set_lyric_line", "track has no lyric sheet");
    auto lines = mosh::LyricSheet::lines (sheet);

    const int lineIndex = (int) args.getProperty ("lineIndex", -1);
    if (lineIndex < 0) return errResult ("set_lyric_line", "lineIndex required (>= 0)");
    if (lineIndex > lines.getNumChildren())
        return errResult ("set_lyric_line", "lineIndex out of range (lines are kept dense)");

    beginTxn ("set_lyric_line");
    auto line = lines.getChildWithProperty (ids::lyricIndex, lineIndex);
    if (! line.isValid())
    {
        // Append a new line at the next index (lineIndex == current count).
        const auto role = args.getProperty ("role", "verse").toString();
        line = mosh::LyricLine::create (juce::Uuid().toString(), lineIndex, role);
        lines.appendChild (line, &undoManager());
    }
    if (args.hasProperty ("text"))
    {
        // A hand edit on a VERBATIM-sung line demotes its provenance to "edited" —
        // we never claim an edited line as exactly what the producer sang.
        if (line[ids::lyricOrigin].toString() == "sung"
            && args.getProperty ("text", var()).toString() != line[ids::lyricText].toString())
            line.setProperty (ids::lyricOrigin, "edited", &undoManager());
        line.setProperty (ids::lyricText, args.getProperty ("text", var()), &undoManager());
    }
    if (args.hasProperty ("role"))            line.setProperty (ids::lyricRole,            args.getProperty ("role", var()), &undoManager());
    if (args.hasProperty ("seedText"))
    {
        // The LyricPanel editor commits hand edits as seedText (review find): on a line
        // whose text is already finalized (sung/accepted), a differing seed edit IS the
        // new effective lyric — mirror it into lyricText so the edit takes effect, and
        // demote a verbatim-"sung" line to "edited" (never claim it verbatim-his again).
        const auto newSeed = args.getProperty ("seedText", var()).toString();
        if (line[ids::lyricText].toString().isNotEmpty()
            && newSeed != line[ids::lyricText].toString())
        {
            if (line[ids::lyricOrigin].toString() == "sung")
                line.setProperty (ids::lyricOrigin, "edited", &undoManager());
            line.setProperty (ids::lyricText, newSeed, &undoManager());
        }
        line.setProperty (ids::lyricSeedText, args.getProperty ("seedText", var()), &undoManager());
    }
    if (args.hasProperty ("syllableTarget"))  line.setProperty (ids::lyricSyllableTarget,  (int) args.getProperty ("syllableTarget", 0), &undoManager());
    if (args.hasProperty ("syllableTol"))     line.setProperty (ids::lyricSyllableTol,     (int) args.getProperty ("syllableTol", 1), &undoManager());
    if (args.hasProperty ("stress"))          line.setProperty (ids::lyricStress,          args.getProperty ("stress", var()), &undoManager());
    if (args.hasProperty ("rhymeGroup"))      line.setProperty (ids::lyricRhymeGroup,      args.getProperty ("rhymeGroup", var()), &undoManager());
    if (args.hasProperty ("rhymeStrictness")) line.setProperty (ids::lyricRhymeStrictness, args.getProperty ("rhymeStrictness", var()), &undoManager());
    if (args.hasProperty ("locked"))          line.setProperty (ids::lyricLocked,          (bool) args.getProperty ("locked", false), &undoManager());
    if (args.hasProperty ("sectionId"))       line.setProperty (ids::lyricSectionId,       args.getProperty ("sectionId", var()), &undoManager());
    // A line carrying a seed/text is no longer "empty" (richer statuses arrive with the
    // generation loop in L2). EXCEPT a Phase-2 `skeleton` line: it carries an all-gaps seed
    // but must stay `skeleton` while the producer edits the grid (the +/- syllable stepper
    // goes through here) — confirm_skeleton does the skeleton→seed flip. (NOTE: `proposed` is
    // L2's "has proposals" status — distinct — so it's NOT preserved here.)
    const bool contentEdited = args.hasProperty ("text") || args.hasProperty ("seedText");
    if (contentEdited
        && line[ids::status].toString() != "skeleton"
        && (line[ids::lyricText].toString().isNotEmpty() || line[ids::lyricSeedText].toString().isNotEmpty()))
        line.setProperty (ids::status, "seed", &undoManager());

    auto* data = new DynamicObject();
    data->setProperty ("lineIndex", lineIndex);
    data->setProperty ("lineId", line[ids::id].toString());
    logLine ("set_lyric_line", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_lyric_line", var (data));
}

juce::var MoshOps::cmdRemoveLyricLine (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult ("remove_lyric_line", "no track: " + trackId);
    auto sheet = t->state.getChildWithName (ids::MOSH_LYRICSHEET);
    if (! sheet.isValid()) return errResult ("remove_lyric_line", "track has no lyric sheet");
    auto lines = mosh::LyricSheet::lines (sheet);

    const int lineIndex = (int) args.getProperty ("lineIndex", -1);
    auto line = lines.getChildWithProperty (ids::lyricIndex, lineIndex);
    if (! line.isValid()) return errResult ("remove_lyric_line", "no line at index " + juce::String (lineIndex));

    beginTxn ("remove_lyric_line");
    lines.removeChild (line, &undoManager());
    // Keep indices dense: renumber the surviving lines by their child order.
    for (int i = 0; i < lines.getNumChildren(); ++i)
        lines.getChild (i).setProperty (ids::lyricIndex, i, &undoManager());
    logLine ("remove_lyric_line", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_lyric_line");
}

juce::var MoshOps::cmdGetRhymes (const juce::var& args)
{
    const auto word = args.getProperty ("word", var()).toString().trim();
    if (word.isEmpty()) return errResult ("get_rhymes", "word required");
    auto strictness = args.getProperty ("strictness", "slant").toString();
    if (strictness != "perfect" && strictness != "slant" && strictness != "free")
        strictness = "slant";
    const int syllables = (int) args.getProperty ("syllables", 0);
    const int maxN      = (int) args.getProperty ("maxN", 50);

    // Phonology read — a fast, deterministic SERVICE call (no LLM, not undoable, no
    // state change). Blocks briefly; this is an explicit on-demand lookup.
    auto res = jobManager.getRhymes (word, strictness, maxN, syllables);
    const bool ok = res.isObject() && (bool) res.getProperty ("ok", false);
    logLine ("get_rhymes", args, ok, ok ? juce::String() : juce::String ("phonology service unavailable"), false);
    if (! ok)
        return errResult ("get_rhymes", "phonology service unavailable (start the generative service)");
    return okResult ("get_rhymes", res);
}

juce::var MoshOps::lyricSheetToVar (te::AudioTrack& t)
{
    auto sheet = t.state.getChildWithName (ids::MOSH_LYRICSHEET);
    if (! sheet.isValid()) return {};

    auto* o = new DynamicObject();
    o->setProperty ("id",              sheet[ids::id].toString());
    o->setProperty ("grid",            sheet[ids::lyricGrid].toString());
    o->setProperty ("language",        sheet[ids::lyricLanguage].toString());
    o->setProperty ("topic",           sheet[ids::lyricTopic].toString());
    o->setProperty ("mood",            sheet[ids::lyricMood].toString());
    o->setProperty ("explicit",        sheet[ids::lyricExplicit].toString());
    o->setProperty ("rhymeStrictness", sheet[ids::lyricRhymeStrictness].toString());
    o->setProperty ("styleBias",       (bool) sheet[ids::lyricStyleBias]);
    o->setProperty ("specVersion",     (int) sheet[ids::lyricSpecVersion]);

    Array<var> lines;
    auto container = mosh::LyricSheet::lines (sheet);
    for (int i = 0; i < container.getNumChildren(); ++i)
    {
        auto l = container.getChild (i);
        auto* lo = new DynamicObject();
        lo->setProperty ("index",           (int) l[ids::lyricIndex]);
        lo->setProperty ("role",            l[ids::lyricRole].toString());
        lo->setProperty ("seedText",        l[ids::lyricSeedText].toString());
        lo->setProperty ("text",            l[ids::lyricText].toString());
        lo->setProperty ("syllableTarget",  (int) l[ids::lyricSyllableTarget]);
        lo->setProperty ("syllableTol",     (int) l[ids::lyricSyllableTol]);
        lo->setProperty ("stress",          l[ids::lyricStress].toString());
        lo->setProperty ("rhymeGroup",      l[ids::lyricRhymeGroup].toString());
        lo->setProperty ("rhymeStrictness", l[ids::lyricRhymeStrictness].toString());
        lo->setProperty ("locked",          (bool) l[ids::lyricLocked]);
        lo->setProperty ("sectionId",       l[ids::lyricSectionId].toString());
        lo->setProperty ("status",          l[ids::status].toString());
        const bool asserted = l[ids::status].toString() == "asserted"
                              && lyricTextIsCompleteForSing (l[ids::lyricText].toString());
        lo->setProperty ("asserted", asserted);
        lo->setProperty ("singable", lyricLineIsAssertedForSing (l));
        // L2 — transient ranked proposals (a JSON blob; absent ⇒ none) + regen counter.
        if (l.hasProperty (ids::lyricProposals))
        {
            auto parsed = juce::JSON::parse (l[ids::lyricProposals].toString());
            if (parsed.isArray()) lo->setProperty ("proposals", parsed);
        }
        if (l.hasProperty (ids::lyricRegen))
            lo->setProperty ("regen", (int) l[ids::lyricRegen]);
        // FMS Phase-3 — a BOOLEAN only (the blob itself stays out of the snapshot): the
        // sing drawer shows how many lines carry a flow from the take.
        lo->setProperty ("hasScore", l.hasProperty (ids::lyricScore));
        // Extraction provenance: the sung-vs-generated distinction for the UI; the heard
        // blob itself stays out of the snapshot (a boolean, like hasScore).
        if (l.hasProperty (ids::lyricOrigin))
            lo->setProperty ("origin", l[ids::lyricOrigin].toString());
        lo->setProperty ("hasHeard", l.hasProperty (ids::lyricHeard));
        // L1 — transient precise phonology (a JSON object; absent ⇒ not yet analysed).
        if (l.hasProperty (ids::lyricAnalysis))
        {
            auto parsed = juce::JSON::parse (l[ids::lyricAnalysis].toString());
            if (parsed.isObject()) lo->setProperty ("analysis", parsed);
        }
        lines.add (var (lo));
    }
    o->setProperty ("lines", lines);
    return var (o);
}

// ── LYR-L2 — the generation loop (propose → validate → retry → rank), fake-first ──

juce::var MoshOps::lyricSpecForTrack (te::AudioTrack& t)
{
    auto sheet = t.state.getChildWithName (ids::MOSH_LYRICSHEET);
    if (! sheet.isValid()) return {};
    const bool styleBias = (bool) sheet[ids::lyricStyleBias];
    auto* o = new DynamicObject();
    o->setProperty ("grid",            sheet[ids::lyricGrid].toString());
    o->setProperty ("topic",           sheet[ids::lyricTopic].toString());
    o->setProperty ("mood",            sheet[ids::lyricMood].toString());
    o->setProperty ("explicit",        sheet[ids::lyricExplicit].toString());
    o->setProperty ("rhymeStrictness", sheet[ids::lyricRhymeStrictness].toString());
    o->setProperty ("styleBias",       styleBias);
    Array<var> lines;
    Array<var> styleCorpus;   // §7 — the artist's OWN finalized lines = the voice corpus
    auto container = mosh::LyricSheet::lines (sheet);
    for (int i = 0; i < container.getNumChildren(); ++i)
    {
        auto l = container.getChild (i);
        auto* lo = new DynamicObject();
        lo->setProperty ("index",           (int) l[ids::lyricIndex]);
        lo->setProperty ("role",            l[ids::lyricRole].toString());
        lo->setProperty ("seedText",        l[ids::lyricSeedText].toString());
        lo->setProperty ("text",            l[ids::lyricText].toString());
        lo->setProperty ("syllableTarget",  (int) l[ids::lyricSyllableTarget]);
        lo->setProperty ("syllableTol",     (int) l[ids::lyricSyllableTol]);
        lo->setProperty ("stress",          l[ids::lyricStress].toString());
        lo->setProperty ("rhymeGroup",      l[ids::lyricRhymeGroup].toString());
        lo->setProperty ("rhymeStrictness", l[ids::lyricRhymeStrictness].toString());
        lo->setProperty ("locked",          (bool) l[ids::lyricLocked]);
        lines.add (var (lo));
        const auto finalized = l[ids::lyricText].toString();
        if (styleBias && finalized.trim().isNotEmpty())
            styleCorpus.add (finalized);   // user-owned only; passed inline (no persistence)
    }
    o->setProperty ("lines", lines);
    if (styleBias)
        o->setProperty ("styleCorpus", styleCorpus);
    return var (o);
}

juce::var MoshOps::lyricRegenForTrack (te::AudioTrack& t)
{
    auto sheet = t.state.getChildWithName (ids::MOSH_LYRICSHEET);
    auto* o = new DynamicObject();
    if (sheet.isValid())
    {
        auto container = mosh::LyricSheet::lines (sheet);
        for (int i = 0; i < container.getNumChildren(); ++i)
        {
            auto l = container.getChild (i);
            if (l.hasProperty (ids::lyricRegen) && (int) l[ids::lyricRegen] > 0)
                o->setProperty (juce::Identifier (l[ids::lyricIndex].toString()), (int) l[ids::lyricRegen]);
        }
    }
    return var (o);
}

juce::var MoshOps::runLyricGeneration (const juce::String& cmdName, const juce::String& mode,
                                       const juce::String& trackId, int lineIndex, int afterIndex,
                                       const juce::var& args)
{
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult (cmdName, "no track: " + trackId);
    if (! t->state.getChildWithName (ids::MOSH_LYRICSHEET).isValid())
        return errResult (cmdName, "track has no lyric sheet");

    const auto spec  = lyricSpecForTrack (*t);
    const auto regen = lyricRegenForTrack (*t);

    // Land proposals (a JSON blob per line) on the message thread; re-look-up the sheet
    // (it may have changed) and write only lines the service returned. NON-undoable
    // (ephemeral generation output); accept/reject is the user's commit.
    auto land = [this, cmdName, trackId] (const juce::var& result) -> juce::var
    {
        auto* tt = findTrack (trackId);
        auto sheet = tt != nullptr ? tt->state.getChildWithName (ids::MOSH_LYRICSHEET) : juce::ValueTree();
        if (! sheet.isValid()) return errResult (cmdName, "lyric sheet gone");
        if (! result.isObject() || ! (bool) result.getProperty ("ok", false))
            return errResult (cmdName, "lyric service unavailable (start the generative service)");
        auto lines = mosh::LyricSheet::lines (sheet);
        auto resLines = result.getProperty ("lines", var());
        int n = 0;
        if (resLines.isArray())
            for (auto& rl : *resLines.getArray())
            {
                auto node = lines.getChildWithProperty (ids::lyricIndex, (int) rl.getProperty ("index", -1));
                if (! node.isValid()) continue;
                node.setProperty (ids::lyricProposals, juce::JSON::toString (rl.getProperty ("proposals", var())), nullptr);
                node.setProperty (ids::status, "proposed", nullptr);
                ++n;
            }
        emitSnapshotInvalidated();
        auto* d = new DynamicObject(); d->setProperty ("status", "proposed"); d->setProperty ("lineCount", n);
        return okResult (cmdName, var (d));
    };

    logLine (cmdName, args, true, {}, false);

    // Synchronous (harness / agent): block on generation + land inline.
    if ((bool) args.getProperty ("wait", false))
        return land (jobManager.generateLyrics (mode, spec, lineIndex, afterIndex, regen));

    // Async (GUI): generate off the message thread; land via callAsync, skipping if a
    // cancel bumped the epoch in the meantime.
    const int epoch = ++lyricGenEpoch_;   // capture; a later launch or cancel supersedes
    std::thread ([this, mode, spec, lineIndex, afterIndex, regen, land, epoch]
    {
        auto result = jobManager.generateLyrics (mode, spec, lineIndex, afterIndex, regen);
        juce::MessageManager::callAsync ([this, land, result, epoch]
        {
            if (epoch != lyricGenEpoch_) return;   // cancelled / superseded
            land (result);
        });
    }).detach();

    auto* d = new DynamicObject(); d->setProperty ("status", "generating");
    return okResult (cmdName, var (d));
}

juce::var MoshOps::cmdCompleteLyrics (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    return runLyricGeneration ("complete_lyrics", "complete", trackId, -1, -1, args);
}

juce::var MoshOps::cmdFillLyricGap (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int lineIndex = (int) args.getProperty ("lineIndex", -1);
    return runLyricGeneration ("fill_lyric_gap", "fill", trackId, lineIndex, -1, args);
}

juce::var MoshOps::cmdSuggestNextLine (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int afterIndex = (int) args.getProperty ("afterIndex", -1);
    return runLyricGeneration ("suggest_next_line", "next", trackId, -1, afterIndex, args);
}

juce::var MoshOps::cmdRegenerateLyric (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int lineIndex = (int) args.getProperty ("lineIndex", -1);
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult ("regenerate_lyric", "no track: " + trackId);
    auto sheet = t->state.getChildWithName (ids::MOSH_LYRICSHEET);
    if (! sheet.isValid()) return errResult ("regenerate_lyric", "track has no lyric sheet");
    auto node = mosh::LyricSheet::lines (sheet).getChildWithProperty (ids::lyricIndex, lineIndex);
    if (! node.isValid()) return errResult ("regenerate_lyric", "no line at index " + juce::String (lineIndex));
    // Bump the line's regen counter (non-undoable) so the service draws a fresh sample.
    node.setProperty (ids::lyricRegen, (int) node.getProperty (ids::lyricRegen, 0) + 1, nullptr);
    return runLyricGeneration ("regenerate_lyric", "fill", trackId, lineIndex, -1, args);
}

juce::var MoshOps::cmdCancelLyricJob (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    ++lyricGenEpoch_;   // any in-flight async land for the prior epoch is skipped
    logLine ("cancel_lyric_job", args, true, {}, false);
    return okResult ("cancel_lyric_job");
}

juce::var MoshOps::cmdAcceptLyricProposal (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int lineIndex = (int) args.getProperty ("lineIndex", -1);
    const int proposalIndex = (int) args.getProperty ("proposalIndex", 0);
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult ("accept_lyric_proposal", "no track: " + trackId);
    auto sheet = t->state.getChildWithName (ids::MOSH_LYRICSHEET);
    if (! sheet.isValid()) return errResult ("accept_lyric_proposal", "track has no lyric sheet");
    auto node = mosh::LyricSheet::lines (sheet).getChildWithProperty (ids::lyricIndex, lineIndex);
    if (! node.isValid()) return errResult ("accept_lyric_proposal", "no line at index " + juce::String (lineIndex));
    auto props = juce::JSON::parse (node.getProperty (ids::lyricProposals, "").toString());
    if (! props.isArray() || proposalIndex < 0 || proposalIndex >= props.size())
        return errResult ("accept_lyric_proposal", "no proposal at that index");
    const auto chosen = props[proposalIndex].getProperty ("text", var()).toString();
    if (! lyricTextIsCompleteForSing (chosen))
        return errResult ("accept_lyric_proposal", "proposal has unresolved words");

    beginTxn ("accept_lyric_proposal");
    node.setProperty (ids::lyricText, chosen, &undoManager());     // the COMMIT (undoable)
    node.setProperty (ids::status, "asserted", &undoManager());
    node.removeProperty (ids::lyricProposals, nullptr);            // clear the ephemeral proposals
    // Provenance (honest by construction): "mixed" only when a heard-kept word actually
    // SURVIVES in the accepted text (review find: the blob alone proves what the take
    // said, not what this proposal kept — a regenerated line that dropped his anchors
    // must land "generated").
    {
        bool heardKept = false;
        if (node.hasProperty (ids::lyricHeard))
        {
            auto tokens = juce::StringArray::fromTokens (chosen.toLowerCase(), " \t", {});
            for (auto& t : tokens)
                t = t.trimCharactersAtStart (".,!?'\"-").trimCharactersAtEnd (".,!?'\"-");
            auto hb = juce::JSON::parse (node[ids::lyricHeard].toString());
            if (auto* ws = hb.getProperty ("words", var()).getArray())
                for (auto& w : *ws)
                    if ((bool) w.getProperty ("kept", false)
                        && tokens.contains (w.getProperty ("word", var()).toString()
                                                .toLowerCase()
                                                .trimCharactersAtStart (".,!?'\"-")
                                                .trimCharactersAtEnd (".,!?'\"-")))
                    { heardKept = true; break; }
        }
        node.setProperty (ids::lyricOrigin, heardKept ? "mixed" : "generated", &undoManager());
    }
    logLine ("accept_lyric_proposal", args, true, {}, true);       // explicit TASTE label (positive)
    emitSnapshotInvalidated();

    // §7 style-RAG flywheel — auto-accumulate the accepted line into the PERSISTED
    // cross-song voice corpus so future songs sound more like the artist. Fire-and-forget
    // on a detached thread: styleCorpusAdd is NON-SPAWNING (isHealthy-gated) + best-effort,
    // so accept NEVER blocks/fails on it and a service-down state is a silent no-op (keeps
    // --selftest hermetic). NON-undoable by design: undo pulls the text from the sheet but
    // not the corpus — acceptable, the corpus is a "lines I liked" accumulation (add_lines
    // dedups + the near-verbatim guard handles redundancy). Mirrors cmdAnalyzeLyrics's
    // detached-thread idiom.
    if (chosen.trim().isNotEmpty())
    {
        const juce::String line = chosen;
        std::thread ([this, line]
        {
            jobManager.styleCorpusAdd (juce::StringArray { line }, "accept");
        }).detach();
    }

    auto* d = new DynamicObject(); d->setProperty ("text", chosen);
    return okResult ("accept_lyric_proposal", var (d));
}

juce::var MoshOps::cmdAssertLyricLine (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int lineIndex = (int) args.getProperty ("lineIndex", -1);
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult ("assert_lyric_line", "no track: " + trackId);
    auto sheet = t->state.getChildWithName (ids::MOSH_LYRICSHEET);
    if (! sheet.isValid()) return errResult ("assert_lyric_line", "track has no lyric sheet");
    auto node = mosh::LyricSheet::lines (sheet).getChildWithProperty (ids::lyricIndex, lineIndex);
    if (! node.isValid()) return errResult ("assert_lyric_line", "no line at index " + juce::String (lineIndex));

    const auto assertedText = args.hasProperty ("text")
        ? args.getProperty ("text", var()).toString()
        : node[ids::lyricText].toString();
    if (! lyricTextIsCompleteForSing (assertedText))
        return errResult ("assert_lyric_line", "line needs complete words before it can be asserted");

    beginTxn ("assert_lyric_line");
    node.setProperty (ids::lyricText, assertedText.trim(), &undoManager());
    node.setProperty (ids::status, "asserted", &undoManager());
    node.removeProperty (ids::lyricProposals, nullptr);
    logLine ("assert_lyric_line", args, true, {}, true);
    emitSnapshotInvalidated();

    auto* d = new DynamicObject(); d->setProperty ("text", assertedText.trim());
    return okResult ("assert_lyric_line", var (d));
}

juce::var MoshOps::cmdRejectLyricProposal (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int lineIndex = (int) args.getProperty ("lineIndex", -1);
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult ("reject_lyric_proposal", "no track: " + trackId);
    auto sheet = t->state.getChildWithName (ids::MOSH_LYRICSHEET);
    if (! sheet.isValid()) return errResult ("reject_lyric_proposal", "track has no lyric sheet");
    auto node = mosh::LyricSheet::lines (sheet).getChildWithProperty (ids::lyricIndex, lineIndex);
    if (! node.isValid()) return errResult ("reject_lyric_proposal", "no line at index " + juce::String (lineIndex));
    node.removeProperty (ids::lyricProposals, nullptr);
    node.setProperty (ids::status, node[ids::lyricText].toString().isNotEmpty()
                                       || node[ids::lyricSeedText].toString().isNotEmpty() ? "seed" : "empty", nullptr);
    logLine ("reject_lyric_proposal", args, true, {}, false);      // TASTE label (negative)
    emitSnapshotInvalidated();
    return okResult ("reject_lyric_proposal");
}

// LYR-L1 — precise per-line phonology for the flow visualizer. Service-backed (no LLM),
// idempotent + read-only: the analysis is a recomputable JSON blob landed per line →
// snapshot. NON-undoable; no epoch guard (landing a stale analysis is harmless — it just
// re-marks the same content, and a missing line is skipped on re-lookup).
juce::var MoshOps::cmdAnalyzeLyrics (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult ("analyze_lyrics", "no track: " + trackId);
    if (! t->state.getChildWithName (ids::MOSH_LYRICSHEET).isValid())
        return errResult ("analyze_lyrics", "track has no lyric sheet");

    const auto spec = lyricSpecForTrack (*t);

    auto land = [this, trackId] (const juce::var& result) -> juce::var
    {
        auto* tt = findTrack (trackId);
        auto sheet = tt != nullptr ? tt->state.getChildWithName (ids::MOSH_LYRICSHEET) : juce::ValueTree();
        if (! sheet.isValid()) return errResult ("analyze_lyrics", "lyric sheet gone");
        if (! result.isObject() || ! (bool) result.getProperty ("ok", false))
            return errResult ("analyze_lyrics", "lyric service unavailable (start the generative service)");
        auto lines = mosh::LyricSheet::lines (sheet);
        auto resLines = result.getProperty ("lines", var());
        int n = 0;
        if (resLines.isArray())
            for (auto& rl : *resLines.getArray())
            {
                auto node = lines.getChildWithProperty (ids::lyricIndex, (int) rl.getProperty ("index", -1));
                if (! node.isValid()) continue;
                node.setProperty (ids::lyricAnalysis, juce::JSON::toString (rl.getProperty ("analysis", var())), nullptr);
                ++n;
            }
        emitSnapshotInvalidated();
        auto* d = new DynamicObject(); d->setProperty ("status", "analyzed"); d->setProperty ("lineCount", n);
        return okResult ("analyze_lyrics", var (d));
    };

    logLine ("analyze_lyrics", args, true, {}, false);

    if ((bool) args.getProperty ("wait", false))
        return land (jobManager.analyzeLyrics (spec));

    std::thread ([this, spec, land]
    {
        auto result = jobManager.analyzeLyrics (spec);
        juce::MessageManager::callAsync ([land, result] { land (result); });
    }).detach();

    auto* d = new DynamicObject(); d->setProperty ("status", "analyzing");
    return okResult ("analyze_lyrics", var (d));
}

// §7 — read-only corpus size ("N lines in your voice"). NON-SPAWNING (styleCorpusStats is
// isHealthy-gated) → returns lines:-1 when the service is down (the UI shows nothing). Counts
// only; the corpus content is never exposed (the backend-only safety wall).
juce::var MoshOps::cmdGetLyricCorpusStats (const juce::var& args)
{
    const int lines = jobManager.styleCorpusStats();
    auto* d = new DynamicObject(); d->setProperty ("lines", lines);
    return okResult ("get_lyric_corpus_stats", var (d));
}

// LYR Phase 3 — audio "mumble take". A recorded vocal take → Basic Pitch note onsets (the
// reliable RHYTHM) + Whisper confidence-gated words → a lyric constraint sheet on the clip's
// OWN track, so the producer doesn't hand-type the flow; the L2/L3 loop fills the gaps.
// Mirrors cmdTranscribeClip's async-on-the-snapshot-rail shape (clip-scoped, service-spawning).
juce::var MoshOps::cmdBuildLyricsFromClip (const juce::var& args)
{
    const auto clipId = args.getProperty ("clipId", var()).toString();
    const double confThreshold = (double) args.getProperty ("confThreshold", 0.6);

    auto* w = dynamic_cast<te::WaveAudioClip*> (findClip (clipId));
    if (w == nullptr) return errResult ("build_lyrics_from_clip", "no wave clip with that id");
    const auto srcFile = w->getCurrentSourceFile();
    if (! srcFile.existsAsFile()) return errResult ("build_lyrics_from_clip", "clip has no readable source audio");

    auto* track = dynamic_cast<te::AudioTrack*> (w->getTrack());
    if (track == nullptr) return errResult ("build_lyrics_from_clip", "clip is not on an audio track");
    const auto trackId = track->itemID.toString();
    if (track->state.getChildWithName (ids::MOSH_LYRICSHEET).isValid())
        return errResult ("build_lyrics_from_clip", "track already has a lyric sheet");

    auto& edit = eng.edit();
    auto* tempo = edit.tempoSequence.getNumTempos() > 0 ? edit.tempoSequence.getTempo (0) : nullptr;
    const double bpm = tempo != nullptr ? tempo->getBpm() : 120.0;
    auto* tsig = edit.tempoSequence.getNumTimeSigs() > 0 ? edit.tempoSequence.getTimeSig (0) : nullptr;
    const int tsNum = tsig != nullptr ? tsig->numerator.get() : 4;
    const int tsDen = tsig != nullptr ? tsig->denominator.get() : 4;

    // Land the built spec as a MOSH_LYRICSHEET on the clip's OWN track in ONE undo txn —
    // written via the state helpers directly (re-invoking create/set sub-commands would make
    // N undo steps + emit nested logs/events). Always on the message thread.
    auto land = [this, clipId, trackId] (const juce::var& spec) -> juce::var
    {
        auto* tt = findTrack (trackId);
        if (tt == nullptr) return errResult ("build_lyrics_from_clip", "track gone");
        if (tt->state.getChildWithName (ids::MOSH_LYRICSHEET).isValid())
            return errResult ("build_lyrics_from_clip", "track already has a lyric sheet");

        auto linesVar = spec.isObject() ? spec.getProperty ("lines", var()) : var();
        if (! spec.isObject() || ! (bool) spec.getProperty ("ok", false) || ! linesVar.isArray() || linesVar.size() == 0)
        {
            const auto err = spec.isObject() ? spec.getProperty ("error", var()).toString() : juce::String();
            const auto msg = err == "no_melody_detected" ? juce::String ("no melody detected in the take")
                           : err.isNotEmpty() ? err : juce::String ("lyric service unavailable (start the generative service)");
            emit ("build_lyrics_status", [&] { auto* o = new DynamicObject();
                o->setProperty ("clipId", clipId); o->setProperty ("state", "error");
                o->setProperty ("error", msg); return var (o); }());
            return errResult ("build_lyrics_from_clip", msg);
        }

        beginTxn ("build_lyrics_from_clip");
        const auto sheetId = juce::Uuid().toString();
        auto sheet = mosh::LyricSheet::create (sheetId, spec.getProperty ("grid", "1/16").toString());
        if (spec.getProperty ("topic", var()).toString().isNotEmpty())
            sheet.setProperty (ids::lyricTopic, spec.getProperty ("topic", var()), nullptr);
        auto container = mosh::LyricSheet::lines (sheet);
        for (auto& lv : *linesVar.getArray())
        {
            auto line = mosh::LyricLine::create (juce::Uuid().toString(),
                                                 (int) lv.getProperty ("index", 0),
                                                 lv.getProperty ("role", "verse").toString());
            line.setProperty (ids::lyricSeedText,       lv.getProperty ("seedText", var()), nullptr);
            line.setProperty (ids::lyricSyllableTarget, (int) lv.getProperty ("syllableTarget", 0), nullptr);
            line.setProperty (ids::lyricSyllableTol,    (int) lv.getProperty ("syllableTol", 1), nullptr);
            line.setProperty (ids::lyricStress,         lv.getProperty ("stress", var()), nullptr);
            line.setProperty (ids::lyricRhymeGroup,     lv.getProperty ("rhymeGroup", var()), nullptr);
            line.setProperty (ids::status,              "seed", nullptr);
            container.appendChild (line, nullptr);
        }
        tt->state.appendChild (sheet, &undoManager());

        emit ("build_lyrics_status", [&] { auto* o = new DynamicObject();
            o->setProperty ("clipId", clipId); o->setProperty ("state", "done");
            o->setProperty ("lineCount", linesVar.size()); return var (o); }());
        emitSnapshotInvalidated();

        auto* d = new DynamicObject();
        d->setProperty ("status", "done");
        d->setProperty ("sheetId", sheetId);
        d->setProperty ("trackId", trackId);
        d->setProperty ("lineCount", linesVar.size());
        return okResult ("build_lyrics_from_clip", var (d));
    };

    emit ("build_lyrics_status", [&] { auto* o = new DynamicObject();
        o->setProperty ("clipId", clipId); o->setProperty ("state", "working"); return var (o); }());
    logLine ("build_lyrics_from_clip", args, true, {}, false);

    // Off the message thread (or inline for wait:true): notes (Basic Pitch) → words (Whisper,
    // possibly empty) → mumble_spec. Absent notes (dead service / no Basic Pitch) ⇒ a
    // no_melody_detected spec so `land` surfaces a friendly error.
    auto fetchSpec = [this, srcFile, bpm, tsNum, tsDen, confThreshold] () -> juce::var
    {
        auto notesRes = jobManager.transcribe (srcFile, "mono");
        auto notes = notesRes.isObject() ? notesRes.getProperty ("notes", var()) : var();
        if (! notesRes.isObject() || ! (bool) notesRes.getProperty ("ok", false) || ! notes.isArray() || notes.size() == 0)
        {
            auto* e = new DynamicObject(); e->setProperty ("ok", false);
            e->setProperty ("error", "no_melody_detected"); e->setProperty ("lines", var (Array<var>{}));
            return var (e);
        }
        auto wordsRes = jobManager.transcribeWords (srcFile);
        auto words = wordsRes.isObject() ? wordsRes.getProperty ("words", var()) : var();
        if (! words.isArray()) words = var (Array<var>{});
        return jobManager.mumbleSpec (notes, words, bpm, tsNum, tsDen, confThreshold);
    };

    if ((bool) args.getProperty ("wait", false))
        return land (fetchSpec());

    std::thread ([this, fetchSpec, land]
    {
        auto spec = fetchSpec();
        juce::MessageManager::callAsync ([land, spec] { land (spec); });
    }).detach();

    auto* data = new DynamicObject();
    data->setProperty ("status", "started");
    return okResult ("build_lyrics_from_clip", var (data));
}

// LYR Phase 2 — audio "mumble take" (gibberish → rhythmic SKELETON). Mirrors
// cmdBuildLyricsFromClip, but the take is WORDLESS: skeletonSpec returns an all-gaps spec
// (syllable grid + stress) and each line lands `proposed` — the producer confirms the grid
// (confirm_skeleton) before the Phase-1 engine fills the words. Clip-scoped, service-spawning.
juce::var MoshOps::cmdBuildSkeletonFromClip (const juce::var& args)
{
    const auto clipId = args.getProperty ("clipId", var()).toString();
    const auto grid = args.getProperty ("grid", "1/16").toString();

    auto* w = dynamic_cast<te::WaveAudioClip*> (findClip (clipId));
    if (w == nullptr) return errResult ("build_skeleton_from_clip", "no wave clip with that id");
    const auto srcFile = w->getCurrentSourceFile();
    if (! srcFile.existsAsFile()) return errResult ("build_skeleton_from_clip", "clip has no readable source audio");

    auto* track = dynamic_cast<te::AudioTrack*> (w->getTrack());
    if (track == nullptr) return errResult ("build_skeleton_from_clip", "clip is not on an audio track");
    const auto trackId = track->itemID.toString();
    if (track->state.getChildWithName (ids::MOSH_LYRICSHEET).isValid())
        return errResult ("build_skeleton_from_clip", "track already has a lyric sheet");

    auto& edit = eng.edit();
    auto* tempo = edit.tempoSequence.getNumTempos() > 0 ? edit.tempoSequence.getTempo (0) : nullptr;
    const double bpm = tempo != nullptr ? tempo->getBpm() : 120.0;
    auto* tsig = edit.tempoSequence.getNumTimeSigs() > 0 ? edit.tempoSequence.getTimeSig (0) : nullptr;
    const int tsNum = tsig != nullptr ? tsig->numerator.get() : 4;
    const int tsDen = tsig != nullptr ? tsig->denominator.get() : 4;

    // Land the skeleton as a MOSH_LYRICSHEET on the clip's OWN track in ONE undo txn, each line
    // `proposed` (the human-in-the-loop grid the producer confirms). Always on the message thread.
    auto land = [this, clipId, trackId] (const juce::var& spec) -> juce::var
    {
        auto* tt = findTrack (trackId);
        if (tt == nullptr) return errResult ("build_skeleton_from_clip", "track gone");
        if (tt->state.getChildWithName (ids::MOSH_LYRICSHEET).isValid())
            return errResult ("build_skeleton_from_clip", "track already has a lyric sheet");

        auto linesVar = spec.isObject() ? spec.getProperty ("lines", var()) : var();
        if (! spec.isObject() || ! (bool) spec.getProperty ("ok", false) || ! linesVar.isArray() || linesVar.size() == 0)
        {
            const auto err = spec.isObject() ? spec.getProperty ("error", var()).toString() : juce::String();
            const auto msg = err == "no_melody_detected" ? juce::String ("no melody detected in the take")
                           : err.isNotEmpty() ? err : juce::String ("skeleton service unavailable (start the generative service)");
            emit ("skeleton_status", [&] { auto* o = new DynamicObject();
                o->setProperty ("clipId", clipId); o->setProperty ("state", "error");
                o->setProperty ("error", msg); return var (o); }());
            return errResult ("build_skeleton_from_clip", msg);
        }

        beginTxn ("build_skeleton_from_clip");
        const auto sheetId = juce::Uuid().toString();
        auto sheet = mosh::LyricSheet::create (sheetId, spec.getProperty ("grid", "1/16").toString());
        if (spec.getProperty ("topic", var()).toString().isNotEmpty())
            sheet.setProperty (ids::lyricTopic, spec.getProperty ("topic", var()), nullptr);
        auto container = mosh::LyricSheet::lines (sheet);
        const auto scoresVar = spec.getProperty ("lineScores", var());  // Stage 1: aligned 1:1 with lines
        const auto heardVar  = spec.getProperty ("lineHeard", var());   // extraction: aligned 1:1 with lines
        int li = 0;
        for (auto& lv : *linesVar.getArray())
        {
            auto line = mosh::LyricLine::create (juce::Uuid().toString(),
                                                 (int) lv.getProperty ("index", 0),
                                                 lv.getProperty ("role", "verse").toString());
            line.setProperty (ids::lyricSeedText,       lv.getProperty ("seedText", var()), nullptr);
            line.setProperty (ids::lyricSyllableTarget, (int) lv.getProperty ("syllableTarget", 0), nullptr);
            line.setProperty (ids::lyricSyllableTol,    (int) lv.getProperty ("syllableTol", 1), nullptr);
            line.setProperty (ids::lyricStress,         lv.getProperty ("stress", var()), nullptr);
            line.setProperty (ids::lyricRhymeGroup,     lv.getProperty ("rhymeGroup", var()), nullptr);
            // Lyric EXTRACTION (pipeline correction 2026-07-04): a line the producer REALLY
            // sang lands VERBATIM — text + gapless seed + status "seed" (already done: the
            // generation loop skips it and rhyme-anchors on it) + origin "sung". A partly-
            // real line keeps the grid editor (status "skeleton") with his words as seed
            // anchors, origin "partial". Wordless lines = the pre-correction behavior.
            const auto sungText = lv.getProperty ("text", var()).toString();
            const auto lvOrigin = lv.getProperty ("origin", var()).toString();
            if (sungText.isNotEmpty() && lvOrigin == "sung")
            {
                line.setProperty (ids::lyricText,     sungText, nullptr);
                line.setProperty (ids::lyricSeedText, sungText, nullptr);   // gapless ⇒ not fillable
                line.setProperty (ids::status,        "seed", nullptr);
                line.setProperty (ids::lyricOrigin,   "sung", nullptr);
            }
            else
            {
                line.setProperty (ids::status, "skeleton", nullptr);   // the grid-editor gate (distinct from L2 "proposed")
                if (lvOrigin == "partial")
                    line.setProperty (ids::lyricOrigin, "partial", nullptr);
            }
            // Phase-3 Stage 1: persist the render-ready score blob (articulation slots +
            // melisma segments) with its line — the Stage-2 SoulX adapter authors the
            // target score from this. Absent from older/degraded specs ⇒ simply no blob.
            if (scoresVar.isArray() && li < scoresVar.size() && scoresVar[li].isObject())
                line.setProperty (ids::lyricScore, juce::JSON::toString (scoresVar[li], true), nullptr);
            // Everything the take was HEARD to say (kept AND rejected, with slot hints) —
            // persisted for future splice boundaries + correction seeds; raw ASR is never
            // discarded anymore.
            if (heardVar.isArray() && li < heardVar.size() && heardVar[li].isObject())
                line.setProperty (ids::lyricHeard, juce::JSON::toString (heardVar[li], true), nullptr);
            ++li;
            container.appendChild (line, nullptr);
        }
        tt->state.appendChild (sheet, &undoManager());

        emit ("skeleton_status", [&] { auto* o = new DynamicObject();
            o->setProperty ("clipId", clipId); o->setProperty ("state", "done");
            o->setProperty ("lineCount", linesVar.size()); return var (o); }());
        emitSnapshotInvalidated();

        auto* d = new DynamicObject();
        d->setProperty ("status", "done");
        d->setProperty ("sheetId", sheetId);
        d->setProperty ("trackId", trackId);
        d->setProperty ("lineCount", linesVar.size());
        return okResult ("build_skeleton_from_clip", var (d));
    };

    emit ("skeleton_status", [&] { auto* o = new DynamicObject();
        o->setProperty ("clipId", clipId); o->setProperty ("state", "working"); return var (o); }());
    logLine ("build_skeleton_from_clip", args, true, {}, false);

    // The server orchestrates Basic-Pitch onsets (+ optional FCPE F0) then bins → one call.
    // Absent any onset detector ⇒ a no_melody_detected spec so `land` surfaces a friendly error.
    auto fetchSpec = [this, srcFile, bpm, tsNum, tsDen, grid] () -> juce::var
    {
        return jobManager.skeletonSpec (srcFile, bpm, tsNum, tsDen, grid);
    };

    if ((bool) args.getProperty ("wait", false))
        return land (fetchSpec());

    std::thread ([this, fetchSpec, land]
    {
        auto spec = fetchSpec();
        juce::MessageManager::callAsync ([land, spec] { land (spec); });
    }).detach();

    auto* data = new DynamicObject();
    data->setProperty ("status", "started");
    return okResult ("build_skeleton_from_clip", var (data));
}

// LYR Phase 2 — confirm the proposed flow grid: flip each `proposed` line → `seed` so the
// Phase-1 engine (complete_lyrics / fill_lyric_gap) will fill it. The human-in-the-loop gate.
juce::var MoshOps::cmdConfirmSkeleton (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult ("confirm_skeleton", "no track: " + trackId);
    auto sheet = t->state.getChildWithName (ids::MOSH_LYRICSHEET);
    if (! sheet.isValid()) return errResult ("confirm_skeleton", "track has no lyric sheet");

    beginTxn ("confirm_skeleton");
    auto lines = mosh::LyricSheet::lines (sheet);
    int n = 0;
    for (int i = 0; i < lines.getNumChildren(); ++i)
    {
        auto line = lines.getChild (i);
        if (line[ids::status].toString() == "skeleton")
        {
            line.setProperty (ids::status, "seed", &undoManager());
            ++n;
        }
    }
    logLine ("confirm_skeleton", args, true, {}, false);
    emitSnapshotInvalidated();
    auto* d = new DynamicObject(); d->setProperty ("confirmed", n);
    return okResult ("confirm_skeleton", var (d));
}

// ── ANN-001: authored timeline annotations (mirror the sections CRUD; multiplayer-
// broadcast so collaborators share comments). ───────────────────────────────────────
juce::var MoshOps::cmdCreateAnnotation (const juce::var& args)
{
    const auto text   = args.getProperty ("text", var()).toString();
    const double beat = (double) args.getProperty ("beat", 0.0);
    const auto color  = args.getProperty ("color", var()).toString();
    const auto author = args.getProperty ("author", var()).toString();
    // Stable cross-peer id: reuse the caller's if supplied (the broadcast re-exec passes
    // it back), else mint one. Broadcasting the RESOLVED id keeps both peers' ids equal so
    // edit/move/remove address the same annotation.
    auto annId = args.getProperty ("annotationId", var()).toString();
    if (annId.isEmpty()) annId = juce::Uuid().toString();

    beginTxn ("create_annotation");
    auto state = eng.edit().state;
    auto anns = state.getChildWithName (ids::MOSH_ANNOTATIONS);
    if (! anns.isValid())
    {
        anns = juce::ValueTree (ids::MOSH_ANNOTATIONS);
        state.appendChild (anns, &undoManager());
    }
    // Idempotent on the resolved id: a re-applied create (the only ADDITIVE op broadcast
    // over MP) must not append a duplicate node.
    if (! anns.getChildWithProperty (ids::id, annId).isValid())
        anns.appendChild (mosh::Annotation::create (annId, text, beat, color, author), &undoManager());

    auto* data = new DynamicObject(); data->setProperty ("annotationId", annId);
    logLine ("create_annotation", args, true, {}, true);
    emitSnapshotInvalidated();

    // Broadcast with the RESOLVED id (the generic wrapper would re-mint on the peer).
    if (mpSession_ != nullptr && mpSession_->active() && ! applyingRemote_)
    {
        auto* ba = new DynamicObject();
        ba->setProperty ("annotationId", annId);
        ba->setProperty ("text", text);
        ba->setProperty ("beat", beat);
        if (color.isNotEmpty())  ba->setProperty ("color", color);
        if (author.isNotEmpty()) ba->setProperty ("author", author);
        mpSession_->broadcastStructural ("create_annotation", var (ba));
    }
    return okResult ("create_annotation", var (data));
}

juce::var MoshOps::cmdEditAnnotation (const juce::var& args)
{
    const auto annId = args.getProperty ("annotationId", var()).toString();
    auto anns = eng.edit().state.getChildWithName (ids::MOSH_ANNOTATIONS);
    auto node = anns.getChildWithProperty (ids::id, annId);
    if (! node.isValid()) return errResult ("edit_annotation", "no annotation: " + annId);

    beginTxn ("edit_annotation");
    if (args.hasProperty ("text"))  node.setProperty (ids::annotationText, args.getProperty ("text", var()), &undoManager());
    if (args.hasProperty ("color")) node.setProperty (ids::annotationColor, args.getProperty ("color", var()), &undoManager());
    logLine ("edit_annotation", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("edit_annotation");
}

juce::var MoshOps::cmdMoveAnnotation (const juce::var& args)
{
    const auto annId = args.getProperty ("annotationId", var()).toString();
    auto anns = eng.edit().state.getChildWithName (ids::MOSH_ANNOTATIONS);
    auto node = anns.getChildWithProperty (ids::id, annId);
    if (! node.isValid()) return errResult ("move_annotation", "no annotation: " + annId);

    beginTxn ("move_annotation");
    node.setProperty (ids::annotationBeat, (double) args.getProperty ("beat", 0.0), &undoManager());
    logLine ("move_annotation", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("move_annotation");
}

juce::var MoshOps::cmdRemoveAnnotation (const juce::var& args)
{
    const auto annId = args.getProperty ("annotationId", var()).toString();
    auto anns = eng.edit().state.getChildWithName (ids::MOSH_ANNOTATIONS);
    auto node = anns.getChildWithProperty (ids::id, annId);
    if (! node.isValid()) return errResult ("remove_annotation", "no annotation: " + annId);

    beginTxn ("remove_annotation");
    anns.removeChild (node, &undoManager());
    logLine ("remove_annotation", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_annotation");
}

juce::var MoshOps::annotationsToVar()
{
    Array<var> out;
    auto anns = eng.edit().state.getChildWithName (ids::MOSH_ANNOTATIONS);
    if (anns.isValid())
        for (int i = 0; i < anns.getNumChildren(); ++i)
        {
            auto a = anns.getChild (i);
            auto* o = new DynamicObject();
            o->setProperty ("id", a[ids::id].toString());
            o->setProperty ("text", a[ids::annotationText].toString());
            o->setProperty ("beat", (double) a[ids::annotationBeat]);
            if (a.hasProperty (ids::annotationColor))  o->setProperty ("color", a[ids::annotationColor].toString());
            if (a.hasProperty (ids::annotationAuthor)) o->setProperty ("author", a[ids::annotationAuthor].toString());
            out.add (var (o));
        }
    return out;
}

// Shared wave-file insertion path used by both import_clip (path-based) and
// import_clip_data (bytes-over-bridge). The caller guarantees `file` is a real,
// already-validated audio file on disk. Opens one undo transaction, finds-or-
// creates the target track, inserts the wave clip at `startSeconds`, drains the
// post-insert AsyncUpdater headless (so itemIDs settle, no itemID assert), logs
// the command as undoable and emits a snapshot invalidation.
juce::var MoshOps::importWaveFileToTrack (const juce::String& command,
                                          const juce::File& file,
                                          const juce::String& clipName,
                                          const juce::String& trackId,
                                          double startSeconds,
                                          const juce::var& logArgs)
{
    auto& edit = eng.edit();

    // Validate the audio file BEFORE any mutation. We may auto-create a track
    // below; doing that (undoable) creation first and only then discovering the
    // file is invalid would leave an orphan track in a failed command's undo
    // transaction (partial mutation). Validate up front so an invalid import is a
    // clean no-op.
    te::AudioFile audioFile (edit.engine, file);
    if (! audioFile.isValid()) return errResult (command, "invalid audio file");

    auto* track = trackId.isNotEmpty() ? findTrack (trackId) : nullptr;
    if (track == nullptr)
    {
        auto tracks = te::getAudioTracks (edit);
        track = tracks.isEmpty() ? nullptr : tracks.getFirst();
    }

    beginTxn (command);
    if (track == nullptr)
        track = createAudioTrack ({});
    if (track == nullptr) return errResult (command, "no track");

    const double len = audioFile.getLength();
    auto name = clipName;
    if (name.isEmpty()) name = file.getFileNameWithoutExtension();

    auto clip = track->insertWaveClip (name, file,
        { { tracktion::TimePosition::fromSeconds (startSeconds), tracktion::TimeDuration::fromSeconds (len) }, {} }, false);
    if (clip == nullptr)
    {
        logLine (command, logArgs, false, "insert failed", true);
        return errResult (command, "insertWaveClip failed");
    }

    // Tracktion queues a track/clip AsyncUpdater after a headless insert; drain
    // it before returning so itemIDs settle (mirrors createAudioTrack).
    if (! eng.hasAudio())
        if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
            mm->runDispatchLoopUntil (1);

    auto* data = new DynamicObject();
    data->setProperty ("clipId", clip->itemID.toString());
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("file", file.getFullPathName());
    logLine (command, logArgs, true, {}, true);
    emitSnapshotInvalidated();
    return okResult (command, var (data));
}

juce::var MoshOps::cmdImportClip (const juce::var& args)
{
    const auto path = args.getProperty ("file", var()).toString();
    if (path.isEmpty()) return errResult ("import_clip", "missing 'file'");

    File file (path);
    if (! file.existsAsFile()) return errResult ("import_clip", "file not found: " + path);

    return importWaveFileToTrack ("import_clip", file,
                                  args.getProperty ("name", var()).toString(),
                                  args.getProperty ("trackId", var()).toString(),
                                  (double) args.getProperty ("startSeconds", 0.0),
                                  args);
}

juce::var MoshOps::cmdImportClipData (const juce::var& args)
{
    auto name = args.getProperty ("name", var()).toString();
    const auto dataBase64 = args.getProperty ("dataBase64", var()).toString();
    if (name.isEmpty())       return errResult ("import_clip_data", "missing 'name'");
    if (dataBase64.isEmpty()) return errResult ("import_clip_data", "missing 'dataBase64'");

    // Size guard: reject a pathological drop before decoding to avoid OOM.
    // ~280 MB of base64 decodes to ~200 MB of audio.
    if (dataBase64.length() > 280 * 1024 * 1024)
        return errResult ("import_clip_data", "file too large");

    // Decode base64 -> raw bytes. Guard against malformed input (no crash).
    juce::MemoryOutputStream mos;
    if (! juce::Base64::convertFromBase64 (mos, dataBase64))
        return errResult ("import_clip_data", "invalid base64 data");

    // Write the decoded bytes under sessionDir/imports/. Uniquify the destination so
    // two drops sharing a display name (both "loop.wav") don't overwrite each other's
    // on-disk source: an earlier imported clip still references the first file, so an
    // in-place overwrite would silently alias it (and persist across save/reload).
    auto importsDir = eng.sessionDir().getChildFile ("imports");
    importsDir.createDirectory();
    const juce::File named (importsDir.getChildFile (juce::File::createLegalFileName (name)));
    auto file = importsDir.getNonexistentChildFile (named.getFileNameWithoutExtension(),
                                                    named.getFileExtension(), false);
    if (! file.replaceWithData (mos.getData(), mos.getDataSize()))
        return errResult ("import_clip_data", "could not write the import file");

    // Validate it is real audio BEFORE inserting; never leave a garbage file or
    // insert a non-audio clip.
    te::AudioFile af (eng.engine(), file);
    if (! af.isValid())
    {
        file.deleteFile();
        return errResult ("import_clip_data", "not a supported audio file");
    }

    return importWaveFileToTrack ("import_clip_data", file, name,
                                  args.getProperty ("trackId", var()).toString(),
                                  (double) args.getProperty ("start", 0.0),
                                  args);
}

juce::var MoshOps::cmdAddTestTone (const juce::var& args)
{
    const double seconds = (double) args.getProperty ("seconds", 2.0);
    const double freq = (double) args.getProperty ("freq", 220.0);
    auto name = args.getProperty ("name", var()).toString();
    if (name.isEmpty()) name = "tone-" + String ((int) freq);

    auto file = eng.generateTestTone (seconds, freq, name);
    if (! file.existsAsFile()) return errResult ("add_test_tone_clip", "tone generation failed");

    auto* importArgs = new DynamicObject();
    importArgs->setProperty ("file", file.getFullPathName());
    importArgs->setProperty ("trackId", args.getProperty ("trackId", var()));
    importArgs->setProperty ("name", name);
    return cmdImportClip (var (importArgs));   // logs as import_clip
}

juce::var MoshOps::cmdSetTransport (const juce::var& args)
{
    auto& transport = eng.edit().getTransport();
    const auto action = args.getProperty ("action", var()).toString();

    // Play/record touch the audio device; skip them in no-audio (headless) mode.
    if ((action == "play" || (action == "toggle" && ! transport.isPlaying())) && eng.hasAudio())
    {
        eng.ensurePlaybackContext();
        transport.play (false);
    }
    else if (action == "stop" || (action == "toggle" && transport.isPlaying()))
    {
        transport.stop (false, false);
    }
    else if (action == "record" && eng.hasAudio())
    {
        // G2b — re-sync the live Edit's pre-roll to the stored project preference
        // right before every record start, so a save/reload that swapped in a
        // different Edit instance (or a countInBars change from another session)
        // is always honored. transport.record() below is what actually consults
        // it (te::Edit::getNumCountInBeats(), via TransportControl).
        applyCountInToEdit();
        eng.ensurePlaybackContext();
        transport.record (false);
    }

    if (action == "to_end")
        transport.setPosition (tracktion::TimePosition::fromSeconds (eng.edit().getLength().inSeconds()));
    else if (action == "to_start")
        transport.setPosition (tracktion::TimePosition());

    if (args.hasProperty ("position"))
        transport.setPosition (tracktion::TimePosition::fromSeconds ((double) args.getProperty ("position", 0.0)));

    if (args.hasProperty ("loop"))
        transport.looping = (bool) args.getProperty ("loop", false);

    if (args.hasProperty ("loopStart") && args.hasProperty ("loopEnd"))
        transport.setLoopRange ({ tracktion::TimePosition::fromSeconds ((double) args.getProperty ("loopStart", 0.0)),
                                  tracktion::TimePosition::fromSeconds ((double) args.getProperty ("loopEnd", 0.0)) });

    logLine ("set_transport", args, true, {}, false);          // transport is NOT undoable
    emit ("transport", transportToVar());
    return okResult ("set_transport", transportToVar());
}

juce::var MoshOps::cmdSetTempo (const juce::var& args)
{
    auto& edit = eng.edit();
    auto* tempo = edit.tempoSequence.getNumTempos() > 0 ? edit.tempoSequence.getTempo (0) : nullptr;
    if (tempo == nullptr) return errResult ("set_tempo", "no tempo setting");

    const double bpm = juce::jlimit (20.0, 999.0, (double) args.getProperty ("bpm", 120.0));
    beginTxn ("set_tempo");
    tempo->setBpm (bpm);
    logLine ("set_tempo", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject(); data->setProperty ("bpm", tempo->getBpm());
    return okResult ("set_tempo", var (data));
}

juce::var MoshOps::cmdSetTimeSignature (const juce::var& args)
{
    auto& edit = eng.edit();
    auto* ts = edit.tempoSequence.getTimeSig (0);
    if (ts == nullptr) return errResult ("set_time_signature", "no time signature");

    const int num = juce::jlimit (1, 32, (int) args.getProperty ("numerator", 4));
    const int den = (int) args.getProperty ("denominator", 4);
    static const int validDen[] = { 1, 2, 4, 8, 16, 32 };
    bool denOk = false;
    for (int d : validDen) if (d == den) denOk = true;
    if (! denOk) return errResult ("set_time_signature", "denominator must be a power of two (1..32)");

    beginTxn ("set_time_signature");
    ts->setStringTimeSig (juce::String (num) + "/" + juce::String (den));
    logLine ("set_time_signature", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("numerator", ts->numerator.get());
    data->setProperty ("denominator", ts->denominator.get());
    return okResult ("set_time_signature", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// SES-001 — the tempo MAP. te::TempoSequence natively supports multi-point tempo
// and time-sig changes (insert/remove/toBeats/toTime; playback honors the map
// with no clip-anchoring work). Mosh inserts STEP changes only: curve = 1.0 is
// the engine's hold-then-jump form (the ramp branch in tracktion_core's
// Sequence::Section build is gated on curve != +-1.0). Bezier ramps + audio warp
// are deliberately deferred. set_tempo / set_time_signature keep editing point 0.
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdInsertTempoChange (const juce::var& args)
{
    auto& edit = eng.edit();
    const double time = (double) args.getProperty ("time", -1.0);
    if (time < 0.0) return errResult ("insert_tempo_change", "missing/negative 'time'");
    const double bpm = (double) args.getProperty ("bpm", 0.0);
    if (bpm < 20.0 || bpm > 999.0) return errResult ("insert_tempo_change", "bpm must be 20..999");

    // Optional curve: shapes the ramp FROM the PREVIOUS point TO this one is NOT how
    // the engine models it — curve lives on the setting that STARTS a span (this
    // setting's curve shapes the ramp from HERE to the NEXT point). 1.0 (default) =
    // step (hold-then-jump); values in (-1, 1) ramp: <0 log, 0 linear, >0 exponential.
    const double curve = juce::jlimit (-1.0, 1.0, (double) args.getProperty ("curve", 1.0));

    beginTxn ("insert_tempo_change");
    auto setting = edit.tempoSequence.insertTempo (tracktion::TimePosition::fromSeconds (time));
    if (setting == nullptr) return errResult ("insert_tempo_change", "insertTempo failed");
    setting->setBpm (bpm);
    setting->setCurve ((float) curve);

    logLine ("insert_tempo_change", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("time", setting->getStartTime().inSeconds());
    data->setProperty ("bpm", setting->getBpm());
    data->setProperty ("curve", (double) setting->getCurve());
    data->setProperty ("count", edit.tempoSequence.getNumTempos());
    return okResult ("insert_tempo_change", var (data));
}

juce::var MoshOps::cmdSetTempoCurve (const juce::var& args)
{
    auto& edit = eng.edit();
    const int index = (int) args.getProperty ("index", -1);
    if (index < 0 || index >= edit.tempoSequence.getNumTempos())
        return errResult ("set_tempo_curve", "index must be 0..numTempos-1");
    if (! args.hasProperty ("curve"))
        return errResult ("set_tempo_curve", "missing 'curve'");
    const double curve = juce::jlimit (-1.0, 1.0, (double) args.getProperty ("curve", 1.0));

    // The curve on point N shapes the span FROM point N TO point N+1 (the engine's
    // Section build gates the ramp subdivision on currTempo.curve != +-1).
    beginTxn ("set_tempo_curve");
    edit.tempoSequence.getTempo (index)->setCurve ((float) curve);
    logLine ("set_tempo_curve", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("index", index);
    data->setProperty ("curve", curve);
    return okResult ("set_tempo_curve", var (data));
}

juce::var MoshOps::cmdRemoveTempoChange (const juce::var& args)
{
    auto& edit = eng.edit();
    const int index = (int) args.getProperty ("index", -1);
    // Index 0 is the edit's base tempo (the engine requires a first setting; it is
    // edited via set_tempo, never removed).
    if (index <= 0 || index >= edit.tempoSequence.getNumTempos())
        return errResult ("remove_tempo_change", "index must be 1..numTempos-1");

    beginTxn ("remove_tempo_change");
    // remapEdit=false: Mosh's command surface is seconds-anchored, so removing a
    // tempo point must not shift clip positions.
    edit.tempoSequence.removeTempo (index, false);
    logLine ("remove_tempo_change", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("count", edit.tempoSequence.getNumTempos());
    return okResult ("remove_tempo_change", var (data));
}

juce::var MoshOps::cmdInsertTimeSigChange (const juce::var& args)
{
    auto& edit = eng.edit();
    const double time = (double) args.getProperty ("time", -1.0);
    if (time < 0.0) return errResult ("insert_time_sig_change", "missing/negative 'time'");
    const int num = juce::jlimit (1, 32, (int) args.getProperty ("numerator", 4));
    const int den = (int) args.getProperty ("denominator", 4);
    static const int validDen[] = { 1, 2, 4, 8, 16, 32 };
    bool denOk = false;
    for (int d : validDen) if (d == den) denOk = true;
    if (! denOk) return errResult ("insert_time_sig_change", "denominator must be a power of two (1..32)");

    beginTxn ("insert_time_sig_change");
    auto setting = edit.tempoSequence.insertTimeSig (tracktion::TimePosition::fromSeconds (time));
    if (setting == nullptr) return errResult ("insert_time_sig_change", "insertTimeSig failed");
    setting->setStringTimeSig (juce::String (num) + "/" + juce::String (den));

    logLine ("insert_time_sig_change", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("numerator", setting->numerator.get());
    data->setProperty ("denominator", setting->denominator.get());
    data->setProperty ("count", edit.tempoSequence.getNumTimeSigs());
    return okResult ("insert_time_sig_change", var (data));
}

juce::var MoshOps::cmdRemoveTimeSigChange (const juce::var& args)
{
    auto& edit = eng.edit();
    const int index = (int) args.getProperty ("index", -1);
    if (index <= 0 || index >= edit.tempoSequence.getNumTimeSigs())
        return errResult ("remove_time_sig_change", "index must be 1..numTimeSigs-1");

    beginTxn ("remove_time_sig_change");
    edit.tempoSequence.removeTimeSig (index);
    logLine ("remove_time_sig_change", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("count", edit.tempoSequence.getNumTimeSigs());
    return okResult ("remove_time_sig_change", var (data));
}

juce::var MoshOps::cmdSetMetronome (const juce::var& args)
{
    // The click track is a transport/monitoring preference (like loop), not a
    // session edit — not undoable.
    const bool on = (bool) args.getProperty ("enabled", false);
    eng.edit().clickTrackEnabled = on;
    logLine ("set_metronome", args, true, {}, false);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject(); data->setProperty ("metronome", on);
    return okResult ("set_metronome", var (data));
}

// KEY-001 — the musical-key domains. These MUST stay byte-identical to the literal
// arrays in ui/src/vendor/voice.js (NOTE_PC keys + SCALES keys); Moshi's voice snaps
// every earcon to (tonic, mode), so a mismatch would make the host accept a key the
// voice cannot sing. Validated by cmdSetKey; the snapshot defaults below match the
// voice's neutral start (A4 tonic + SCALES.minor).
namespace
{
    // voice.js NOTE_PC keys (enharmonic spellings included), in declaration order.
    const char* const kNotePcNames[] = {
        "C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb",
        "G", "G#", "Ab", "A", "A#", "Bb", "B"
    };
    // voice.js SCALES keys.
    const char* const kScaleNames[] = {
        "major", "minor", "dorian", "mixolydian", "pentatonic", "chromatic"
    };

    bool isValidTonic (const juce::String& t)
    {
        for (auto* n : kNotePcNames) if (t == n) return true;
        return false;
    }
    bool isValidMode (const juce::String& m)
    {
        for (auto* n : kScaleNames) if (m == n) return true;
        return false;
    }
}

const char* const MoshOps::kDefaultKeyTonic = "A";
const char* const MoshOps::kDefaultKeyMode  = "minor";

// PRJ-008 — the MOSH_PROJECT child of the Edit's own ValueTree (mirrors the
// MOSH_RENDERLAYER parenting). Created empty on first access so it saves/reloads
// with the .tracktionedit. Pure storage accessor: no undo manager, no logging.
juce::ValueTree MoshOps::projectSettingsTree()
{
    auto state = eng.edit().state;
    auto node = state.getChildWithName (ids::MOSH_PROJECT);
    if (! node.isValid())
    {
        node = juce::ValueTree (ids::MOSH_PROJECT);
        state.appendChild (node, nullptr);   // nullptr: not an undoable edit (preference)
    }
    return node;
}

juce::var MoshOps::projectSettingsToVar()
{
    // Project INTENT where stored; live device readout as the fallback (device values
    // stay the live truth, project = intent). timeBase has no device analogue, so it
    // defaults to "seconds". NON-mutating read (snapshot() is read-only by contract):
    // getChildWithName returns an invalid tree when unset, whose hasProperty() is false,
    // so the device-fallback below handles the absent case without writing the Edit tree.
    auto node = eng.edit().state.getChildWithName (ids::MOSH_PROJECT);
    auto& dm = eng.engine().getDeviceManager();

    double sr = dm.getSampleRate();
    if (sr < 7000.0) sr = 44100.0;
    if (node.hasProperty (ids::projectSampleRate))
        sr = (double) node.getProperty (ids::projectSampleRate);

    int bd = dm.getBitDepth();
    if (bd != 16 && bd != 24 && bd != 32) bd = 24;
    if (node.hasProperty (ids::projectBitDepth))
        bd = (int) node.getProperty (ids::projectBitDepth);

    juce::String tb = node.hasProperty (ids::timeBase)
                          ? node.getProperty (ids::timeBase).toString()
                          : juce::String ("seconds");

    // KEY-001 — the musical key, ALWAYS present so the UI never sees a missing field.
    // Default A/minor (matches voice.js's neutral A4 tonic + SCALES.minor). Stored on
    // the same MOSH_PROJECT node; falls back to the default where unset.
    juce::String tonic = node.hasProperty (ids::musicalTonic)
                             ? node.getProperty (ids::musicalTonic).toString()
                             : juce::String (kDefaultKeyTonic);
    juce::String keyMode = node.hasProperty (ids::musicalMode)
                               ? node.getProperty (ids::musicalMode).toString()
                               : juce::String (kDefaultKeyMode);

    auto* key = new DynamicObject();
    key->setProperty ("tonic", tonic);
    key->setProperty ("mode", keyMode);

    // G2b — count-in / pre-roll bars, ALWAYS present (default 0/off) so the UI
    // never sees a missing field, mirroring the key default above.
    const int countInBars = node.hasProperty (ids::countInBars)
                                ? (int) node.getProperty (ids::countInBars) : 0;

    auto* o = new DynamicObject();
    o->setProperty ("sampleRate", sr);
    o->setProperty ("bitDepth", bd);
    o->setProperty ("timeBase", tb);
    o->setProperty ("key", var (key));
    o->setProperty ("countInBars", countInBars);
    // PRJ-FMT — the stamped project format version (0 ⇒ legacy/unsaved). Lets the UI and
    // the selftest observe the on-tree stamp without reading the .tracktionedit directly.
    o->setProperty ("formatVersion", mosh::readFileVersion (eng.edit().state));
    return var (o);
}

juce::var MoshOps::cmdSetProjectSettings (const juce::var& args)
{
    // Per-project format / time-base INTENT — a producer preference (the export/
    // format default + the timeline display base), NOT a live device change. Stored
    // on a MOSH_PROJECT child of the Edit tree so it persists with the session, and
    // followed the cmdSetMetronome template exactly: no Tracktion transaction (no
    // beginNewTransaction), logLine(..., false), emitSnapshotInvalidated. Works
    // headless (no audio device required).
    //
    // Validate every supplied field before writing anything (partial patch: each
    // field is optional, but a present field that fails validation is a hard error
    // and leaves the stored settings untouched).
    if (args.hasProperty ("sampleRate"))
    {
        const double sr = (double) args.getProperty ("sampleRate", 0.0);
        if (sr < 7000.0)
            return errResult ("set_project_settings", "sampleRate must be >= 7000");
    }
    if (args.hasProperty ("bitDepth"))
    {
        const int bd = (int) args.getProperty ("bitDepth", 0);
        if (bd != 16 && bd != 24 && bd != 32)
            return errResult ("set_project_settings", "bitDepth must be one of 16, 24, 32");
    }
    if (args.hasProperty ("timeBase"))
    {
        const auto tb = args.getProperty ("timeBase", var()).toString();
        if (tb != "seconds" && tb != "barsBeats")
            return errResult ("set_project_settings", "timeBase must be 'seconds' or 'barsBeats'");
    }

    auto node = projectSettingsTree();
    if (args.hasProperty ("sampleRate"))
        node.setProperty (ids::projectSampleRate, (double) args.getProperty ("sampleRate", 0.0), nullptr);
    if (args.hasProperty ("bitDepth"))
        node.setProperty (ids::projectBitDepth, (int) args.getProperty ("bitDepth", 0), nullptr);
    if (args.hasProperty ("timeBase"))
        node.setProperty (ids::timeBase, args.getProperty ("timeBase", var()).toString(), nullptr);

    eng.markDirty();                                           // edit-state change → needs re-save (gap 1)
    logLine ("set_project_settings", args, true, {}, false);   // preference — NOT undoable
    emitSnapshotInvalidated();
    return okResult ("set_project_settings", projectSettingsToVar());
}

juce::var MoshOps::cmdSetKey (const juce::var& args)
{
    // KEY-001 — the project's musical key (tonic + mode). Producer INTENT, stored on
    // the same MOSH_PROJECT node as the format/time-base prefs, so it saves/reloads
    // with the .tracktionedit. Followed the cmdSetProjectSettings template exactly:
    // validate-then-write, NO Tracktion transaction (no beginNewTransaction),
    // logLine(..., false) → NON-undoable preference, emitSnapshotInvalidated. Works
    // headless (no audio device required).
    //
    // Validate against the voice.js NOTE_PC / SCALES domains BEFORE writing anything
    // (a present-but-invalid field is a hard error that leaves storage untouched).
    if (args.hasProperty ("tonic"))
    {
        const auto tonic = args.getProperty ("tonic", var()).toString();
        if (! isValidTonic (tonic))
            return errResult ("set_key", "tonic must be one of the voice.js NOTE_PC names (C..B incl. enharmonics)");
    }
    if (args.hasProperty ("mode"))
    {
        const auto m = args.getProperty ("mode", var()).toString();
        if (! isValidMode (m))
            return errResult ("set_key", "mode must be one of the voice.js SCALES (major|minor|dorian|mixolydian|pentatonic|chromatic)");
    }

    auto node = projectSettingsTree();
    if (args.hasProperty ("tonic"))
        node.setProperty (ids::musicalTonic, args.getProperty ("tonic", var()).toString(), nullptr);
    if (args.hasProperty ("mode"))
        node.setProperty (ids::musicalMode, args.getProperty ("mode", var()).toString(), nullptr);

    eng.markDirty();                              // edit-state change → needs re-save (gap 1)
    logLine ("set_key", args, true, {}, false);   // preference — NOT undoable
    emitSnapshotInvalidated();
    return okResult ("set_key", projectSettingsToVar());
}

// G2b — count-in / pre-roll bars. te::Edit::CountIn's none/oneBar/twoBar values
// are 0/1/2 — exactly mosh::countin's {0,1,2} bars domain — so a validated bars
// value casts straight across with no lookup table. Asserted here (rather than in
// the engine-free state/CountIn.h) because only this translation unit can see the
// real tracktion_engine enum.
static_assert (static_cast<int> (te::Edit::CountIn::none)   == 0
            && static_cast<int> (te::Edit::CountIn::oneBar) == 1
            && static_cast<int> (te::Edit::CountIn::twoBar) == 2,
               "mosh::countin's {0,1,2} bars domain assumes te::Edit::CountIn's "
               "none/oneBar/twoBar == 0/1/2 — update the cast in applyCountInToEdit "
               "if tracktion_engine ever renumbers this enum");

void MoshOps::applyCountInToEdit()
{
    // Re-applies the STORED preference to the LIVE Edit's real pre-roll every time
    // it's called (cmdSetCountIn, and cmdSetTransport's "record" branch) rather
    // than only at load time — so recording always honors the CURRENT project
    // setting regardless of when/how the Edit was loaded. Cheap (writes engine
    // property storage; no audio device needed) and safe headless.
    auto node = eng.edit().state.getChildWithName (ids::MOSH_PROJECT);
    const int bars = node.hasProperty (ids::countInBars) ? (int) node.getProperty (ids::countInBars) : 0;
    const int clamped = mosh::countin::isValidBars (bars) ? bars : 0;   // defensive: never feed the engine a bad value
    eng.edit().setCountInMode (static_cast<te::Edit::CountIn> (clamped));
}

juce::var MoshOps::cmdSetCountIn (const juce::var& args)
{
    // G2b — count-in / pre-roll bars before recording. Producer INTENT, stored on
    // the same MOSH_PROJECT node as timeBase/key, following the cmdSetKey template
    // exactly: validate-then-write, NO Tracktion transaction (no
    // beginNewTransaction), logLine(..., false) → NON-undoable preference,
    // emitSnapshotInvalidated. Works headless (no audio device required).
    //
    // ENGINE-WIRED, not just stored: applyCountInToEdit() below pushes the value
    // straight into tracktion_engine's own pre-roll (te::Edit::setCountInMode),
    // which TransportControl's record-start logic already consults
    // (Edit::getNumCountInBeats()) to roll the playhead back N beats and play an
    // audible click through the pre-roll before capture actually begins — see
    // tracktion_TransportControl.cpp's performRecord. No new recording machinery was
    // needed; Mosh just exposes + persists the setting the engine already honors.
    if (! args.hasProperty ("bars"))
        return errResult ("set_count_in", "bars is required");

    const int bars = (int) args.getProperty ("bars", 0);
    if (! mosh::countin::isValidBars (bars))
        return errResult ("set_count_in", mosh::countin::validationError());

    auto node = projectSettingsTree();
    node.setProperty (ids::countInBars, bars, nullptr);
    applyCountInToEdit();                                  // immediate effect this session

    eng.markDirty();                                        // edit-state change → needs re-save (gap 1)
    logLine ("set_count_in", args, true, {}, false);        // preference — NOT undoable
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("countInBars", bars);
    return okResult ("set_count_in", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// MIX-008 — group (submix) tracks
//
// A te::FolderTrack created with asSubmix=true GENUINELY sums its children: the
// graph builder routes every child through a SummingNode wrapped by the folder's
// own plugin chain (createNodeForSubmixTrack; proven by the engine's nested-submix
// test). insertNewFolderTrack(asSubmix=true) adds the default VolumeAndPan +
// LevelMeter plugins, which is exactly what keeps isSubmixFolder() true — so the
// group has a real fader and the summing is engine-owned, not a Mosh claim.
// ─────────────────────────────────────────────────────────────────────────────
te::FolderTrack* MoshOps::findGroupTrack (const juce::String& id)
{
    const auto itemId = te::EditItemID::fromString (id);
    for (auto* t : te::getAllTracks (eng.edit()))
        if (auto* ft = dynamic_cast<te::FolderTrack*> (t))
            if (ft->itemID == itemId)
                return ft;
    return nullptr;
}

juce::var MoshOps::cmdCreateGroupTrack (const juce::var& args)
{
    auto& edit = eng.edit();

    // Resolve the member tracks FIRST (cheap precondition, zero side effects on
    // a malformed request). Unknown ids are skipped + reported, not fatal — an
    // empty trackIds (or none) creates an empty group, which is valid.
    juce::Array<te::AudioTrack*> members;
    int unknown = 0;
    const auto idsVar = args.getProperty ("trackIds", var());   // bind before getArray
    if (auto* ids = idsVar.getArray())
        for (auto& idv : *ids)
        {
            if (auto* t = findTrack (idv.toString()))
            {
                if (! members.contains (t))
                    members.add (t);
            }
            else
                ++unknown;
        }

    beginTxn ("create_group_track");

    auto folder = edit.insertNewFolderTrack (te::TrackInsertPoint::getEndOfTracks (edit),
                                             nullptr, /*asSubmix*/ true);
    if (folder == nullptr)
        return errResult ("create_group_track", "insertNewFolderTrack failed");

    logicalid::ensureTrack (folder->state);   // MP-001 — stable cross-peer id for the submix

    const auto name = args.getProperty ("name", var()).toString();
    folder->setName (name.isNotEmpty() ? name : juce::String ("Group"));

    // Move each member under the folder, preserving their relative order: the
    // first child goes to the start of the folder, each next one after the last.
    te::Track* preceding = nullptr;
    for (auto* m : members)
    {
        edit.moveTrack (m, te::TrackInsertPoint (folder.get(), preceding));
        preceding = m;
    }

    // Structural edits queue Tracktion async settling; drain headless so itemIDs
    // and parent links are stable before the snapshot (mirrors createAudioTrack).
    if (! eng.hasAudio())
        if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
            mm->runDispatchLoopUntil (1);

    auto* data = new DynamicObject();
    data->setProperty ("groupId", folder->itemID.toString());
    data->setProperty ("moved", members.size());
    if (unknown > 0) data->setProperty ("unknownTrackIds", unknown);
    logLine ("create_group_track", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("create_group_track", var (data));
}

juce::var MoshOps::cmdMpSerializeTrack (const juce::var& args)
{
    // MP-001 — capture a track's portable blob for a peer commit. Read-only (no
    // undo transaction, no event): flushState() so plugin chunks/state are in the
    // tree, then serialize the whole track subtree.
    const auto id = args.getProperty ("trackId", var()).toString();
    auto* track = findTrack (id);
    if (track == nullptr)
        return errResult ("mp_serialize_track", "no track: " + id);

    eng.edit().flushState();
    const auto blob = trackcommit::serialize (*track);
    if (blob.isEmpty())
        return errResult ("mp_serialize_track", "serialize produced an empty blob");

    auto* o = new DynamicObject();
    o->setProperty ("blob", blob);
    o->setProperty ("logicalId", logicalid::ensureTrack (track->state));
    return okResult ("mp_serialize_track", var (o));
}

juce::var MoshOps::cmdApplyRemoteTrack (const juce::var& args)
{
    // MP-001 — apply a peer's committed track. Mutates via a nullptr UndoManager
    // (never the local user's undo stack) and emits NOTHING (no relay echo); the
    // local repaint is driven separately (P5). Backend-only / peer-origin.
    const auto blob = args.getProperty ("blob", var()).toString();
    if (blob.isEmpty())
        return errResult ("apply_remote_track", "missing blob");

    auto res = trackcommit::apply (eng.edit(), blob);
    if (! res.ok)
        return errResult ("apply_remote_track", res.error);

    // NB: deliberately NO message-loop drain here. Tracktion's track list updates
    // synchronously on the ValueTree child add/remove, so the snapshot already
    // reflects the replaced track. Draining would (a) tick the 30 Hz metering /
    // (b) advance the UndoManager's open transaction — both of which would leak
    // into a remote apply that must be invisible to telemetry AND the undo stack.
    eng.markDirty();   // the Edit genuinely changed (outside the undo system)

    auto* o = new DynamicObject();
    o->setProperty ("logicalId", res.logicalId);
    o->setProperty ("mode", res.created ? "created" : "replaced");
    return okResult ("apply_remote_track", var (o));
}

juce::String MoshOps::lockKeyFor (LockManager::Scope scope, const juce::var& args)
{
    using Scope = LockManager::Scope;
    if (scope == Scope::SessionGlobal)
        return LockManager::sessionKey();

    if (scope == Scope::Track)
    {
        if (auto* t = findTrack (args.getProperty ("trackId", var()).toString()))
            return logicalid::track (t->state);
        // Track-scoped composites may target via clipId only (add_drum_pattern) —
        // resolve through the clip so a peer's track lock still guards them.
        if (auto* c = findClip (args.getProperty ("clipId", var()).toString()))
            if (auto* tr = c->getTrack())
                return logicalid::track (tr->state);
        return {};   // unresolvable target -> empty key allows; the command itself will error
    }

    if (scope == Scope::Clip)
    {
        if (auto* c = findClip (args.getProperty ("clipId", var()).toString()))
            if (auto* tr = c->getTrack())
                return logicalid::track (tr->state);
        return {};
    }

    return {};
}

juce::var MoshOps::cmdMpSyncLocks (const juce::var& args)
{
    // MP-001 — mirror the relay's session/lock state into the local guard. Driven
    // by the live poll path; backend-only (Unguarded). active:false => single-player.
    if (! (bool) args.getProperty ("active", false))
    {
        lockManager_.deactivate();
        auto* o = new DynamicObject();
        o->setProperty ("active", false);
        return okResult ("mp_sync_locks", var (o));
    }

    lockManager_.activate (args.getProperty ("selfPeer", var()).toString());

    std::map<juce::String, juce::String> locks;
    if (auto* lo = args.getProperty ("locks", var()).getDynamicObject())
        for (auto& kv : lo->getProperties())
            locks[kv.name.toString()] = kv.value.toString();
    lockManager_.setLocks (std::move (locks));

    auto* o = new DynamicObject();
    o->setProperty ("active", true);
    o->setProperty ("selfPeer", lockManager_.selfPeer());
    return okResult ("mp_sync_locks", var (o));
}

juce::var MoshOps::cmdMpCreateSession (const juce::var& args)
{
    const auto code = mpSession_->createSession (args.getProperty ("name", var()).toString(),
                                                 args.getProperty ("color", var()).toString());
    if (code.isEmpty())
        return errResult ("mp_create_session", "could not reach the relay (MOSH_RELAY_URL)");
    refreshMpStemDir();   // PR-2: defensive re-stamp (also done at construction + project-file changes)
    auto* o = new DynamicObject();
    o->setProperty ("code", code);
    o->setProperty ("selfPeer", mpSession_->selfPeer());
    return okResult ("mp_create_session", var (o));
}

juce::var MoshOps::cmdMpJoinSession (const juce::var& args)
{
    if (! mpSession_->joinSession (args.getProperty ("code", var()).toString(),
                                   args.getProperty ("name", var()).toString(),
                                   args.getProperty ("color", var()).toString()))
        return errResult ("mp_join_session", "join failed (bad code / relay unreachable)");
    refreshMpStemDir();   // PR-2: defensive re-stamp (also done at construction + project-file changes)
    auto* o = new DynamicObject();
    o->setProperty ("selfPeer", mpSession_->selfPeer());
    return okResult ("mp_join_session", var (o));
}

juce::var MoshOps::cmdMpLeaveSession (const juce::var&)
{
    mpSession_->leaveSession();
    return okResult ("mp_leave_session");
}

juce::var MoshOps::cmdMpClaimTrack (const juce::var& args)
{
    auto* t = findTrack (args.getProperty ("trackId", var()).toString());
    if (t == nullptr)
        return errResult ("mp_claim_track", "no track");
    const auto lid = logicalid::ensureTrack (t->state);
    const int epoch = mpSession_->claim (lid);
    auto* o = new DynamicObject();
    o->setProperty ("granted", epoch >= 0);
    o->setProperty ("logicalId", lid);
    return okResult ("mp_claim_track", var (o));
}

juce::var MoshOps::cmdMpCommitTrack (const juce::var& args)
{
    auto* t = findTrack (args.getProperty ("trackId", var()).toString());
    if (t == nullptr)
        return errResult ("mp_commit_track", "no track");

    // P4 — content-address each wave clip's audio into <editDir>/audio/by-hash/ and
    // rewrite the clip to that RELATIVE ref, so the serialized state + the peer
    // resolve the same path once the bytes are fetched.
    auto byHashDir = eng.editFile().getParentDirectory().getChildFile ("audio").getChildFile ("by-hash");
    Array<var> audioRefs;
    juce::Array<juce::File> stemFiles;   // parallel to audioRefs; local paths only, PR-2's worker uploads these
    for (auto* c : t->getClips())
        if (auto* w = dynamic_cast<te::WaveAudioClip*> (c))
        {
            auto src = w->getCurrentSourceFile();
            if (! src.existsAsFile()) continue;
            juce::FileInputStream fis (src);
            if (! fis.openedOk()) continue;
            const auto hash = juce::SHA256 (fis).toHexString();
            const auto ext  = src.getFileExtension().removeCharacters (".");
            auto dest = byHashDir.getChildFile (hash + "." + ext);
            if (! dest.existsAsFile())
            {
                byHashDir.createDirectory();
                src.copyFileTo (dest);
            }
            if (src != dest)
                // Relative by-hash ref so the serialized state + the peer resolve the same
                // stem. repointWaveClipSource stores it relative to the edit file's PARENT
                // dir (not setToDirectFileReference's edit-FILE-relative "../" form, which
                // would escape the session dir and hang a later export — PR #104).
                repointWaveClipSource (*w, dest, eng.editFile().getParentDirectory(), true);
            auto* r = new DynamicObject(); r->setProperty ("hash", hash); r->setProperty ("ext", ext);
            audioRefs.add (var (r));
            stemFiles.add (dest);
        }

    eng.edit().flushState();
    const auto blob = trackcommit::serialize (*t);
    const auto lid  = logicalid::ensureTrack (t->state);

    // PR-2: everything above is synchronous engine work (an immutable content-
    // addressed snapshot, so further edits during the upload are safe by
    // construction). mpSession_->commit() does the upload + publish + lock release
    // on its transfer worker (or inline under MOSH_MP_SYNC_TRANSFER=1) and reports
    // completion via an additive `mp_commit_done` event — this returns immediately.
    bool asyncTransfer = false;
    if (blob.isNotEmpty())
    {
        asyncTransfer = ! mpSession_->syncTransferMode();
        mpSession_->commit (lid, blob, var (audioRefs), stemFiles);
    }

    auto* o = new DynamicObject();
    o->setProperty ("logicalId", lid);
    o->setProperty ("audioRefs", var (audioRefs));
    o->setProperty ("status", asyncTransfer ? "uploading" : "committed");
    return okResult ("mp_commit_track", var (o));
}

juce::var MoshOps::cmdMpBroadcastSelection (const juce::var& args)
{
    mpSession_->broadcastSelection (args.getProperty ("trackId", var()).toString(),
                                    args.getProperty ("clipId", var()).toString());
    return okResult ("mp_broadcast_selection");
}

juce::var MoshOps::cmdMpSendSignal (const juce::var& args)
{
    // Point-to-point WebRTC handshake (SDP/ICE) to one peer — the UI's video room owns
    // the negotiation; this only ferries the opaque payload over the relay.
    mpSession_->sendSignal (args.getProperty ("to", var()).toString(),
                            args.getProperty ("payload", var()));
    return okResult ("mp_send_signal");
}

juce::var MoshOps::broadcastStructuralIfActive (const juce::String& name, const juce::var& args, juce::var result)
{
    // Mirror a successful local session-global scalar op to the peer (LWW). Skipped
    // when single-player, or while applying a peer's op (echo-free).
    if (mpSession_ != nullptr && mpSession_->active() && ! applyingRemote_
        && (bool) result.getProperty ("ok", false))
        mpSession_->broadcastStructural (name, args);
    return result;
}

juce::var MoshOps::cmdMpApplyStructural (const juce::var& args)
{
    // Re-execute a peer's structural op locally: applyingRemote_ bypasses the lock
    // guard (it is incoming history) AND short-circuits broadcastStructuralIfActive
    // (no echo). The inner command's own emit repaints the UI.
    auto* c = new DynamicObject();
    c->setProperty ("command", args.getProperty ("command", var()));
    c->setProperty ("args", args.getProperty ("args", var()));

    applyingRemote_ = true;
    auto r = execute (var (c));
    applyingRemote_ = false;
    return okResult ("mp_apply_structural", r);
}

// PR-2: shared by cmdMpSerializeProject (the public, directly-callable command,
// which uploads synchronously itself right after — kept behavior-compatible for
// existing direct-call tests) and serializeProjectForBootstrapAnswer (the live-
// session bootstrap-answer path, whose worker uploads instead). Content-addresses
// + rewrites + serializes every track's clips; uploads NOTHING itself. Returns
// {tracks:[{logicalId,blob,audioRefs}], count, annotations, stemFiles:[{hash,ext,path}]}
// — stemFiles is the flattened list across all tracks (what a bootstrap-answer
// upload job needs; audioRefs stays nested per-track for the wire message, as before).
juce::var MoshOps::contentAddressWholeProjectNoUpload()
{
    // Each track's wave clips are content-addressed into <editDir>/audio/by-hash/ and
    // rewritten to that RELATIVE ref, with the by-hash refs attached to the track
    // entry — so a guest who joins mid-session adopts pre-existing AUDIO, not just
    // structure/MIDI. Mirrors the commit path (cmdMpCommitTrack).
    auto byHashDir = eng.editFile().getParentDirectory().getChildFile ("audio").getChildFile ("by-hash");
    juce::Array<var> tracks;
    juce::Array<var> stemFiles;
    for (auto* t : te::getAudioTracks (eng.edit()))
    {
        if (t == nullptr) continue;

        Array<var> audioRefs;
        for (auto* c : t->getClips())
            if (auto* w = dynamic_cast<te::WaveAudioClip*> (c))
            {
                auto src = w->getCurrentSourceFile();
                if (! src.existsAsFile()) continue;
                juce::FileInputStream fis (src);
                if (! fis.openedOk()) continue;
                const auto hash = juce::SHA256 (fis).toHexString();
                const auto ext  = src.getFileExtension().removeCharacters (".");
                auto dest = byHashDir.getChildFile (hash + "." + ext);
                if (! dest.existsAsFile())
                {
                    byHashDir.createDirectory();
                    src.copyFileTo (dest);
                }
                if (src != dest)
                    // Relative by-hash ref (repointWaveClipSource's PARENT-relative form, not
                    // setToDirectFileReference's edit-FILE-relative "../" — PR #104), so the
                    // serialized blob + the joiner resolve the same path once bytes are fetched.
                    repointWaveClipSource (*w, dest, eng.editFile().getParentDirectory(), true);
                auto* r = new DynamicObject(); r->setProperty ("hash", hash); r->setProperty ("ext", ext);
                audioRefs.add (var (r));

                auto* sf = new DynamicObject();
                sf->setProperty ("hash", hash);
                sf->setProperty ("ext", ext);
                sf->setProperty ("path", dest.getFullPathName());
                stemFiles.add (var (sf));
            }

        eng.edit().flushState();   // AFTER the repoints, so the serialized state carries the by-hash refs
        auto* o = new DynamicObject();
        o->setProperty ("logicalId", logicalid::ensureTrack (t->state));
        o->setProperty ("blob", trackcommit::serialize (*t));
        // Refs ride INSIDE the track entry: MultiplayerSession's bootstrap marshaling copies
        // only `tracks`/`annotations`, so a top-level refs field would be dropped on the wire.
        o->setProperty ("audioRefs", var (audioRefs));
        tracks.add (var (o));
    }
    auto* d = new DynamicObject();
    d->setProperty ("tracks", tracks);
    d->setProperty ("count", tracks.size());
    d->setProperty ("stemFiles", var (stemFiles));
    // Annotations are a top-level Edit child (a sibling of the tracks), so the per-track
    // blobs above don't carry them — serialize the subtree so a late-joiner adopts the
    // host's existing pins, not just the ones created live after they join.
    if (auto a = eng.edit().state.getChildWithName (ids::MOSH_ANNOTATIONS); a.isValid())
        if (auto xml = a.createXml())
            d->setProperty ("annotations", xml->toString());
    return var (d);
}

juce::var MoshOps::cmdMpSerializeProject (const juce::var&)
{
    // P6 — the whole project as a bundle of per-track blobs, for a late-joiner.
    // Closes the old "bootstrap audio not wired" gap. Graceful on the local relay
    // (uploadBlob no-ops there pre-PR-1; now the local relay has a blob store too).
    auto d = contentAddressWholeProjectNoUpload();

    // Upload the stems (content-addressed dedup) so the joiner can fetch what it
    // lacks. Kept SYNCHRONOUS here (unlike the live-session bootstrap-answer path,
    // PR-2, whose worker uploads instead) so this public, directly-callable command
    // stays behavior-compatible with existing direct-call tests.
    if (auto* sf = d.getProperty ("stemFiles", var()).getArray())
        for (auto& s : *sf)
        {
            const auto h = s.getProperty ("hash", var()).toString();
            const auto e = s.getProperty ("ext", var()).toString();
            const auto p = s.getProperty ("path", var()).toString();
            mpSession_->uploadBlob (h, e, juce::File (p));
        }
    return okResult ("mp_serialize_project", d);
}

juce::var MoshOps::serializeProjectForBootstrapAnswer()
{
    // PR-2: the message-thread part of the host's bootstrap answer -- content-
    // address + serialize (touches the engine, so it must run here, on the message
    // thread) WITHOUT uploading; the session's transfer worker uploads the returned
    // stemFiles[] and then publishes bootstrap_state (see MultiplayerSession::pollLoop's
    // "bootstrap_request" handling).
    return contentAddressWholeProjectNoUpload();
}

juce::var MoshOps::cmdMpApplyBootstrap (const juce::var& args)
{
    // P6 — adopt a peer's project: drop our local tracks, rebuild from the bundle.
    // nullptr UndoManager + no relay echo (this is incoming history, like a commit).
    auto& edit = eng.edit();
    for (auto* t : te::getAudioTracks (edit))
        if (t != nullptr)
        {
            auto st = t->state;
            st.getParent().removeChild (st, nullptr);
        }

    // PR-2: bundles arriving through the LIVE SESSION path (MultiplayerSession's
    // "bootstrap_state" handling) have already had every stem prefetched by the
    // transfer worker before this is called — stemsPrefetched:true skips the inline
    // download loop below entirely. Direct calls (the harness/agents/`mp_apply_bootstrap`
    // outside a live session) never set this flag, so their own inline download runs
    // exactly as before — the direct-command contract is unchanged.
    const bool stemsPrefetched = (bool) args.getProperty ("stemsPrefetched", false);

    int applied = 0;
    auto byHashDir = eng.editFile().getParentDirectory().getChildFile ("audio").getChildFile ("by-hash");
    if (auto* arr = args.getProperty ("tracks", var()).getArray())
        for (auto& tv : *arr)
        {
            // Fetch any by-hash stems this track references (into audio/by-hash/) BEFORE
            // applying, so its pre-existing wave clips resolve without a host re-commit —
            // the late-join analogue of the commit-apply download. The result is ignored
            // here (a transient failure just leaves the clip sourceMissing) — the
            // self-heal pass below retries anything still missing once the tracks land.
            if (! stemsPrefetched)
                if (auto* refs = tv.getProperty ("audioRefs", var()).getArray())
                    for (auto& a : *refs)
                    {
                        const auto h = a.getProperty ("hash", var()).toString();
                        const auto e = a.getProperty ("ext", var()).toString();
                        if (h.isEmpty()) continue;
                        if (auto dest = byHashDir.getChildFile (h + "." + e); ! dest.existsAsFile())
                            mpSession_->downloadBlob (h, e, dest);
                    }
            const auto blob = tv.getProperty ("blob", var()).toString();
            if (blob.isNotEmpty() && trackcommit::apply (edit, blob).ok)
                ++applied;
        }

    // Adopt the host's annotations (a top-level Edit child, outside the per-track blobs):
    // drop ours, graft the host's subtree. nullptr UndoManager — incoming history, like
    // the track splices above.
    if (auto existing = edit.state.getChildWithName (ids::MOSH_ANNOTATIONS); existing.isValid())
        edit.state.removeChild (existing, nullptr);
    if (const auto annXml = args.getProperty ("annotations", var()).toString(); annXml.isNotEmpty())
        if (auto xml = juce::parseXML (annXml))
            if (auto vt = juce::ValueTree::fromXml (*xml); vt.isValid())
                edit.state.appendChild (vt, nullptr);

    eng.markDirty();
    emitSnapshotInvalidated();

    // P4 self-heal (PR-1): the download loop above ignores its result, so a transient
    // upload/download failure during THIS bootstrap (or a peer's blob that hadn't
    // finished landing) can leave a just-applied clip sourceMissing. Kick off a retry
    // pass so the guest doesn't need the host to notice and re-commit that track — a
    // no-op (synchronous, effectively free) when nothing is missing.
    cmdMpFetchMissingStems (var (new DynamicObject()));

    auto* d = new DynamicObject();
    d->setProperty ("applied", applied);
    return okResult ("mp_apply_bootstrap", var (d));
}

juce::var MoshOps::cmdMpFetchMissingStems (const juce::var& args)
{
    // Self-heal (P4/PR-1): every uploadBlob/downloadBlob result in mp_commit_track,
    // mp_serialize_project, mp_apply_bootstrap, and applyMultiplayerCommitMessage is
    // ignored at its call site — a single transient HTTP failure otherwise leaves a
    // clip's audio sourceMissing forever, with the host manually re-committing that
    // track as the only prior recovery ("nudging"). This command self-heals: it
    // enumerates every wave clip whose source is currently missing, recognizes the
    // ones referencing a content-addressed by-hash stem (repointWaveClipSource's own
    // form: ".../audio/by-hash/<64-hex-sha256>.<ext>" — the hash IS the fetch key, no
    // separate bookkeeping needed), and retries the download for exactly those. A
    // clip missing its source for any OTHER reason (a plain moved/deleted local file)
    // is untouched — that is relink_clip's job, not a peer blob store's.
    struct Missing
    {
        juce::String clipId, hash, ext;
        juce::File dest;
    };
    juce::Array<Missing> missing;

    for (auto* t : te::getAudioTracks (eng.edit()))
    {
        if (t == nullptr) continue;
        for (auto* c : t->getClips())
            if (auto* w = dynamic_cast<te::WaveAudioClip*> (c))
            {
                const auto resolved = w->getCurrentSourceFile();
                if (resolved.existsAsFile()) continue;

                if (resolved.getParentDirectory().getFileName() != "by-hash") continue;
                const auto stem = resolved.getFileNameWithoutExtension();
                if (stem.length() != 64 || ! stem.containsOnly ("0123456789abcdef")) continue;

                // Adversarial-review finding #3 (originally a MoshOps-local, message-
                // thread-only set) — a concurrent pass is already fetching this exact
                // hash; skip it here rather than spawn a second downloadBlob into the
                // SAME dest file (delete-then-create-then-stream), whose partial state
                // the other pass's existsAsFile()/size check could otherwise observe.
                // SHOULD-FIX (PR-2 review): this registry now lives on mpSession_
                // (thread-safe, mutex-guarded) instead of a MoshOps-local set, because
                // the transfer worker's OWN prefetch (MultiplayerSession::prefetchAudioRefs,
                // a DIFFERENT OS thread) can want the SAME hash concurrently — a
                // message-thread-only set couldn't see across that boundary.
                // claimStem() atomically tests-and-claims: a false here means someone
                // else (this same scan's earlier duplicate, or the worker thread) has
                // it, so skip rather than add it to `missing` at all. A null mpSession_
                // can't claim anything -- fall through and add it anyway (the download
                // attempt below safely no-ops on a null session).
                if (mpSession_ != nullptr && ! mpSession_->claimStem (stem)) continue;

                missing.add ({ c->itemID.toString(), stem,
                              resolved.getFileExtension().removeCharacters ("."), resolved });
            }
    }

    // Runs on the message thread: re-resolve each clip by id (it may have been
    // removed/undone since the scan above — findClip returns nullptr, skipped), write
    // the fetched bytes' arrival into the clip's cached source (sourceMediaChanged,
    // mirroring repointWaveClipSource's own post-repoint call), and emit exactly one
    // snapshot_invalidated if anything actually landed. downloadBlob (adversarial-review
    // finding #1) now verifies the downloaded bytes' SHA-256 against `hash` itself before
    // reporting success, so a truncated/corrupt transfer is never blessed as resolved here.
    auto land = [this] (const juce::Array<Missing>& items) -> juce::var
    {
        int fetched = 0, failed = 0;
        juce::Array<var> stillMissing;
        for (auto& m : items)
        {
            const bool got = mpSession_ != nullptr
                             && mpSession_->downloadBlob (m.hash, m.ext, m.dest)
                             && m.dest.existsAsFile();
            if (got)
            {
                if (auto* w = dynamic_cast<te::WaveAudioClip*> (findClip (m.clipId)))
                    w->sourceMediaChanged();
                ++fetched;
            }
            else
            {
                ++failed;
                stillMissing.add (m.hash);
            }
            if (mpSession_ != nullptr) mpSession_->releaseStem (m.hash);
        }
        if (fetched > 0)
            emitSnapshotInvalidated();

        auto* d = new DynamicObject();
        d->setProperty ("fetched", fetched);
        d->setProperty ("failed", failed);
        d->setProperty ("stillMissing", var (stillMissing));
        return okResult ("mp_fetch_missing_stems", var (d));
    };

    const bool wait = (bool) args.getProperty ("wait", false);
    if (missing.isEmpty() || wait)
        return land (missing);

    // Async (GUI / the bootstrap auto-trigger): downloadBlob does blocking HTTP, so it
    // must not run on the message thread (mirrors cmdTranscribeClip's dual-mode shape).
    // The clip lookup + sourceMediaChanged()/emitSnapshotInvalidated() are message-
    // thread-only, so only the network round-trip runs on the background thread;
    // results land back via callAsync. releaseStem() is thread-safe (SHOULD-FIX, PR-2
    // review), so each item's claim is released right on the background thread,
    // immediately after its own download attempt — shorter hold time than batching
    // every release into the final callAsync.
    std::thread ([this, missing]
    {
        if (mpSession_ == nullptr || ! mpSession_->active())
        {
            // Bailed before attempting anything -- still release the in-flight marks
            // so a later pass isn't permanently skipped.
            for (auto& m : missing)
                if (mpSession_ != nullptr) mpSession_->releaseStem (m.hash);
            return;
        }

        struct Result { juce::String clipId, hash; bool ok; };
        juce::Array<Result> results;
        for (auto& m : missing)
        {
            const bool got = mpSession_->downloadBlob (m.hash, m.ext, m.dest) && m.dest.existsAsFile();
            results.add ({ m.clipId, m.hash, got });
            mpSession_->releaseStem (m.hash);
        }

        juce::MessageManager::callAsync ([this, results]
        {
            int fetched = 0;
            for (auto& r : results)
            {
                if (r.ok)
                {
                    if (auto* w = dynamic_cast<te::WaveAudioClip*> (findClip (r.clipId)))
                        w->sourceMediaChanged();
                    ++fetched;
                }
            }
            if (fetched > 0)
                emitSnapshotInvalidated();
        });
    }).detach();

    auto* data = new DynamicObject();
    data->setProperty ("status", "started");
    return okResult ("mp_fetch_missing_stems", var (data));
}

juce::var MoshOps::cmdUngroupTrack (const juce::var& args)
{
    auto& edit = eng.edit();
    const auto id = args.getProperty ("trackId", var()).toString();
    auto* folder = findGroupTrack (id);
    if (folder == nullptr) return errResult ("ungroup_track", "no group track: " + id);

    // Collect the folder's direct children before mutating.
    juce::Array<te::Track*> children;
    for (auto* t : te::getAllTracks (edit))
        if (t != nullptr && t->getParentTrack() == folder)
            children.add (t);

    beginTxn ("ungroup_track");

    // Hoist each child to the top level right after the folder (order preserved),
    // then delete the now-empty folder. One transaction = one undo step.
    te::Track* preceding = folder;
    for (auto* c : children)
    {
        edit.moveTrack (c, te::TrackInsertPoint (nullptr, preceding));
        preceding = c;
    }
    edit.deleteTrack (folder);

    if (! eng.hasAudio())
        if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
            mm->runDispatchLoopUntil (1);

    auto* data = new DynamicObject();
    data->setProperty ("hoisted", children.size());
    logLine ("ungroup_track", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("ungroup_track", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// RTG-001 / RTG-002 — per-track input choice + output routing
//
// Both ride engine machinery that already exists: the DeviceManager builds one
// WaveInputDevice per stereo pair / mono channel (so "input 3-4" is a device),
// and every AudioTrack owns a te::TrackOutput that can route to any hardware
// out OR into another track (the graph sums feeders via a SummingNode — an
// implicit bus, with cycle detection). Mosh adds only the choice surface.
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdListWaveInputs (const juce::var&)
{
    // Read-only audio-input enumeration (RTG-001) — modelled on cmdListMidiInputs:
    // no transaction, no log line, no event. Headless the wave-input list is empty
    // (devices exist only once CoreAudio is up) -> a well-formed empty array.
    auto& dm = eng.engine().getDeviceManager();

    Array<var> inputs;
    for (int i = 0; i < dm.getNumWaveInDevices(); ++i)
        if (auto* wi = dm.getWaveInDevice (i))
        {
            auto* o = new DynamicObject();
            o->setProperty ("deviceID", wi->getDeviceID());
            o->setProperty ("name", wi->getName());
            o->setProperty ("enabled", wi->isEnabled());
            o->setProperty ("isStereoPair", wi->isStereoPair());
            inputs.add (var (o));
        }

    auto* data = new DynamicObject();
    data->setProperty ("inputs", inputs);
    data->setProperty ("audioEnabled", eng.hasAudio());
    return okResult ("list_wave_inputs", var (data));
}

juce::var MoshOps::cmdSetTrackInput (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_track_input", "no track");
    const auto deviceID = args.getProperty ("deviceID", var()).toString();
    if (deviceID.isEmpty()) return errResult ("set_track_input", "missing 'deviceID'");

    // A monitoring/routing PREFERENCE (like arm_track / set_input_monitor): the
    // engine binds input destinations without the undo manager, so no transaction.
    // The CHOICE is stored on the track's own state tree (saves/reloads with the
    // edit) and arm_track prefers it over first-match.
    track->state.setProperty (ids::moshInputDevice, deviceID, nullptr);

    // Live application: retarget the chosen wave instance to this track. Headless
    // (no playback context) there are no instances -> graceful applied:false.
    bool applied = false;
    bool wasArmed = false;
    te::InputDeviceInstance* chosen = nullptr;
    for (auto* inst : eng.edit().getAllInputDevices())
    {
        if (inst == nullptr || inst->getInputDevice().isMidi()) continue;
        if (te::isOnTargetTrack (*inst, *track, 0))
        {
            wasArmed = inst->isRecordingEnabled (track->itemID);
            if (inst->getInputDevice().getDeviceID() != deviceID)
            {
                // Clear the old assignment; ignore the Result (a missing target
                // is already the state we want).
                [[maybe_unused]] auto r = inst->removeTarget (track->itemID, nullptr);
            }
        }
        if (inst->getInputDevice().getDeviceID() == deviceID)
            chosen = inst;
    }
    if (chosen != nullptr)
    {
        // setTarget returns tl::expected — check, never blind-deref.
        if (auto r = chosen->setTarget (track->itemID, true, nullptr, 0))
        {
            if (wasArmed)
                chosen->setRecordingEnabled (track->itemID, true);   // keep the arm across the swap
            applied = true;
        }
        else
        {
            logLine ("set_track_input", args, false, r.error(), false);
            return errResult ("set_track_input", r.error());
        }
    }

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("deviceID", deviceID);
    data->setProperty ("applied", applied);
    if (! applied) data->setProperty ("reason", "no live input instance (choice stored)");
    logLine ("set_track_input", args, true, {}, false);   // preference — not undoable
    emitSnapshotInvalidated();
    return okResult ("set_track_input", var (data));
}

juce::var MoshOps::cmdListTrackOutputs (const juce::var&)
{
    // Read-only output enumeration (RTG-002): the hardware wave outs + every audio
    // track as a candidate route-to-track destination (an implicit submix). No
    // transaction, no log line. Headless: empty device list, tracks still listed.
    auto& dm = eng.engine().getDeviceManager();

    Array<var> outputs;
    for (int i = 0; i < dm.getNumWaveOutDevices(); ++i)
        if (auto* wo = dm.getWaveOutDevice (i))
        {
            auto* o = new DynamicObject();
            o->setProperty ("deviceID", wo->getDeviceID());
            o->setProperty ("name", wo->getName());
            o->setProperty ("enabled", wo->isEnabled());
            outputs.add (var (o));
        }

    Array<var> trackDests;
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr)
        {
            auto* o = new DynamicObject();
            o->setProperty ("id", t->itemID.toString());
            o->setProperty ("name", t->getName());
            trackDests.add (var (o));
        }

    auto* data = new DynamicObject();
    data->setProperty ("outputs", outputs);
    data->setProperty ("tracks", trackDests);
    data->setProperty ("audioEnabled", eng.hasAudio());
    return okResult ("list_track_outputs", var (data));
}

juce::var MoshOps::cmdSetTrackOutput (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_track_output", "no track");
    auto& out = track->getOutput();

    // Three destination forms: { destTrackId } routes into another track (implicit
    // bus), { deviceID } routes to a hardware out, { output: "default" } resets.
    // TrackOutput state is CachedValue-bound to the Edit's UndoManager -> undoable.
    if (args.hasProperty ("destTrackId"))
    {
        const auto destId = args.getProperty ("destTrackId", var()).toString();
        auto* dest = findTrack (destId);
        if (dest == nullptr) return errResult ("set_track_output", "no destination track: " + destId);
        if (dest == track)   return errResult ("set_track_output", "a track cannot output to itself");
        // Cycle guard BEFORE applying: if the destination already feeds into this
        // track (directly or transitively), routing track->dest would loop.
        if (dest->getOutput().feedsInto (track))
            return errResult ("set_track_output", "routing would create a cycle");

        beginTxn ("set_track_output");
        out.setOutputToTrack (dest);
        logLine ("set_track_output", args, true, {}, true);
        emitSnapshotInvalidated();
        auto* data = new DynamicObject();
        data->setProperty ("trackId", track->itemID.toString());
        data->setProperty ("destTrackId", dest->itemID.toString());
        return okResult ("set_track_output", var (data));
    }

    if (args.hasProperty ("deviceID"))
    {
        const auto deviceID = args.getProperty ("deviceID", var()).toString();
        if (deviceID.isEmpty()) return errResult ("set_track_output", "empty 'deviceID'");
        // With a live device manager, validate the id; headless the list is empty,
        // so accept it as persisted intent (the graph resolves it when audio is up;
        // a missing device falls back to silence + the UI shows the stored name).
        if (eng.hasAudio())
        {
            auto& dm = eng.engine().getDeviceManager();
            bool known = false;
            for (int i = 0; i < dm.getNumWaveOutDevices(); ++i)
                if (auto* wo = dm.getWaveOutDevice (i))
                    if (wo->getDeviceID() == deviceID) { known = true; break; }
            if (! known) return errResult ("set_track_output", "unknown output device: " + deviceID);
        }
        beginTxn ("set_track_output");
        out.setOutputToDeviceID (deviceID);
        logLine ("set_track_output", args, true, {}, true);
        emitSnapshotInvalidated();
        auto* data = new DynamicObject();
        data->setProperty ("trackId", track->itemID.toString());
        data->setProperty ("deviceID", deviceID);
        return okResult ("set_track_output", var (data));
    }

    if (args.getProperty ("output", var()).toString() == "default")
    {
        beginTxn ("set_track_output");
        out.setOutputToDefaultDevice (false /*isMidi*/);
        logLine ("set_track_output", args, true, {}, true);
        emitSnapshotInvalidated();
        auto* data = new DynamicObject();
        data->setProperty ("trackId", track->itemID.toString());
        data->setProperty ("output", "default");
        return okResult ("set_track_output", var (data));
    }

    return errResult ("set_track_output", "expected 'destTrackId', 'deviceID', or output:'default'");
}

juce::var MoshOps::cmdUndo (const juce::var& args)
{
    const bool did = undoManager().undo();
    if (did) eng.markDirty();               // edit content changed → needs re-save (gap 1)
    logLine ("undo", args, did, did ? String() : String ("nothing to undo"), false);
    emitSnapshotInvalidated();
    return okResult ("undo", var (did));
}

juce::var MoshOps::cmdRedo (const juce::var& args)
{
    const bool did = undoManager().redo();
    if (did) eng.markDirty();               // edit content changed → needs re-save (gap 1)
    logLine ("redo", args, did, did ? String() : String ("nothing to redo"), false);
    emitSnapshotInvalidated();
    return okResult ("redo", var (did));
}

// Agent batch grouping: batch_begin opens ONE undo transaction; every command run
// while inBatch skips its own beginNewTransaction (see beginTxn), so the whole batch
// is a single undo step. batch_end closes it. The agent ("Monster changes") brackets
// its edits with these so one Undo reverts the entire batch.
juce::var MoshOps::cmdBatchBegin (const juce::var& args)
{
    if (inBatch)
        return errResult ("batch_begin", "a batch is already open");
    const auto label = args.getProperty ("name", var ("agent edit")).toString();
    undoManager().beginNewTransaction (label);
    inBatch = true;
    logLine ("batch_begin", args, true, {}, false);
    return okResult ("batch_begin");
}

juce::var MoshOps::cmdBatchEnd (const juce::var& args)
{
    if (! inBatch)
        return errResult ("batch_end", "no batch is open");
    inBatch = false;
    logLine ("batch_end", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("batch_end");
}

juce::var MoshOps::cmdSave (const juce::var& args)
{
    const bool ok = eng.save();
    logLine ("save", args, ok, ok ? String() : String ("save failed"), false);
    return ok ? okResult ("save") : errResult ("save", "save failed");
}

juce::var MoshOps::cmdReload (const juce::var& args)
{
    unregisterAllMeterClients();        // old measurers are still valid here
    // PRJ-FMT — a newer-format file on disk is refused; the current Edit is kept untouched.
    if (auto refusal = eng.reloadFromFile(); refusal.isNotEmpty())   // reconcileMeterClients() re-registers next frame
    {
        logLine ("reload", args, false, refusal, false);
        emitSnapshotInvalidated();
        return errResult ("reload", refusal);
    }
    logFile = eng.sessionDir().getChildFile ("mosh-log.jsonl");
    invalidateCommandLogCache();
    logLine ("reload", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("reload");
}

juce::var MoshOps::cmdAddRenderLayer (const juce::var& args)
{
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (clipId);
    if (clip == nullptr) return errResult ("add_render_layer", "no clip: " + clipId);

    beginTxn ("add_render_layer");
    auto pos = clip->getPosition();
    auto node = RenderLayer::create (
        "rl-" + String (Time::getCurrentTime().toMilliseconds()),
        clip->itemID.toString(),
        pos.getStart().inSeconds(), pos.getEnd().inSeconds(),
        args.getProperty ("adapter", "fake").toString());
    clip->state.appendChild (node, &undoManager());

    auto* data = new DynamicObject();
    data->setProperty ("layerId", node[ids::id].toString());
    logLine ("add_render_layer", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("add_render_layer", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2 — arrangement editing
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdMoveClip (const juce::var& args)
{
    const auto id = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (id);
    if (clip == nullptr) return errResult ("move_clip", "no clip: " + id);

    beginTxn ("move_clip");
    const double newStart = juce::jmax (0.0, (double) args.getProperty ("start", clip->getPosition().getStart().inSeconds()));
    clip->setStart (tracktion::TimePosition::fromSeconds (newStart), false, true);   // keep length

    // Optional move to another track.
    if (args.hasProperty ("trackId"))
        if (auto* dest = findTrack (args.getProperty ("trackId", var()).toString()))
            if (dest != clip->getTrack())
                clip->moveTo (*dest);

    logLine ("move_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("move_clip");
}

juce::var MoshOps::cmdTrimClip (const juce::var& args)
{
    const auto id = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (id);
    if (clip == nullptr) return errResult ("trim_clip", "no clip: " + id);

    auto pos = clip->getPosition();
    const double start  = (double) args.getProperty ("start",  pos.getStart().inSeconds());
    const double length = juce::jmax (0.01, (double) args.getProperty ("length", pos.getLength().inSeconds()));
    const double offset = (double) args.getProperty ("offset", pos.getOffset().inSeconds());

    beginTxn ("trim_clip");
    clip->setPosition ({ { tracktion::TimePosition::fromSeconds (start),
                           tracktion::TimeDuration::fromSeconds (length) },
                         tracktion::TimeDuration::fromSeconds (offset) });
    logLine ("trim_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouch (id);   // Phase 3 — a length/offset change re-bounces the source window
    return okResult ("trim_clip");
}

juce::var MoshOps::cmdSplitClip (const juce::var& args)
{
    const auto id = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (id);
    if (clip == nullptr) return errResult ("split_clip", "no clip: " + id);
    auto* clipTrack = dynamic_cast<te::ClipTrack*> (clip->getTrack());
    if (clipTrack == nullptr) return errResult ("split_clip", "clip not on a clip track");

    // Split-point normalization (r4 gate-miss fix plan P1): agents and utterances mix
    // ABSOLUTE and CLIP-RELATIVE times ("split at 8s" on a clip spanning [4,12] can mean
    // t=8 or start+8). Absolute wins when it lands strictly inside; otherwise a value
    // that resolves inside as start+t is treated as clip-relative. Exact edges and
    // truly-outside values error with the resolved point + range (previously Tracktion's
    // splitClip silently no-opped and we returned ok with no newClipId).
    const double reqAt = (double) args.getProperty ("time", 0.0);
    const double cStart = clip->getPosition().getStart().inSeconds();
    const double cEnd   = clip->getPosition().getEnd().inSeconds();
    constexpr double kSplitEps = 1.0e-6;
    const auto insideClip = [&] (double x) { return x > cStart + kSplitEps && x < cEnd - kSplitEps; };
    double at = reqAt;
    if (! insideClip (at))
    {
        if (const double rel = cStart + reqAt; insideClip (rel))
            at = rel;
        else
            return errResult ("split_clip",
                "split point outside clip: time " + juce::String (reqAt, 3)
                + " (relative candidate " + juce::String (cStart + reqAt, 3)
                + ") not strictly inside [" + juce::String (cStart, 3) + ", "
                + juce::String (cEnd, 3) + "]");
    }
    beginTxn ("split_clip");
    auto* newClip = clipTrack->splitClip (*clip, tracktion::TimePosition::fromSeconds (at));

    auto* data = new DynamicObject();
    if (newClip != nullptr) data->setProperty ("newClipId", newClip->itemID.toString());
    logLine ("split_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("split_clip", var (data));
}

juce::var MoshOps::cmdRemoveClip (const juce::var& args)
{
    auto* clip = findClip (args.getProperty ("clipId", var()).toString());
    if (clip == nullptr) return errResult ("remove_clip", "no clip");
    beginTxn ("remove_clip");
    // Phase 2 — if this MIDI/drum clip owns a hidden beneath-render, remove the hidden audio with it
    // (else it's orphaned on the track). The source mute goes away with the clip itself.
    if (auto node = clip->state.getChildWithName (ids::MOSH_RENDERLAYER);
        node.isValid() && (bool) node[kSourceMutedByLayer])
        if (auto hiddenId = node[kLandedClipId].toString(); hiddenId.isNotEmpty())
            if (auto* hidden = findClip (hiddenId); hidden != nullptr && hidden != clip)
                hidden->removeFromParent();
    clip->removeFromParent();
    logLine ("remove_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_clip");
}

juce::var MoshOps::cmdRenameClip (const juce::var& args)
{
    auto* clip = findClip (args.getProperty ("clipId", var()).toString());
    if (clip == nullptr) return errResult ("rename_clip", "no clip");
    beginTxn ("rename_clip");
    clip->setName (args.getProperty ("name", var()).toString());
    logLine ("rename_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("rename_clip");
}

juce::var MoshOps::cmdSetClipMute (const juce::var& args)
{
    auto* clip = findClip (args.getProperty ("clipId", var()).toString());
    if (clip == nullptr) return errResult ("set_clip_mute", "no clip");
    beginTxn ("set_clip_mute");
    clip->setMuted ((bool) args.getProperty ("mute", false));
    logLine ("set_clip_mute", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_clip_mute");
}

juce::var MoshOps::cmdSetClipGain (const juce::var& args)
{
    auto* ac = dynamic_cast<te::AudioClipBase*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (ac == nullptr) return errResult ("set_clip_gain", "not an audio clip");
    beginTxn ("set_clip_gain");
    ac->setGainDB (juce::jlimit (-48.0f, 24.0f, (float) (double) args.getProperty ("gainDb", 0.0)));
    logLine ("set_clip_gain", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_clip_gain");
}

// G4b — clip fades. String -> AudioFadeCurve::Type, default linear (mirrors the enum
// tracktion_AudioFadeCurve.h ships: linear=1, convex=2, concave=3, sCurve=4).
static te::AudioFadeCurve::Type fadeCurveFromName (const juce::String& name)
{
    if (name.equalsIgnoreCase ("convex"))  return te::AudioFadeCurve::convex;
    if (name.equalsIgnoreCase ("concave")) return te::AudioFadeCurve::concave;
    if (name.equalsIgnoreCase ("sCurve") || name.equalsIgnoreCase ("scurve")) return te::AudioFadeCurve::sCurve;
    return te::AudioFadeCurve::linear;
}

juce::var MoshOps::cmdSetClipFade (const juce::var& args)
{
    // Clip-edge fades (reality-pack inv 30: "affect edges without moving clip boundaries").
    // setFadeIn/setFadeOut (AudioClipBase.cpp) clamp to [0, clipLength] and rescale if
    // fadeIn+fadeOut exceeds the clip length — no boundary move, ever. Audio-clip-only,
    // mirrors set_clip_gain. Fades bind to the clip's own ValueTree via a plain
    // CachedValue.referTo(state, id, um) — the SAME undo/persistence path as clip gain,
    // so this is undoable + save/reload-durable with zero src/state schema change.
    auto* ac = dynamic_cast<te::AudioClipBase*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (ac == nullptr) return errResult ("set_clip_fade", "not an audio clip");
    beginTxn ("set_clip_fade");
    if (args.hasProperty ("fadeInSec"))
        ac->setFadeIn  (tracktion::TimeDuration::fromSeconds (juce::jmax (0.0, (double) args.getProperty ("fadeInSec",  0.0))));
    if (args.hasProperty ("fadeOutSec"))
        ac->setFadeOut (tracktion::TimeDuration::fromSeconds (juce::jmax (0.0, (double) args.getProperty ("fadeOutSec", 0.0))));
    if (args.hasProperty ("curveIn"))
        ac->setFadeInType  (fadeCurveFromName (args.getProperty ("curveIn",  "linear").toString()));
    if (args.hasProperty ("curveOut"))
        ac->setFadeOutType (fadeCurveFromName (args.getProperty ("curveOut", "linear").toString()));
    logLine ("set_clip_fade", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("clipId", ac->itemID.toString());
    data->setProperty ("fadeInSec",  ac->getFadeIn().inSeconds());
    data->setProperty ("fadeOutSec", ac->getFadeOut().inSeconds());
    return okResult ("set_clip_fade", var (data));
}

juce::var MoshOps::cmdRelinkClip (const juce::var& args)
{
    // gap 3 — relink-on-load: re-point a wave clip whose source went missing (a project
    // moved off-machine, audio renamed, etc.) to a user-chosen file. Stores the ref
    // relative iff the new file lives under the project dir (keeps a relinked-to-local
    // file portable), else absolute. Undoable.
    const auto id   = args.getProperty ("clipId", var()).toString();
    const auto path = args.getProperty ("file", var()).toString();
    if (path.isEmpty()) return errResult ("relink_clip", "missing 'file'");
    File newFile (path);
    if (! newFile.existsAsFile()) return errResult ("relink_clip", "file not found: " + path);
    auto* w = dynamic_cast<te::WaveAudioClip*> (findClip (id));
    if (w == nullptr) return errResult ("relink_clip", "wave clip not found: " + id);

    beginTxn ("relink_clip");
    // Relative ref iff the new file lives under the project dir (keeps a relinked-to-local
    // file portable), else absolute. repointWaveClipSource stores the relative form against
    // the edit file's PARENT dir — NOT setToDirectFileReference's edit-FILE-relative "../"
    // form, which (when the edit isn't yet on disk) escapes the session dir and would hang a
    // later offline export (the same mechanism PR #104 fixed for mp_commit_track).
    const bool local = newFile.isAChildOf (eng.editFile().getParentDirectory());
    repointWaveClipSource (*w, newFile, eng.editFile().getParentDirectory(), local);
    logLine ("relink_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("relink_clip");
}

// Minimum normalized-autocorrelation peak (0..1) for a detected BPM to be trusted
// over the map-tempo default. A pure tone / silence scores ~0 and falls back.
static constexpr double kBpmDetectConfidence = 0.10;

// Offline loop-BPM estimate from an audio file: build a coarse onset-energy
// envelope (positive first-difference of per-hop RMS), autocorrelate it across a
// musical tempo range, argmax. Pure + deterministic (no service) so it runs inside
// --selftest. Returns {bpm, confidence}; confidence is the normalized autocorrelation
// at the winning lag (0 == flat/no beat, up toward 1 == a strong periodic pulse).
static std::pair<double, double> detectBpmFromFile (const juce::File& file)
{
    juce::AudioFormatManager fm; fm.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader (fm.createReaderFor (file));
    if (reader == nullptr || reader->lengthInSamples <= 0 || reader->sampleRate <= 0.0)
        return { 0.0, 0.0 };

    const double sr = reader->sampleRate;
    const int chans = (int) reader->numChannels;
    // Analyse at most the first 30s — plenty for a loop, and it bounds the cost.
    const juce::int64 maxSamples = (juce::int64) juce::jmin ((double) reader->lengthInSamples, sr * 30.0);
    const int hop = juce::jmax (1, (int) std::llround (sr / 200.0)); // ~5ms hops → ~200 Hz envelope
    const int nHops = (int) (maxSamples / hop);
    if (nHops < 16) return { 0.0, 0.0 };

    // Per-hop RMS energy.
    std::vector<float> energy ((size_t) nHops, 0.0f);
    juce::AudioBuffer<float> buf (juce::jmax (1, chans), hop);
    for (int h = 0; h < nHops; ++h)
    {
        buf.clear();
        reader->read (&buf, 0, hop, (juce::int64) h * hop, true, chans > 1);
        double e = 0.0;
        for (int c = 0; c < buf.getNumChannels(); ++c)
        {
            const float* p = buf.getReadPointer (c);
            for (int i = 0; i < hop; ++i) e += (double) p[i] * (double) p[i];
        }
        energy[(size_t) h] = (float) std::sqrt (e / (double) juce::jmax (1, hop * juce::jmax (1, chans)));
    }

    // Onset function: positive first difference of the energy envelope, zero-meaned.
    std::vector<float> onset ((size_t) nHops, 0.0f);
    double mean = 0.0;
    for (int h = 1; h < nHops; ++h)
    {
        const float d = energy[(size_t) h] - energy[(size_t) h - 1];
        onset[(size_t) h] = d > 0.0f ? d : 0.0f;
        mean += (double) onset[(size_t) h];
    }
    mean /= (double) juce::jmax (1, nHops - 1);
    if (mean <= 1.0e-9) return { 0.0, 0.0 };  // silence / DC
    double var0 = 0.0;
    for (auto& v : onset) { v = (float) ((double) v - mean); var0 += (double) v * (double) v; }
    var0 /= (double) nHops;
    if (var0 <= 1.0e-12) return { 0.0, 0.0 };

    const double hopRate = sr / (double) hop; // hops per second
    auto autocorrAtLag = [&] (double lag) -> double
    {
        // Linear-interpolated autocorrelation at a fractional lag (in hops).
        const int L = (int) std::floor (lag);
        const double frac = lag - (double) L;
        double acc = 0.0; int cnt = 0;
        for (int i = 0; i + L + 1 < nHops; ++i)
        {
            const double shifted = (double) onset[(size_t) (i + L)] * (1.0 - frac)
                                 + (double) onset[(size_t) (i + L + 1)] * frac;
            acc += (double) onset[(size_t) i] * shifted;
            ++cnt;
        }
        return cnt > 0 ? acc / (double) cnt : 0.0;
    };

    // Scan a musical tempo range; the reported tempo stays in [70,180].
    double bestScore = -1.0e30, bestBpm = 0.0;
    for (double bpm = 70.0; bpm <= 180.0 + 1.0e-6; bpm += 0.5)
    {
        const double lag = 60.0 / bpm * hopRate;
        if (lag < 1.0 || lag >= (double) (nHops - 2)) continue;
        const double s = autocorrAtLag (lag);
        if (s > bestScore) { bestScore = s; bestBpm = bpm; }
    }
    if (bestBpm <= 0.0) return { 0.0, 0.0 };
    return { bestBpm, juce::jlimit (0.0, 1.0, bestScore / var0) };
}

juce::var MoshOps::cmdSetClipWarp (const juce::var& args)
{
    // Audio warp (auto-tempo): the clip re-anchors in BEATS so its audio
    // time-stretches to follow the tempo map. The position remap is IMMEDIATE
    // (getMaximumLength reads the live tempoSequence), so a tempo change visibly
    // re-lengths the clip in the next snapshot — fully headless-verifiable.
    // Stretching uses the engine's vendored SoundTouch (TRACKTION_ENABLE_
    // TIMESTRETCH_SOUNDTOUCH); free warp MARKERS are a deferred subsystem.
    auto* ac = dynamic_cast<te::AudioClipBase*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (ac == nullptr) return errResult ("set_clip_warp", "not an audio clip");
    if (! args.hasProperty ("autoTempo")) return errResult ("set_clip_warp", "missing 'autoTempo'");
    const bool on = (bool) args.getProperty ("autoTempo", false);

    beginTxn ("set_clip_warp");

    if (on)
    {
        // Stretch mode: the requested name, validated against what this build
        // compiles in (checkModeIsAvailable returns a usable fallback).
        auto mode = te::TimeStretcher::defaultMode;
        if (args.hasProperty ("mode"))
            mode = te::TimeStretcher::getModeFromName (eng.engine(),
                                                       args.getProperty ("mode", var()).toString());
        mode = te::TimeStretcher::checkModeIsAvailable (mode);
        ac->setTimeStretchMode (mode);

        // Source BPM: explicit when given; else default to the map tempo at the
        // clip's start, so enabling warp is a 1:1 no-op until the map changes.
        // With detect:true (and no explicit sourceBpm) we estimate the loop's own
        // BPM offline and lock it to the grid — the "easy" Ableton behaviour. This
        // is GUARDED so the default (detect absent) path stays byte-identical.
        double defaultBpm = eng.edit().tempoSequence.getBpmAt (ac->getPosition().getStart());
        if (! args.hasProperty ("sourceBpm") && (bool) args.getProperty ("detect", false))
            if (auto* wav = dynamic_cast<te::WaveAudioClip*> (ac))
            {
                const auto est = detectBpmFromFile (wav->getCurrentSourceFile());
                if (est.first > 0.0 && est.second >= kBpmDetectConfidence) defaultBpm = est.first;
            }
        const double sourceBpm = juce::jlimit (20.0, 999.0,
            (double) args.getProperty ("sourceBpm", defaultBpm));
        auto info = ac->getAudioFile().getInfo();
        ac->getLoopInfo().setBpm (sourceBpm, info);
    }
    ac->setAutoTempo (on);

    logLine ("set_clip_warp", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("clipId", ac->itemID.toString());
    data->setProperty ("autoTempo", ac->getAutoTempo());
    data->setProperty ("stretchMode", te::TimeStretcher::getNameOfMode (ac->getTimeStretchMode()));
    return okResult ("set_clip_warp", var (data));
}

juce::var MoshOps::cmdStretchClip (const juce::var& args)
{
    // Time-stretch a wave clip to a target WARPED length (seconds) or a bar count,
    // by enabling auto-tempo and deriving the sourceBpm that makes it fit. Powers
    // the drag-to-stretch gesture and the Inspector "Fit N bars / ×2 / ÷2" helpers.
    // warpedLen = sourceLen × sourceBpm / projectBpm  ⇒  sourceBpm = projectBpm × target / sourceLen.
    auto* ac = dynamic_cast<te::AudioClipBase*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (ac == nullptr) return errResult ("stretch_clip", "not an audio clip");
    if (! args.hasProperty ("length") && ! args.hasProperty ("bars"))
        return errResult ("stretch_clip", "missing 'length' or 'bars'");

    const double sourceLen = ac->getAudioFile().getLength();
    if (sourceLen <= 0.0) return errResult ("stretch_clip", "source has no length");

    auto& tempoSeq = eng.edit().tempoSequence;
    const auto startPos = ac->getPosition().getStart();
    const double projectBpm = tempoSeq.getBpmAt (startPos);
    if (projectBpm <= 0.0) return errResult ("stretch_clip", "invalid project tempo");

    double sourceBpm = 0.0;
    if (args.hasProperty ("bars"))
    {
        const double bars = (double) args.getProperty ("bars", 0.0);
        if (bars <= 0.0) return errResult ("stretch_clip", "'bars' must be > 0");
        const int beatsPerBar = juce::jmax (1, tempoSeq.getTimeSigAt (startPos).numerator.get());
        // The source should span exactly bars×beatsPerBar beats.
        sourceBpm = (bars * (double) beatsPerBar * 60.0) / sourceLen;
    }
    else
    {
        const double target = (double) args.getProperty ("length", sourceLen);
        if (target <= 0.0) return errResult ("stretch_clip", "'length' must be > 0");
        sourceBpm = projectBpm * target / sourceLen;
    }
    sourceBpm = juce::jlimit (20.0, 999.0, sourceBpm);
    const double warpedLen = sourceLen * sourceBpm / projectBpm;

    beginTxn ("stretch_clip");
    ac->setTimeStretchMode (te::TimeStretcher::checkModeIsAvailable (te::TimeStretcher::defaultMode));
    auto info = ac->getAudioFile().getInfo();
    ac->getLoopInfo().setBpm (sourceBpm, info);
    ac->setAutoTempo (true);
    // Fill the target span explicitly so the clip visibly stretches to the dragged
    // length (the whole source maps across warpedLen at this sourceBpm).
    ac->setPosition ({ { startPos, tracktion::TimeDuration::fromSeconds (warpedLen) },
                       ac->getPosition().getOffset() });

    logLine ("stretch_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouch (ac->itemID.toString());
    auto* data = new DynamicObject();
    data->setProperty ("clipId", ac->itemID.toString());
    data->setProperty ("sourceBpm", sourceBpm);
    data->setProperty ("length", ac->getPosition().getLength().inSeconds());
    return okResult ("stretch_clip", var (data));
}

juce::var MoshOps::cmdDetectClipBpm (const juce::var& args)
{
    // Read-only offline BPM estimate of a wave clip's source loop (no txn / log,
    // mirrors get_clip_peaks). Feeds the Inspector "Detect BPM" affordance.
    const auto id = args.getProperty ("clipId", var()).toString();
    auto* wave = dynamic_cast<te::WaveAudioClip*> (findClip (id));
    if (wave == nullptr) return errResult ("detect_clip_bpm", "no wave clip: " + id);

    const auto est = detectBpmFromFile (wave->getCurrentSourceFile());
    if (est.first <= 0.0) return errResult ("detect_clip_bpm", "cannot estimate BPM (unreadable or no pulse)");

    auto* data = new DynamicObject();
    data->setProperty ("clipId", id);
    data->setProperty ("bpm", est.first);
    data->setProperty ("confidence", est.second);
    return okResult ("detect_clip_bpm", var (data));
}

juce::var MoshOps::cmdDuplicateClip (const juce::var& args)
{
    auto* clip = findClip (args.getProperty ("clipId", var()).toString());
    if (clip == nullptr) return errResult ("duplicate_clip", "no clip");
    auto* track = dynamic_cast<te::ClipTrack*> (clip->getTrack());
    if (track == nullptr) return errResult ("duplicate_clip", "clip not on a clip track");

    auto pos = clip->getPosition();
    const double newStart = pos.getEnd().inSeconds();
    const double len = pos.getLength().inSeconds();

    beginTxn ("duplicate_clip");
    te::Clip* dup = nullptr;
    if (auto* w = dynamic_cast<te::WaveAudioClip*> (clip))
    {
        auto nc = track->insertWaveClip (clip->getName(), w->getCurrentSourceFile(),
            { { tracktion::TimePosition::fromSeconds (newStart), pos.getLength() }, pos.getOffset() }, false);
        if (nc != nullptr) { nc->setGainDB (w->getGainDB()); dup = nc.get(); }
    }
    else if (auto* m = dynamic_cast<te::MidiClip*> (clip))
    {
        auto nc = track->insertMIDIClip (clip->getName(),
            { tracktion::TimePosition::fromSeconds (newStart),
              tracktion::TimePosition::fromSeconds (newStart + len) }, nullptr);
        if (nc != nullptr)
        {
            auto& src = m->getSequence();
            auto& dst = nc->getSequence();
            for (int i = 0; i < src.getNumNotes(); ++i)
                if (auto* n = src.getNote (i))
                    dst.addNote (n->getNoteNumber(), n->getStartBeat(), n->getLengthBeats(),
                                 n->getVelocity(), 0, &undoManager());
            dup = nc.get();
        }
    }
    if (dup == nullptr) return errResult ("duplicate_clip", "could not duplicate this clip type");
    dup->setMuted (clip->isMuted());

    auto* data = new DynamicObject();
    data->setProperty ("newClipId", dup->itemID.toString());
    logLine ("duplicate_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("duplicate_clip", var (data));
}

// ARR-010: delete a time range [start, end] across one or more tracks as a
// SINGLE undoable transaction. For each targeted track we split every clip that
// straddles a bound (reusing ClipTrack::splitClip, the same primitive as
// split_clip) and then remove every clip segment that ends up fully inside the
// range (removeFromParent, the same primitive as remove_clip). Edge cases fall
// out of the geometry: a clip entirely inside is removed whole; a clip
// straddling only one bound is split once and the inside half removed (trim); a
// clip fully outside is never touched; an empty track / no-overlap range is a
// graceful no-op. trackIds defaults to every audio track.
juce::var MoshOps::cmdDeleteTimeRange (const juce::var& args)
{
    const double start = (double) args.getProperty ("start", 0.0);
    const double end   = (double) args.getProperty ("end",   0.0);
    if (! (start < end))
        return errResult ("delete_time_range", "start must be less than end");

    auto& edit = eng.edit();

    // Resolve the target tracks. Bind the var array to a local before getArray()
    // so the temporary stays alive while we read it.
    juce::Array<te::AudioTrack*> targets;
    const auto trackIdsVar = args.getProperty ("trackIds", var());
    if (auto* ids = trackIdsVar.getArray())
    {
        for (auto& idv : *ids)
            if (auto* t = findTrack (idv.toString()))
                if (! targets.contains (t))
                    targets.add (t);
    }
    else
    {
        for (auto* t : te::getAudioTracks (edit))
            if (t != nullptr)
                targets.add (t);
    }

    const auto rStart = tracktion::TimePosition::fromSeconds (start);
    const auto rEnd   = tracktion::TimePosition::fromSeconds (end);

    beginTxn ("delete_time_range");

    int removed = 0, splits = 0;
    bool structurallyChanged = false;

    for (auto* track : targets)
    {
        if (track == nullptr) continue;
        auto* clipTrack = dynamic_cast<te::ClipTrack*> (track);
        if (clipTrack == nullptr) continue;

        // Phase 1 — split at the range bounds so every clip aligns to start/end.
        // Iterate a stable copy (split inserts a clip into the live list). Split at
        // the LATER bound (end) first so splitting at start doesn't shift which
        // clip the end falls inside; both splits use the same primitive as
        // split_clip (ClipTrack::splitClip). We re-read each clip's live position
        // before deciding (the bound must be strictly inside, mirroring split's own
        // reduced(0.001s).contains guard).
        for (const auto& bound : { rEnd, rStart })
        {
            juce::Array<te::Clip*> snap;
            for (auto* c : clipTrack->getClips())
                if (c != nullptr)
                    snap.add (c);

            for (auto* c : snap)
            {
                if (c == nullptr) continue;
                const auto p = c->getPosition();
                if (p.getStart() < bound && bound < p.getEnd())
                {
                    clipTrack->splitClip (*c, bound);
                    ++splits;
                    structurallyChanged = true;
                }
            }

            // Drain the queued ValueTree/AsyncUpdater settle so the new clip's
            // start/end are committed before we read them in the next pass.
            if (structurallyChanged && ! eng.hasAudio())
                if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
                    mm->runDispatchLoopUntil (1);
        }

        // Phase 2 — every clip now begins/ends on the range bounds. Remove the
        // segment(s) lying fully inside [start, end] (removeFromParent, the same
        // primitive as remove_clip). A clip entirely inside is caught here whole; a
        // clip straddling only one bound has been split and its inside half lands
        // fully inside; a clip fully outside never matches.
        juce::Array<te::Clip*> toRemove;
        for (auto* c : clipTrack->getClips())
            if (c != nullptr)
            {
                const auto p = c->getPosition();
                if (p.getStart() >= rStart - tracktion::TimeDuration::fromSeconds (0.0005)
                    && p.getEnd() <= rEnd + tracktion::TimeDuration::fromSeconds (0.0005))
                    toRemove.add (c);
            }
        for (auto* c : toRemove)
            if (c != nullptr)
            {
                c->removeFromParent();
                ++removed;
                structurallyChanged = true;
            }
    }

    // After structural edits Tracktion queues an AsyncUpdater for track/clip
    // settling; drain it here (mirrors createAudioTrack) so itemIDs/positions
    // are stable before the snapshot is read.
    if (structurallyChanged && ! eng.hasAudio())
        if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
            mm->runDispatchLoopUntil (1);

    auto* data = new DynamicObject();
    data->setProperty ("removed", removed);
    data->setProperty ("splits", splits);
    data->setProperty ("tracks", targets.size());
    logLine ("delete_time_range", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("delete_time_range", var (data));
}

// Recreate a clip from a clipToVar-shaped descriptor on a target track at a
// target time. This is the paste half of the UI-local copy/cut/paste clipboard
// (the clipboard itself is view state and never crosses the bridge until here).
// A genuine undoable edit: open a transaction and log undoable:true.
juce::var MoshOps::cmdPasteClip (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    if (trackId.isEmpty()) return errResult ("paste_clip", "missing 'trackId'");

    const auto clipVar = args.getProperty ("clip", var());
    if (! clipVar.isObject()) return errResult ("paste_clip", "missing 'clip'");

    const auto type = clipVar.getProperty ("type", var()).toString();
    if (type != "wave" && type != "midi")
        return errResult ("paste_clip", "unsupported clip type: " + type);

    // Validate cheap per-type preconditions BEFORE any side effect (transaction /
    // track auto-create) so a malformed descriptor errors out with zero side effects
    // (no orphan track left behind, no empty transaction opened).
    File waveSource;
    if (type == "wave")
    {
        const auto sourcePath = clipVar.getProperty ("sourceFile", var()).toString();
        if (sourcePath.isEmpty()) return errResult ("paste_clip", "wave clip missing 'sourceFile'");
        waveSource = File (sourcePath);
        if (! waveSource.existsAsFile()) return errResult ("paste_clip", "source file not found: " + sourcePath);
    }

    auto* track = findTrack (trackId);

    beginTxn ("paste_clip");
    // Match cmdImportClip/cmdAddMidiClip: create the track if it's missing.
    if (track == nullptr)
        track = createAudioTrack ({});
    if (track == nullptr) return errResult ("paste_clip", "no track");

    const double start  = (double) args.getProperty ("start", 0.0);
    const double length = juce::jmax (0.0, (double) clipVar.getProperty ("length", 0.0));
    const double offset = (double) clipVar.getProperty ("offset", 0.0);
    auto name = clipVar.getProperty ("name", var()).toString();
    if (name.isEmpty()) name = (type == "midi") ? "MIDI" : "clip";

    te::Clip* pasted = nullptr;
    if (type == "wave")
    {
        auto nc = track->insertWaveClip (name, waveSource,
            { { tracktion::TimePosition::fromSeconds (start), tracktion::TimeDuration::fromSeconds (length) },
              tracktion::TimeDuration::fromSeconds (offset) }, false);
        if (nc == nullptr) return errResult ("paste_clip", "insertWaveClip failed");
        nc->setGainDB ((float) (double) clipVar.getProperty ("gainDb", 0.0));
        pasted = nc.get();
    }
    else // midi
    {
        auto nc = track->insertMIDIClip (name,
            { tracktion::TimePosition::fromSeconds (start),
              tracktion::TimePosition::fromSeconds (start + length) }, nullptr);
        if (nc == nullptr) return errResult ("paste_clip", "insertMIDIClip failed");

        auto& sequence = nc->getSequence();
        // Bind the notes array to a local before getArray(): a pointer into a
        // temporary var dangles (has bitten prior waves).
        const auto notesVar = clipVar.getProperty ("notes", var());
        if (notesVar.isArray())
            for (auto& n : *notesVar.getArray())
                sequence.addNote (juce::jlimit (0, 127, (int) n.getProperty ("pitch", 60)),
                                  tracktion::BeatPosition::fromBeats ((double) n.getProperty ("start", 0.0)),
                                  tracktion::BeatDuration::fromBeats (juce::jmax (0.0625, (double) n.getProperty ("length", 1.0))),
                                  juce::jlimit (1, 127, (int) n.getProperty ("velocity", 100)), 0, &undoManager());
        pasted = nc.get();
    }

    if (pasted == nullptr) return errResult ("paste_clip", "could not paste this clip type");
    pasted->setMuted ((bool) clipVar.getProperty ("mute", false));

    // Tracktion queues a track/clip AsyncUpdater after a headless insert; drain
    // it before returning so itemIDs settle (mirrors createAudioTrack).
    if (! eng.hasAudio())
        if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
            mm->runDispatchLoopUntil (1);

    auto* data = new DynamicObject();
    data->setProperty ("clipId", pasted->itemID.toString());
    data->setProperty ("trackId", track->itemID.toString());
    logLine ("paste_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("paste_clip", var (data));
}

juce::var MoshOps::cmdSetTrackVolume (const juce::var& args)
{
    const auto id = args.getProperty ("trackId", var()).toString();
    te::VolumeAndPanPlugin* vp = nullptr;
    te::AudioTrack* audioTrack = nullptr;
    if (auto* track = findTrack (id))
        { audioTrack = track; vp = ensureVolumePlugin (*track); }
    else if (auto* group = findGroupTrack (id))   // MIX-008: group fader (submix VolumeAndPan)
        vp = group->getVolumePlugin();
    if (vp == nullptr) return errResult ("set_track_volume", "no track");

    beginTxn ("set_track_volume");
    // G14 — route the fader change through the UndoManager (setVolumeDb alone bypasses it).
    undoManager().perform (new SetFaderValueAction (*vp, false, (float) (double) args.getProperty ("db", 0.0)));
    logLine ("set_track_volume", args, true, {}, true);
    if (audioTrack != nullptr) emitTrackPatch (*audioTrack);   // scoped (group fader → full below)
    else emitSnapshotInvalidated();
    return okResult ("set_track_volume");
}

juce::var MoshOps::cmdSetTrackPan (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_track_pan", "no track");
    auto* vp = ensureVolumePlugin (*track);
    if (vp == nullptr) return errResult ("set_track_pan", "no volume plugin");

    beginTxn ("set_track_pan");
    // G14 — route the pan change through the UndoManager (setPan alone bypasses it).
    undoManager().perform (new SetFaderValueAction (*vp, true,
        juce::jlimit (-1.0f, 1.0f, (float) (double) args.getProperty ("pan", 0.0))));
    logLine ("set_track_pan", args, true, {}, true);
    emitTrackPatch (*track);   // scoped — pan is purely track-local
    return okResult ("set_track_pan");
}

juce::var MoshOps::cmdSetTrackMute (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_track_mute", "no track");
    beginTxn ("set_track_mute");
    track->setMute ((bool) args.getProperty ("mute", false));
    logLine ("set_track_mute", args, true, {}, true);
    emitTrackPatch (*track);   // scoped — mute is purely track-local (unlike solo, which dims others)
    return okResult ("set_track_mute");
}

juce::var MoshOps::cmdSetTrackSolo (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_track_solo", "no track");
    beginTxn ("set_track_solo");
    track->setSolo ((bool) args.getProperty ("solo", false));
    logLine ("set_track_solo", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_track_solo");
}

juce::var MoshOps::cmdArmTrack (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("arm_track", "no track");
    const bool armed = (bool) args.getProperty ("armed", false);

    // Record-arm is a monitoring preference, NOT an undoable session edit: the engine
    // binds the destination's `armed` flag with a nullptr UndoManager
    // (tracktion_InputDevice.h: recordEnabled.referTo (state, IDs::armed, nullptr, false)),
    // so a transaction here would be empty. Treat it like set_metronome / set_transport.

    // getAllInputDevices() is empty headless / without a playback context, so there
    // are no instances to operate on. Degrade gracefully: ok result, applied:false,
    // never an error (mirrors cmdSetTransport skipping play/record when !hasAudio()).
    bool applied = false;
    auto inputs = eng.edit().getAllInputDevices();

    // Find an instance already targeting this track at slot 0.
    te::InputDeviceInstance* target = nullptr;
    for (auto* inst : inputs)
        if (inst != nullptr && te::isOnTargetTrack (*inst, *track, 0))
        {
            target = inst;
            break;
        }

    // Arming a virgin track: assign an available input first, then enable
    // (RecordingDemo does setTarget + setRecordingEnabled together). Disarming a track
    // with no instance is a harmless no-op.
    //
    // CTL-001 — route MIDI to instrument tracks: an instrument track (one hosting a
    // synth) should receive live MIDI from a controller, not a wave input, so a played
    // note turns into audio. We therefore prefer a MIDI input instance when the track
    // has an instrument, and a wave input otherwise. setTarget + setRecordingEnabled
    // are identical calls for either device family. There is NO Tracktion "all MIDI
    // inputs auto-route to the armed track" behaviour — each input must be explicitly
    // targeted; we pick the FIRST matching input (multi-controller disambiguation is a
    // later enhancement). Wave-only tracks are unchanged from the recording wave.
    if (target == nullptr && armed)
    {
        const bool wantMidi = trackHasInstrument (*track);

        // RTG-001 — honor an explicitly-chosen input first (set_track_input stores
        // the WaveInputDevice deviceID on the track's state). Falls through to the
        // family-preference passes below when no choice is stored / not present.
        const auto chosenID = track->state.getProperty (ids::moshInputDevice, var()).toString();
        if (chosenID.isNotEmpty())
            for (auto* inst : inputs)
                if (inst != nullptr && inst->getInputDevice().getDeviceID() == chosenID)
                {
                    if (auto r = inst->setTarget (track->itemID, true, nullptr, 0))
                        target = inst;
                    // A failed setTarget on the chosen device falls through to the
                    // normal auto-assign rather than failing the arm outright.
                    break;
                }

        auto matchesPreferred = [wantMidi] (te::InputDeviceInstance* inst)
        {
            const auto type = inst->getInputDevice().getDeviceType();
            return wantMidi ? (type == te::InputDevice::physicalMidiDevice
                                   || type == te::InputDevice::virtualMidiDevice)
                            : (type == te::InputDevice::waveDevice);
        };

        // First pass: the preferred device family (MIDI for instrument tracks, wave
        // otherwise). Fallback pass: the other family, so arming still does something
        // sensible if e.g. only a wave input is present (or only MIDI, no synth yet).
        for (int pass = 0; pass < 2 && target == nullptr; ++pass)
            for (auto* inst : inputs)
            {
                if (inst == nullptr) continue;
                const bool preferred = matchesPreferred (inst);
                if (pass == 0 ? ! preferred : preferred)
                    continue;     // pass 0: preferred only; pass 1: the other family only
                if (! (inst->getInputDevice().getDeviceType() == te::InputDevice::waveDevice
                       || inst->getInputDevice().isMidi()))
                    continue;     // ignore track-wave/track-midi internal device types

                // setTarget returns tl::expected — check the error, never blind-deref.
                // Pass nullptr (no UndoManager): arming is a non-undoable preference, so
                // the target assignment stays off the Edit undo stack too (it still
                // persists in the input-device ValueTree and saves with the Edit).
                if (auto r = inst->setTarget (track->itemID, true, nullptr, 0))
                {
                    target = inst;
                    break;
                }
                else
                {
                    // Genuine assignment failure (a live device rejected the target):
                    // log exactly once and surface as an error — never a misleading ok.
                    logLine ("arm_track", args, false, r.error(), false);
                    return errResult ("arm_track", r.error());
                }
            }
    }

    if (target != nullptr)
    {
        target->setRecordingEnabled (track->itemID, armed);
        applied = true;
    }

    logLine ("arm_track", args, true, {}, false);
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("armed", armed);
    data->setProperty ("applied", applied);
    if (! applied)
        data->setProperty ("reason", "no input device");
    return okResult ("arm_track", var (data));
}

juce::var MoshOps::cmdStopRecording (const juce::var& args)
{
    // Wave B — record-to-take landing (TRA-002 wave, MID-001 MIDI, ARE-003 latency).
    //
    // Stopping a recording is a RECORDING-LIFECYCLE action, NOT an undoable session
    // edit: Tracktion lands the take's clip(s) on the armed track(s) via its own async
    // clip-add path (the recording context's stopRecording produces a Clip::Array), and
    // the user undoes the *take* via remove_clip if they reject it. So this is a
    // non-undoable transport op (no beginNewTransaction; logged undoable:false) — the
    // same posture as set_transport / arm_track.
    //
    // discardRecordings=false KEEPS the takes (the canonical RecordingDemo stop overload
    // transport.stop(discardRecordings, clearDevices)); discardRecordings=true throws the
    // captured audio/MIDI away and lands nothing. clearDevices stays false so the
    // playback graph survives for the next take.
    const bool discard = (bool) args.getProperty ("discardRecordings", false);

    auto& transport = eng.edit().getTransport();

    // Graceful degradation (mirrors cmdArmTrack / the cmdSetTransport record guard):
    // headless / no audio device → no playback context → no armed inputs → nothing can
    // have been captured. NEVER an error: ok result, applied:false, clips:[], reason.
    auto reportNoOp = [&] (const char* reason) -> juce::var
    {
        logLine ("stop_recording", args, true, {}, false);   // recording op is NOT undoable
        emit ("transport", transportToVar());
        emitSnapshotInvalidated();
        auto* data = new DynamicObject();
        data->setProperty ("applied", false);
        data->setProperty ("discarded", discard);
        data->setProperty ("clips", Array<var>());
        data->setProperty ("reason", reason);
        return okResult ("stop_recording", var (data));
    };

    if (! eng.hasAudio())
        return reportNoOp ("no audio device");

    auto* context = transport.getCurrentPlaybackContext();
    if (context == nullptr)
        return reportNoOp ("no playback context");

    if (! transport.isRecording())
        return reportNoOp ("not recording");

    // Snapshot the clip ids already present on every armed track BEFORE stopping, so the
    // newly-landed take(s) are exactly the post-stop set minus this set. A single track
    // can be targeted by multiple input instances (wave + MIDI), and several tracks can
    // be armed at once, so we collect across ALL armed inputs (key the set per track id).
    // Bind the input array to a local before iterating (no dangling temporary).
    juce::Array<te::AudioTrack*> armedTracks;
    {
        auto inputs = eng.edit().getAllInputDevices();
        auto allTracks = te::getAudioTracks (eng.edit());
        for (auto* inst : inputs)
            if (inst != nullptr)
                for (auto* t : allTracks)
                    if (t != nullptr
                        && te::isOnTargetTrack (*inst, *t, 0)
                        && inst->isRecordingEnabled (t->itemID)
                        && ! armedTracks.contains (t))
                        armedTracks.add (t);
    }

    juce::HashMap<juce::String, int> beforeIds;     // clip itemID -> 1 (membership set)
    for (auto* t : armedTracks)
        for (auto* c : t->getClips())
            if (c != nullptr)
                beforeIds.set (c->itemID.toString(), 1);

    // Stop, KEEPING takes (unless asked to discard). clearDevices=false preserves the
    // graph. Take landing is SYNCHRONOUS inside transport.stop() (performStop() ->
    // playbackContext->stopRecording() -> applyRecording()), so the take clips exist in
    // track.getClips() right after this returns.
    transport.stop (discard, false);

    // Belt-and-suspenders: pump the message loop so any queued ValueTree/Selectable
    // settling + itemID assignment completes before we diff the clips. Headless there is
    // no GUI dispatch between commands, so we pump explicitly (mirrors createAudioTrack).
    if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
        for (int i = 0; i < 4; ++i)
            mm->runDispatchLoopUntil (1);

    // Diff: any clip on an armed track not in the before-set is a freshly-landed take.
    // This detects BOTH wave takes (WaveAudioClip) and MIDI takes (MidiClip, sequence
    // already finalized on stop) — clipToVar serializes either kind (notes for MIDI).
    // ARE-003: the landed clip's start is auto-adjusted by record latency inside
    // Tracktion; we just read it back via clipToVar (no app-side alignment).
    Array<var> landed;
    if (! discard)
        for (auto* t : armedTracks)
            for (auto* c : t->getClips())
                if (c != nullptr && ! beforeIds.contains (c->itemID.toString()))
                    landed.add (clipToVar (*c));

    logLine ("stop_recording", args, true, {}, false);   // recording op is NOT undoable
    emit ("transport", transportToVar());
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("applied", true);
    data->setProperty ("discarded", discard);
    data->setProperty ("clips", landed);
    if (landed.isEmpty() && ! discard)
        data->setProperty ("reason", "no take captured (no live input)");
    return okResult ("stop_recording", var (data));
}

juce::var MoshOps::cmdSetInputMonitor (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_input_monitor", "no track");

    // Accept either { mode: "off"|"automatic"|"on" } or legacy { monitor: bool }.
    juce::String modeStr;
    if (args.hasProperty ("mode"))
        modeStr = args.getProperty ("mode", var()).toString();
    else if (args.hasProperty ("monitor"))
        modeStr = ((bool) args.getProperty ("monitor", false)) ? "on" : "off";
    else
        modeStr = "automatic";

    te::InputDevice::MonitorMode mode;
    if (modeStr == "off")            mode = te::InputDevice::MonitorMode::off;
    else if (modeStr == "automatic") mode = te::InputDevice::MonitorMode::automatic;
    else if (modeStr == "on")        mode = te::InputDevice::MonitorMode::on;
    else return errResult ("set_input_monitor", "bad mode: " + modeStr);

    // Input monitoring is a device preference, NOT an undoable Edit change: setMonitorMode
    // writes the field + saveProps() (global engine props, not the Edit value tree), so a
    // transaction would be empty. Treat it like set_metronome.

    // Monitor mode is a property of the shared InputDevice (the *device*, not the
    // instance) — two tracks fed by the same physical input share one monitor mode.
    // Headless getAllInputDevices() is empty → no-op, applied:false (never an error).
    bool applied = false;
    for (auto* inst : eng.edit().getAllInputDevices())
        if (inst != nullptr && te::isOnTargetTrack (*inst, *track, 0))
        {
            inst->getInputDevice().setMonitorMode (mode);
            applied = true;
            break;
        }

    logLine ("set_input_monitor", args, true, {}, false);
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("mode", modeStr);
    data->setProperty ("applied", applied);
    if (! applied)
        data->setProperty ("reason", "no input device");
    return okResult ("set_input_monitor", var (data));
}

juce::var MoshOps::cmdSetMasterVolume (const juce::var& args)
{
    auto mvp = eng.edit().getMasterVolumePlugin();
    if (mvp == nullptr) return errResult ("set_master_volume", "no master plugin");
    beginTxn ("set_master_volume");
    // G14 — route the master fader through the UndoManager (setVolumeDb alone bypasses it).
    undoManager().perform (new SetFaderValueAction (*mvp, false,
        juce::jlimit (-48.0f, 6.0f, (float) (double) args.getProperty ("db", 0.0))));
    logLine ("set_master_volume", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_master_volume");
}

juce::var MoshOps::cmdSetMasterPan (const juce::var& args)
{
    auto mvp = eng.edit().getMasterVolumePlugin();
    if (mvp == nullptr) return errResult ("set_master_pan", "no master plugin");
    beginTxn ("set_master_pan");
    // G14 — route the master pan through the UndoManager (setPan alone bypasses it).
    undoManager().perform (new SetFaderValueAction (*mvp, true,
        juce::jlimit (-1.0f, 1.0f, (float) (double) args.getProperty ("pan", 0.0))));
    logLine ("set_master_pan", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_master_pan");
}

juce::var MoshOps::cmdEnableTrackMeter (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("enable_track_meter", "no track");
    beginTxn ("enable_track_meter");
    if (ensureTrackMeter (*track) == nullptr) return errResult ("enable_track_meter", "could not create meter");
    logLine ("enable_track_meter", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("enable_track_meter");
}

juce::var MoshOps::cmdDisableTrackMeter (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("disable_track_meter", "no track");
    const auto id = track->itemID.toString();
    if (auto it = meterClients.find (id); it != meterClients.end())
    {
        if (it->second != nullptr && it->second->plugin != nullptr)
            it->second->plugin->measurer.removeClient (it->second->client);   // unregister before delete
        meterClients.erase (it);
    }
    beginTxn ("disable_track_meter");
    if (auto* lm = findTrackMeter (*track)) lm->deleteFromParent();
    logLine ("disable_track_meter", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("disable_track_meter");
}

juce::var MoshOps::cmdEnableAllMeters (const juce::var& args)
{
    beginTxn ("enable_all_meters");
    int n = 0;
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr && ensureTrackMeter (*t) != nullptr) ++n;
    logLine ("enable_all_meters", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject(); data->setProperty ("count", n);
    return okResult ("enable_all_meters", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Wave 8 — sends / returns / aux buses. A "bus" is an integer busNumber; the
// return is a normal AudioTrack carrying an AuxReturnPlugin (which renders even
// with no input). Sends are post-fader AuxSendPlugins appended to a track's
// chain, routed purely by matching busNumber. (Plan: docs/plans/wave-sends.md.)
// ─────────────────────────────────────────────────────────────────────────────
te::AuxReturnPlugin* MoshOps::firstAuxReturnOn (te::AudioTrack& t)
{
    for (auto* p : t.pluginList.getPlugins())
        if (auto* r = dynamic_cast<te::AuxReturnPlugin*> (p))
            return r;
    return nullptr;
}

te::AudioTrack* MoshOps::findReturnTrackForBus (int bus)
{
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr)
            if (auto* r = firstAuxReturnOn (*t))
                if (r->busNumber.get() == bus)
                    return t;
    return nullptr;
}

int MoshOps::allocateBusNumber()
{
    juce::Array<int> used;
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr)
            for (auto* p : t->pluginList.getPlugins())
                if (auto* r = dynamic_cast<te::AuxReturnPlugin*> (p))
                    used.add (r->busNumber.get());
    int n = 0;
    while (used.contains (n)) ++n;
    return n;
}

juce::var MoshOps::cmdCreateBus (const juce::var& args)
{
    auto& edit = eng.edit();
    const int bus = allocateBusNumber();
    auto name = args.getProperty ("name", var()).toString();
    if (name.isEmpty()) name = "Bus " + String (bus + 1);

    beginTxn ("create_bus");
    auto* track = createAudioTrack (name);
    if (track == nullptr) return errResult ("create_bus", "could not create return track");

    auto plugin = edit.getPluginCache().createNewPlugin (te::AuxReturnPlugin::xmlTypeName, {});
    if (plugin == nullptr) return errResult ("create_bus", "could not create aux return");
    if (auto* r = dynamic_cast<te::AuxReturnPlugin*> (plugin.get()))
        r->busNumber = bus;
    track->pluginList.insertPlugin (plugin, 0, nullptr);
    ensureVolumePlugin (*track);
    edit.setAuxBusName (bus, name);

    auto* data = new DynamicObject();
    data->setProperty ("busNumber", bus);
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("name", name);
    logLine ("create_bus", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("create_bus", var (data));
}

juce::var MoshOps::cmdAddSend (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("add_send", "no track");
    const int bus = (int) args.getProperty ("bus", -1);
    if (findReturnTrackForBus (bus) == nullptr) return errResult ("add_send", "no such bus");
    if (track->getAuxSendPlugin (bus) != nullptr) return errResult ("add_send", "send already exists");

    beginTxn ("add_send");
    auto plugin = eng.edit().getPluginCache().createNewPlugin (te::AuxSendPlugin::xmlTypeName, {});
    if (plugin == nullptr) return errResult ("add_send", "could not create aux send");
    if (auto* s = dynamic_cast<te::AuxSendPlugin*> (plugin.get()))
    {
        s->busNumber = bus;
        track->pluginList.insertPlugin (plugin, track->pluginList.getPlugins().size(), nullptr);  // append → post-fader
        s->setGainDb (juce::jlimit (-60.0f, 6.0f, (float) (double) args.getProperty ("db", 0.0)));
    }
    logLine ("add_send", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject(); data->setProperty ("bus", bus);
    return okResult ("add_send", var (data));
}

juce::var MoshOps::cmdSetSendLevel (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_send_level", "no track");
    auto* s = track->getAuxSendPlugin ((int) args.getProperty ("bus", -1));
    if (s == nullptr) return errResult ("set_send_level", "no send to that bus");
    beginTxn ("set_send_level");
    s->setGainDb (juce::jlimit (-100.0f, 6.0f, (float) (double) args.getProperty ("db", 0.0)));
    logLine ("set_send_level", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_send_level");
}

juce::var MoshOps::cmdRemoveSend (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("remove_send", "no track");
    auto* s = track->getAuxSendPlugin ((int) args.getProperty ("bus", -1));
    if (s == nullptr) return errResult ("remove_send", "no send to that bus");
    beginTxn ("remove_send");
    s->deleteFromParent();
    logLine ("remove_send", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_send");
}

juce::var MoshOps::cmdRemoveBus (const juce::var& args)
{
    const int bus = (int) args.getProperty ("bus", -1);
    if (bus < 0) return errResult ("remove_bus", "bad bus");
    auto* returnTrack = findReturnTrackForBus (bus);
    if (returnTrack == nullptr) return errResult ("remove_bus", "no such bus");

    beginTxn ("remove_bus");
    // Sweep orphan sends pointing at this bus, then drop the name + the return track.
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr)
            if (auto* s = t->getAuxSendPlugin (bus))
                s->deleteFromParent();
    eng.edit().setAuxBusName (bus, {});
    eng.edit().deleteTrack (returnTrack);
    logLine ("remove_bus", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_bus");
}

juce::var MoshOps::cmdRenameBus (const juce::var& args)
{
    const int bus = (int) args.getProperty ("bus", -1);
    auto* returnTrack = findReturnTrackForBus (bus);
    if (returnTrack == nullptr) return errResult ("rename_bus", "no such bus");
    const auto name = args.getProperty ("name", var()).toString();
    // A bus name is a NON-undoable label (mirrors set_key / project settings): Tracktion's
    // Edit::setAuxBusName writes the AUXBUSNAMES tree with a nullptr UndoManager, so the bus
    // name — the snapshot's authoritative source (getAuxBusName) — cannot be undone. Write
    // the return-track name directly (IDs::name, nullptr) rather than via Track::setName
    // (which records through the UndoManager) so the WHOLE command is consistently
    // non-undoable, with no partial-undo (name half-reverting). markDirty + undoable:false.
    eng.edit().setAuxBusName (bus, name);
    returnTrack->state.setProperty (ids::name, name, nullptr);
    eng.markDirty();
    logLine ("rename_bus", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("rename_bus");
}

juce::var MoshOps::cmdGetClipPeaks (const juce::var& args)
{
    // Backend-computed waveform peaks (peak array per clip; no audio on the web
    // thread, 03 // VERIFY). Read-only — not a mutation, no undo/log.
    const auto id = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (id);
    auto* wave = dynamic_cast<te::WaveAudioClip*> (clip);
    if (wave == nullptr) return errResult ("get_clip_peaks", "no wave clip: " + id);

    const int buckets = juce::jlimit (16, 4000, (int) args.getProperty ("buckets", 600));
    auto file = wave->getCurrentSourceFile();

    juce::AudioFormatManager fm; fm.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader (fm.createReaderFor (file));
    if (reader == nullptr) return errResult ("get_clip_peaks", "cannot read source");

    auto peaks = bucketedPeaks (*reader, buckets);
    auto* data = new DynamicObject();
    data->setProperty ("clipId", id);
    data->setProperty ("buckets", peaks.size());
    data->setProperty ("peaks", var (peaks));
    return okResult ("get_clip_peaks", var (data));
}

juce::var MoshOps::cmdFilePeaks (const juce::var& args)
{
    // Waveform peaks for an un-imported file (the sample-browser thumbnail). Like
    // get_clip_peaks but path-addressed; read-only — no clip, transaction, or log.
    const auto path = args.getProperty ("path", var()).toString();
    if (path.isEmpty()) return errResult ("file_peaks", "missing 'path'");
    juce::File file (path);
    if (! file.existsAsFile()) return errResult ("file_peaks", "file not found: " + path);

    const int buckets = juce::jlimit (16, 4000, (int) args.getProperty ("buckets", 200));
    std::unique_ptr<juce::AudioFormatReader> reader (previewFormats.createReaderFor (file));
    if (reader == nullptr) return errResult ("file_peaks", "cannot read: " + path);

    auto peaks = bucketedPeaks (*reader, buckets);
    auto* data = new DynamicObject();
    data->setProperty ("path", path);
    data->setProperty ("buckets", peaks.size());
    data->setProperty ("peaks", var (peaks));
    return okResult ("file_peaks", var (data));
}

juce::var MoshOps::cmdAuditionFile (const juce::var& args)
{
    // Standalone file preview (audition) — transient, NOT a mutation: no undo
    // transaction, no JSONL line. One preview at a time; a new audition (or
    // stop_audition / the destructor) releases the previous source. Headless
    // (--selftest, no device) it can't sound, but it must start/stop cleanly.
    const auto path = args.getProperty ("path", var()).toString();
    if (path.isEmpty()) return errResult ("audition_file", "missing 'path'");
    juce::File file (path);
    if (! file.existsAsFile()) return errResult ("audition_file", "file not found: " + path);

    stopAudition();

    auto* reader = previewFormats.createReaderFor (file);
    if (reader == nullptr) return errResult ("audition_file", "cannot read: " + path);

    if (! previewThread.isThreadRunning()) previewThread.startThread();
    previewReader.reset (new juce::AudioFormatReaderSource (reader, true));   // owns the reader
    previewTransport.setSource (previewReader.get(), 32768, &previewThread, reader->sampleRate);
    previewPlayer.setSource (&previewTransport);
    if (! previewWired) { adm().addAudioCallback (&previewPlayer); previewWired = true; }
    previewTransport.setPosition (0.0);
    previewTransport.start();

    auto* data = new DynamicObject();
    data->setProperty ("path", path);
    data->setProperty ("playing", adm().getCurrentAudioDevice() != nullptr);
    return okResult ("audition_file", var (data));
}

juce::var MoshOps::cmdStopAudition (const juce::var&)
{
    stopAudition();
    return okResult ("stop_audition");
}

void MoshOps::stopAudition()
{
    previewTransport.stop();
    previewTransport.setSource (nullptr);
    previewPlayer.setSource (nullptr);
    previewReader.reset();
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 3 — VST3 hosting + MIDI
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdListPlugins (const juce::var&)
{
    juce::Array<var> plugins;
    int nVst3 = 0, nAu = 0;
    for (auto& d : pluginHost.available())
    {
        auto* o = new DynamicObject();
        o->setProperty ("id", PluginHost::idFor (d));
        o->setProperty ("name", d.name);
        o->setProperty ("format", d.pluginFormatName);   // "VST3" / "AudioUnit"
        o->setProperty ("manufacturer", d.manufacturerName);
        o->setProperty ("isInstrument", d.isInstrument);
        plugins.add (var (o));

        if (d.pluginFormatName == "AudioUnit") ++nAu;
        else if (d.pluginFormatName == "VST3") ++nVst3;
    }
    // Per-format counts for the manager UI (INS-005). Plain numbers, not Tracktion
    // concepts — VST3/AudioUnit are standard plugin formats.
    auto* counts = new DynamicObject();
    counts->setProperty ("vst3", nVst3);
    counts->setProperty ("au", nAu);
    counts->setProperty ("total", plugins.size());

    auto* data = new DynamicObject();
    data->setProperty ("plugins", plugins);
    data->setProperty ("counts", var (counts));
    return okResult ("list_plugins", var (data));
}

juce::var MoshOps::cmdListBuiltins (const juce::var&)
{
    // The engine's compiled-in plugin palette (instruments + effects). Static —
    // no scan needed; the UI groups these by category alongside scanned VST3/AUs.
    juce::Array<var> plugins;
    for (auto& b : kBuiltins)
    {
        auto* o = new DynamicObject();
        o->setProperty ("type", b.type);
        o->setProperty ("name", b.name);
        o->setProperty ("category", b.category);
        o->setProperty ("isInstrument", b.isInstrument);
        o->setProperty ("builtin", true);
        plugins.add (var (o));
    }
    auto* data = new DynamicObject();
    data->setProperty ("plugins", plugins);
    return okResult ("list_builtins", var (data));
}

juce::var MoshOps::cmdLoadBuiltin (const juce::var& args)
{
    eng.saveIfDirty();   // A2 — pre-risky-op save (recovery point if instantiation crashes)
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("load_builtin", "no track");

    const auto type = args.getProperty ("type", var()).toString();
    const auto* spec = findBuiltin (type);
    if (spec == nullptr) return errResult ("load_builtin", "unknown builtin: " + type);

    beginTxn ("load_builtin");
    // Same cache path as load_plugin — the inserted plugin IS the one we hold.
    auto plugin = eng.edit().getPluginCache().createNewPlugin (type, {});
    if (plugin == nullptr) return errResult ("load_builtin", "create failed: " + type);

    int index = (int) args.getProperty ("index", -1);
    if (index < 0) index = track->pluginList.getPlugins().size();   // append
    track->pluginList.insertPlugin (plugin, index, nullptr);

    auto* data = new DynamicObject();
    data->setProperty ("index", track->pluginList.indexOf (plugin.get()));
    data->setProperty ("name", plugin->getName());
    data->setProperty ("type", type);
    data->setProperty ("isInstrument", spec->isInstrument);
    logLine ("load_builtin", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouchTrack (args.getProperty ("trackId", var()).toString());   // Phase 3 — instrument/FX change → re-bounce
    return okResult ("load_builtin", var (data));
}

// DRM-001 — flip a track between "audio" and "drum". The type is a plain property
// on the track's own state tree (serialised in the snapshot, saved with the edit).
// A drum track auto-loads the working sampler + bundled kit so its MIDI notes are
// audible immediately. Written WITH the undo manager inside the transaction, so a
// single undo restores the prior type AND removes the auto-loaded instrument.
juce::var MoshOps::cmdSetTrackType (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_track_type", "no track");

    const auto type = args.getProperty ("type", "audio").toString();
    if (type != "audio" && type != "drum")
        return errResult ("set_track_type", "type must be 'audio' or 'drum'");

    beginTxn ("set_track_type");
    track->state.setProperty (ids::trackType, type, &undoManager());
    if (type == "drum")
        ensureDefaultInstrument (*track, true);

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("type", type);
    data->setProperty ("isInstrument", trackHasInstrument (*track));
    logLine ("set_track_type", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_track_type", var (data));
}

// DRM-001 — (re)load the bundled default drum kit onto a track's sampler (creating
// the sampler if absent). The command form lets the UI offer "load a kit" and lets
// a re-load reset edited pads.
juce::var MoshOps::cmdLoadDrumKit (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("load_drum_kit", "no track");

    // Validate the kit is present BEFORE opening a transaction / inserting a sampler,
    // so a missing kit is a clean error with no partial, un-emitted mutation.
    if (! drumKitAvailable())
        return errResult ("load_drum_kit", "no kit samples found (is the kit bundled?)");

    beginTxn ("load_drum_kit");
    auto* sampler = ensureSampler (*track);
    if (sampler == nullptr) return errResult ("load_drum_kit", "could not create sampler");
    const int pads = loadDrumKitInto (*sampler);
    if (pads == 0) return errResult ("load_drum_kit", "no kit samples found (is the kit bundled?)");
    applyDrumLaneGains (*track);  // re-loaded pads land at 0 dB — re-silence muted lanes

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("index", track->pluginList.indexOf (sampler));
    data->setProperty ("pads", pads);
    logLine ("load_drum_kit", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("load_drum_kit", var (data));
}

// DRM-001 — assign a sample file to a single pad/note on a track's sampler. Maps
// the sound to exactly that note (keyNote==minNote==maxNote, unity pitch) and
// REPLACES any pad already covering the note, so it doubles as "swap this pad".
juce::var MoshOps::cmdAssignSample (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("assign_sample", "no track");

    const int note = juce::jlimit (0, 127, (int) args.getProperty ("note", 60));
    const auto mode = args.getProperty ("mode", "drum").toString();   // "drum" (default, one-shot pad) | "melodic" (pitched 808/bass)
    const auto path = args.getProperty ("file", var()).toString();
    juce::File f (path);
    if (path.isEmpty() || ! f.existsAsFile())
        return errResult ("assign_sample", "file not found: " + path);

    const auto name  = args.getProperty ("name", f.getFileNameWithoutExtension()).toString();
    const float gain = (float) (double) args.getProperty ("gainDb", 0.0);

    // NB: the sampler insert is undoable, but the pad SOUND edits below go straight to
    // the plugin (no UndoManager) — sampler sound content is non-undoable here, the same
    // as plugin add/remove. (Undo restores a freshly-inserted sampler's removal, not pads.)
    beginTxn ("assign_sample");
    auto* sampler = ensureSampler (*track);
    if (sampler == nullptr) return errResult ("assign_sample", "could not create sampler");

    // Replace any existing pad covering this note (descending so indices stay valid).
    // getMinKey/getMaxKey index the SOUND children while removeSound uses the raw child
    // index; these coincide because a Mosh sampler's state holds ONLY addSound-created
    // SOUND children (we never add macros/modifiers as children to it).
    for (int i = sampler->getNumSounds(); --i >= 0;)
        if (sampler->getMinKey (i) <= note && sampler->getMaxKey (i) >= note)
            sampler->removeSound (i);

    const int idx = sampler->getNumSounds();
    const auto err = sampler->addSound (f.getFullPathName(), name, 0.0, 0.0 /*whole file*/, gain);
    if (err.isNotEmpty()) return errResult ("assign_sample", err);
    if (mode == "melodic")
    {
        // "Regular 808 functionality": ONE one-shot played across the WHOLE keyboard,
        // repitched per MIDI note off `note` as the root (playback-rate resample — no
        // time-stretch), and NOTE-GATED (openEnded=false) so the MIDI note length cuts
        // the sample off (short note = short hit, long note = sustained 808). Monophonic
        // self-non-overlap is the caller's job (author the bass MIDI non-overlapping).
        sampler->setSoundParams (idx, note, 0, 127);
        sampler->setSoundOpenEnded (idx, false);
    }
    else
    {
        sampler->setSoundParams (idx, note, note, note);
        sampler->setSoundOpenEnded (idx, true);   // one-shot drum pad: a short note rings the whole sample
    }
    applyDrumLaneGains (*track);               // keep a muted lane silent after a pad swap
    // The sampler loads its sample file on an AsyncUpdate (valueTreeChanged). Headless
    // there is no GUI dispatch between commands, so drain it now — the sound's audio
    // data must be resident before an export/render reads it (mirrors createAudioTrack).
    if (! eng.hasAudio())
        if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
            mm->runDispatchLoopUntil (5);

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("index", track->pluginList.indexOf (sampler));
    data->setProperty ("note", note);
    data->setProperty ("name", name);
    data->setProperty ("mode", mode);
    data->setProperty ("sounds", sampler->getNumSounds());
    logLine ("assign_sample", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("assign_sample", var (data));
}

juce::var MoshOps::cmdLoadPlugin (const juce::var& args)
{
    // A2 — persist any unsaved work BEFORE an op that can crash the process in-place
    // (hosting a third-party VST3/AU is the #1 in-process-teardown crash). The on-disk save
    // becomes the recovery point, making the crash near-lossless without the full replay.
    eng.saveIfDirty();
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("load_plugin", "no track");

    const auto pluginId = args.getProperty ("pluginId", var()).toString();
    juce::PluginDescription desc;
    if (! pluginHost.findDescription (pluginId, desc))
        return errResult ("load_plugin", "unknown plugin: " + pluginId);

    beginTxn ("load_plugin");
    // MUST use the Edit's PluginCache so the inserted plugin IS the one we hold
    // (PluginManager::createNewPlugin yields a different instance → insertPlugin
    // re-creates from state, indexOf fails, and it asserts — engine's own note).
    auto plugin = eng.edit().getPluginCache().createNewPlugin (te::ExternalPlugin::xmlTypeName, desc);
    if (plugin == nullptr) return errResult ("load_plugin", "create failed");

    int index = (int) args.getProperty ("index", -1);
    if (index < 0) index = track->pluginList.getPlugins().size();   // append (−1 does not append)
    track->pluginList.insertPlugin (plugin, index, nullptr);

    auto* data = new DynamicObject();
    data->setProperty ("index", track->pluginList.indexOf (plugin.get()));
    data->setProperty ("name", plugin->getName());
    if (auto* ext = dynamic_cast<te::ExternalPlugin*> (plugin.get()))
        addExternalPluginMetadata (*data, *ext);
    logLine ("load_plugin", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouchTrack (args.getProperty ("trackId", var()).toString());   // Phase 3 — FX change → re-bounce
    return okResult ("load_plugin", var (data));
}

juce::var MoshOps::cmdRemovePlugin (const juce::var& args)
{
    eng.saveIfDirty();   // A2 — pre-risky-op save (plugin teardown can crash in-process)
    auto* plugin = findPlugin (args.getProperty ("trackId", var()).toString(),
                               (int) args.getProperty ("index", -1));
    if (plugin == nullptr) return errResult ("remove_plugin", "no plugin");
    pluginHost.closeEditor (*plugin);
    beginTxn ("remove_plugin");
    plugin->deleteFromParent();
    logLine ("remove_plugin", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouchTrack (args.getProperty ("trackId", var()).toString());   // Phase 3
    return okResult ("remove_plugin");
}

juce::var MoshOps::cmdReorderPlugin (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("reorder_plugin", "no track");
    const int from = (int) args.getProperty ("index", -1);
    const int to   = (int) args.getProperty ("toIndex", -1);
    auto plugins = track->pluginList.getPlugins();
    if (from < 0 || from >= plugins.size()) return errResult ("reorder_plugin", "bad index");

    te::Plugin::Ptr p = plugins[from];
    beginTxn ("reorder_plugin");
    p->removeFromParent();
    track->pluginList.insertPlugin (p, to, nullptr);
    logLine ("reorder_plugin", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouchTrack (args.getProperty ("trackId", var()).toString());   // Phase 3
    return okResult ("reorder_plugin");
}

juce::var MoshOps::cmdSetPluginParam (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto* plugin = findPlugin (trackId, (int) args.getProperty ("index", -1));
    if (plugin == nullptr) return errResult ("set_plugin_param", "no plugin");
    const int pi = (int) args.getProperty ("paramIndex", -1);
    if (pi < 0 || pi >= plugin->getNumAutomatableParameters())
        return errResult ("set_plugin_param", "bad paramIndex");

    auto param = plugin->getAutomatableParameter (pi);
    const float norm = juce::jlimit (0.0f, 1.0f, (float) (double) args.getProperty ("value", 0.0));
    const float raw  = param->valueRange.convertFrom0to1 (norm);
    beginTxn ("set_plugin_param");
    // G14-class fix — see SetPluginParamValueAction's comment. param->setParameter() directly
    // left AutomatableParameter::currentValue (and thus the snapshot's params[].value) stale
    // after undo; replaying through a custom UndoableAction keeps it correct both ways.
    undoManager().perform (new SetPluginParamValueAction (*param, raw));
    logLine ("set_plugin_param", args, true, {}, true);
    // Scoped — param tweaks are the other rapid-fire case. A param that changes plugin
    // LATENCY leaves the session PDC readout briefly stale (self-corrects on the next
    // structural edit); the arrangement is unaffected. Group-track plugins → full.
    if (auto* track = findTrack (trackId)) emitTrackPatch (*track);
    else emitSnapshotInvalidated();
    reactiveTouchTrack (args.getProperty ("trackId", var()).toString());   // Phase 3 — param change → re-bounce
    return okResult ("set_plugin_param");
}

juce::var MoshOps::cmdBypassPlugin (const juce::var& args)
{
    auto* plugin = findPlugin (args.getProperty ("trackId", var()).toString(),
                               (int) args.getProperty ("index", -1));
    if (plugin == nullptr) return errResult ("bypass_plugin", "no plugin");
    const bool bypassed = (bool) args.getProperty ("bypassed", false);
    beginTxn ("bypass_plugin");
    plugin->setEnabled (! bypassed);          // enabled == not bypassed
    logLine ("bypass_plugin", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouchTrack (args.getProperty ("trackId", var()).toString());   // Phase 3 — bypass changes the bounce
    return okResult ("bypass_plugin");
}

// ─────────────────────────────────────────────────────────────────────────────
// INS-005 — plugin scan & management. These mutate the plugin CATALOG, not the
// Edit, so they are NON-undoable (no Tracktion transaction); get_plugin_blocklist
// is read-only (no log). The catalog is a query (list_plugins) outside snapshot()
// — scan progress rides on transient 'plugin_scan_progress' events, never the
// snapshot (swappable-seam discipline).
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdRescanPlugins (const juce::var& args)
{
    // SCAN GUARD (tier wall): plugin scanning must NEVER reach the generative service.
    // This handler drives ONLY pluginHost.rescan (VST3/AU cataloging via the JUCE
    // PluginManager) — it never calls jobManager.ensureServiceRunning, so a rescan can
    // never spawn or warm the SA3 service (the service is lazy: only cmdRenderLayer /
    // cmdListColors start it). If a deep-scan CLI entry is ever added, it must early-
    // return before MoshOps is constructed and force MOSH_ENABLE_SA3=0 for that process.
    const auto format = args.getProperty ("format", "all").toString();   // "vst3" | "au" | "all"
    const bool clearFirst = (bool) args.getProperty ("clearFirst", false);
    const bool includeVST3 = (format == "vst3" || format == "all");
    // AU is the slow/risky path: only when requested AND opted in (so --selftest,
    // which never sets MOSH_SCAN_AU, performs no AU sweep). VST3-only rescans are
    // always allowed.
    const bool auOptedIn = SystemStats::getEnvironmentVariable ("MOSH_SCAN_AU", {}) == "1";
    const bool includeAU = (format == "au" || format == "all") && auOptedIn;

    // wait:true forces a synchronous VST3 sweep (cheap + safe on the message thread).
    // AU cataloging ALWAYS runs on a background thread, even when wait:true, because
    // JUCE's AudioPluginFormat::createInstanceFromDescription marshals component
    // instantiation back to the message thread — a hanging AU stalls the UI with no
    // per-component timeout.  Only CRASHes are recovered via the dead-mans-pedal;
    // a HANG requires a forced app restart.  Never call the AU sweep synchronously
    // on the message thread.
    const bool wait = (bool) args.getProperty ("wait", false);
    if (! includeAU)
    {
        // VST3-only (or no formats): fast + safe, run synchronously.
        const int total = pluginHost.rescan (clearFirst, includeVST3, false);
        logLine ("rescan_plugins", args, true, {}, false);   // non-undoable catalog op
        emitSnapshotInvalidated();
        auto* d = new DynamicObject();
        d->setProperty ("status", "done");
        d->setProperty ("count", total);
        return okResult ("rescan_plugins", var (d));
    }
    if (wait)
    {
        // wait:true with AU requested: do the VST3 part inline, THEN kick off the
        // AU sweep on a background thread and return "scanning" to the caller.
        // (Keeping the message-thread VST3 result gives the caller a useful count
        // while the AU sweep is in progress.)
        if (includeVST3)
            pluginHost.rescan (clearFirst, includeVST3, false);
    }

    // Async AU rescan — mirror cmdRenderLayer: do the slow work on a background
    // std::thread, marshal the result back to the message thread.
    //
    // FIT-003 — arm the live progress sampler BEFORE spawning the scan thread (message
    // thread only; see timerCallback()) so the UI gets periodic running-count events
    // for the whole sweep, not just this start/done pair.
    scanSampling_  = true;
    scanFormat_    = format;
    scanStartMs_   = Time::getMillisecondCounterHiRes();
    lastScanCount_ = -1;
    emit ("plugin_scan_progress", makeScanProgressPayload (format, /*count=*/0, /*done=*/false, 0));
    // NOTE: clearFirst and the VST3 sweep have already run inline (if wait:true) or
    // will run together below (async path).  Pass clearFirst=false and includeVST3 in
    // the async lambda only if we didn't already do them above.
    const bool asyncClearFirst  = clearFirst && ! wait;
    const bool asyncIncludeVST3 = includeVST3 && ! wait;
    std::thread ([this, asyncClearFirst, asyncIncludeVST3, format]
    {
        // slowVST3=true: this is the deep, module-loading sweep on a BACKGROUND thread
        // (never the message thread) — engage Tracktion's out-of-process scanner + the
        // hang watchdog so a plugin that hangs the child (e.g. a WaveShell on the user's
        // conflicting Waves install) gets killed → blocklisted → skipped, and the catalog
        // is checkpointed mid-sweep so a kill keeps the progress so far.
        const int total = pluginHost.rescan (asyncClearFirst, asyncIncludeVST3, true, /*slowVST3=*/true);
        juce::MessageManager::callAsync ([this, total, format]
        {
            const int elapsed = (int) (Time::getMillisecondCounterHiRes() - scanStartMs_);
            scanSampling_ = false;   // stop the timerCallback() sampler before the terminal emit
            emit ("plugin_scan_progress", makeScanProgressPayload (format, total, /*done=*/true, elapsed));
            emitSnapshotInvalidated();
        });
    }).detach();

    logLine ("rescan_plugins", args, true, {}, false);
    auto* d = new DynamicObject();
    d->setProperty ("status", "scanning");
    return okResult ("rescan_plugins", var (d));
}

juce::var MoshOps::cmdGetPluginBlocklist (const juce::var&)
{
    // READ-ONLY (no log/transaction) — modelled on cmdListAudioDevices.
    // The blacklist stores fileOrIdentifier strings (file paths for VST3,
    // "AudioUnit:..." for AU).  For each entry we try to present the UI-facing
    // idFor() form if the entry is still resolvable via the catalog; otherwise we
    // fall back to the raw fileOrIdentifier so the caller can see what was blocked.
    juce::Array<var> entries;
    auto rawIds = pluginHost.blocklist();
    // Use the unfiltered type list for the reverse-mapping: available() now filters
    // blocked entries, so blocked plugins would be invisible to the lookup.
    const auto allTypes = eng.engine().getPluginManager().knownPluginList.getTypes();

    for (auto& rawId : rawIds)
    {
        // Try to find a matching description in the full type catalog (including
        // blocked entries) to map rawId -> UI-facing idFor() form.
        String uiId = rawId;   // default: show the raw key
        for (auto& d : allTypes)
        {
            if (d.fileOrIdentifier == rawId)
            {
                uiId = PluginHost::idFor (d);
                break;
            }
        }
        auto* o = new DynamicObject();
        o->setProperty ("id",    uiId);
        o->setProperty ("rawId", rawId);   // the actual blacklist key, for debugging
        // FIT-003 — PluginHost now records WHY each entry was blocked: "crash_or_hang"
        // for a dead-mans-pedal auto-quarantine (the scan crashed or hung loading it),
        // "manual" for an explicit block_plugin call. Entries blocked before this
        // tracking existed (or a fresh manual block missing the tag) default to
        // "manual" — the safe assumption absent contrary evidence.
        const auto reason = pluginHost.blockReasonFor (rawId);
        o->setProperty ("reason", reason.isNotEmpty() ? reason : juce::String ("manual"));
        entries.add (var (o));
    }
    auto* data = new DynamicObject();
    data->setProperty ("blocklist", entries);
    return okResult ("get_plugin_blocklist", var (data));
}

juce::var MoshOps::cmdClearPluginBlocklist (const juce::var& args)
{
    pluginHost.clearBlocklist();
    logLine ("clear_plugin_blocklist", args, true, {}, false);   // catalog op, not undoable
    emitSnapshotInvalidated();
    return okResult ("clear_plugin_blocklist");
}

juce::var MoshOps::cmdBlockPlugin (const juce::var& args)
{
    const auto id = args.getProperty ("pluginId", var()).toString();
    if (id.isEmpty()) return errResult ("block_plugin", "missing pluginId");

    // The incoming pluginId is the UI-facing identifier (e.g. "VST3-Serum") produced
    // by idFor()/te::createIdentifierString.  The JUCE blacklist is keyed on
    // PluginDescription.fileOrIdentifier (a file path for VST3, an "AudioUnit:..."
    // string for AU).  We must resolve the UI id -> fileOrIdentifier before blocking,
    // otherwise the key is wrong and the block has no effect on future scans.
    juce::PluginDescription desc;
    if (pluginHost.findDescription (id, desc))
    {
        // Found in the live catalog: block by the format-native key (fileOrIdentifier).
        // available() filters blocked entries, so this plugin disappears from
        // list_plugins immediately without needing to remove it from the type list
        // (the type list is the persistent catalog; the blacklist is the gate).
        pluginHost.blockPlugin (desc.fileOrIdentifier);
    }
    else
    {
        // Not in the catalog. The caller may be passing a raw fileOrIdentifier or
        // an "AudioUnit:..." id directly.  Accept it as-is so AU crash-recovery and
        // pre-emptive blocks still work, but a bogus id is harmless (empty blacklist
        // entries do nothing).
        if (id.contains ("/") || id.startsWith ("AudioUnit:") || id.startsWith ("VST3:"))
            pluginHost.blockPlugin (id);
        else
            return errResult ("block_plugin", "pluginId not found in catalog and does not look like a raw identifier");
    }

    logLine ("block_plugin", args, true, {}, false);             // catalog op, not undoable
    emitSnapshotInvalidated();
    return okResult ("block_plugin");
}

// ─────────────────────────────────────────────────────────────────────────────
// Wave 7 — parameter automation. A parameter is addressed by
// (trackId, pluginIndex, paramIndex); values cross the seam normalised 0–1 and
// are mapped to the parameter's real range here. Times are in seconds.
// ─────────────────────────────────────────────────────────────────────────────
te::AutomatableParameter* MoshOps::findParam (const juce::var& args)
{
    auto* plugin = findPlugin (args.getProperty ("trackId", var()).toString(),
                               (int) args.getProperty ("pluginIndex", -1));
    if (plugin == nullptr) return nullptr;
    const int pi = (int) args.getProperty ("paramIndex", -1);
    if (pi < 0 || pi >= plugin->getNumAutomatableParameters()) return nullptr;
    return plugin->getAutomatableParameter (pi).get();
}

juce::var MoshOps::cmdAddAutomationPoint (const juce::var& args)
{
    auto* param = findParam (args);
    if (param == nullptr) return errResult ("add_automation_point", "no such parameter");
    const double t = juce::jmax (0.0, (double) args.getProperty ("time", 0.0));
    const float norm = juce::jlimit (0.0f, 1.0f, (float) (double) args.getProperty ("value", 0.0));
    beginTxn ("add_automation_point");
    const int idx = param->getCurve().addPoint (tracktion::TimePosition::fromSeconds (t),
                                                 param->valueRange.convertFrom0to1 (norm), 0.0f, &undoManager());
    logLine ("add_automation_point", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject(); data->setProperty ("pointIndex", idx);
    return okResult ("add_automation_point", var (data));
}

juce::var MoshOps::cmdRemoveAutomationPoint (const juce::var& args)
{
    auto* param = findParam (args);
    if (param == nullptr) return errResult ("remove_automation_point", "no such parameter");
    auto& curve = param->getCurve();
    const int idx = (int) args.getProperty ("pointIndex", -1);
    if (idx < 0 || idx >= curve.getNumPoints()) return errResult ("remove_automation_point", "bad pointIndex");
    beginTxn ("remove_automation_point");
    curve.removePoint (idx, &undoManager());
    logLine ("remove_automation_point", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_automation_point");
}

juce::var MoshOps::cmdSetAutomationPoint (const juce::var& args)
{
    // Move a point: remove + re-add at the new (time, value).
    auto* param = findParam (args);
    if (param == nullptr) return errResult ("set_automation_point", "no such parameter");
    auto& curve = param->getCurve();
    const int idx = (int) args.getProperty ("pointIndex", -1);
    if (idx < 0 || idx >= curve.getNumPoints()) return errResult ("set_automation_point", "bad pointIndex");

    const double t = juce::jmax (0.0, (double) args.getProperty ("time", curve.getPointTime (idx).inSeconds()));
    const float norm = juce::jlimit (0.0f, 1.0f,
        (float) (double) args.getProperty ("value", param->valueRange.convertTo0to1 (curve.getPointValue (idx))));
    beginTxn ("set_automation_point");
    curve.removePoint (idx, &undoManager());
    const int newIdx = curve.addPoint (tracktion::TimePosition::fromSeconds (t),
                                       param->valueRange.convertFrom0to1 (norm), 0.0f, &undoManager());
    logLine ("set_automation_point", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject(); data->setProperty ("pointIndex", newIdx);
    return okResult ("set_automation_point", var (data));
}

juce::var MoshOps::cmdClearAutomation (const juce::var& args)
{
    auto* param = findParam (args);
    if (param == nullptr) return errResult ("clear_automation", "no such parameter");
    beginTxn ("clear_automation");
    param->getCurve().clear (&undoManager());
    logLine ("clear_automation", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("clear_automation");
}

juce::var MoshOps::cmdOpenPluginEditor (const juce::var& args)
{
    auto* plugin = findPlugin (args.getProperty ("trackId", var()).toString(),
                               (int) args.getProperty ("index", -1));
    if (plugin == nullptr) return errResult ("open_plugin_editor", "no plugin");
    const bool contextActiveBefore = eng.edit().getTransport().getCurrentPlaybackContext() != nullptr;
    if (eng.hasAudio())
        eng.ensurePlaybackContext();
    const bool contextActiveAfter = eng.edit().getTransport().getCurrentPlaybackContext() != nullptr;
    pluginHost.openEditor (*plugin);          // native pop-out (not undoable)
    logLine ("open_plugin_editor", args, true, {}, false);
    auto* data = new DynamicObject();
    data->setProperty ("audioEnabled", eng.hasAudio());
    data->setProperty ("playbackContextActiveBefore", contextActiveBefore);
    data->setProperty ("playbackContextActive", contextActiveAfter);
    data->setProperty ("plugin", plugin->getName());
    return okResult ("open_plugin_editor", var (data));
}

juce::var MoshOps::cmdAddMidiClip (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    beginTxn ("add_midi_clip");
    if (track == nullptr)
        track = createAudioTrack ({});
    if (track == nullptr) return errResult ("add_midi_clip", "no track");

    // DRM-001 — default-instrument policy: a MIDI clip on an instrument-less track
    // would be silent, so auto-load the sane default in the same transaction (drum
    // track → sampler+kit, else → 4OSC). SKIP it when the track already carries WAVE
    // audio — a front-of-chain synth clears the track buffer and would silence those
    // clips. No-op too when an instrument is already present (never clobbers a choice).
    {
        bool hasWaveClips = false;
        for (auto* c : track->getClips())
            if (dynamic_cast<te::WaveAudioClip*> (c)) { hasWaveClips = true; break; }
        if (! hasWaveClips)
        {
            const bool drum = track->state.getProperty (ids::trackType, "audio").toString() == "drum";
            ensureDefaultInstrument (*track, drum);
        }
    }

    const double start = (double) args.getProperty ("start", 0.0);
    const double length = (double) args.getProperty ("length", 2.0);
    auto clip = track->insertMIDIClip (args.getProperty ("name", "MIDI").toString(),
        { tracktion::TimePosition::fromSeconds (start), tracktion::TimePosition::fromSeconds (start + length) }, nullptr);
    if (clip == nullptr) return errResult ("add_midi_clip", "insertMIDIClip failed");

    auto& sequence = clip->getSequence();
    if (auto notes = args.getProperty ("notes", var()); notes.isArray())
    {
        for (auto& n : *notes.getArray())
            sequence.addNote ((int) n.getProperty ("pitch", 60),
                              tracktion::BeatPosition::fromBeats ((double) n.getProperty ("start", 0.0)),
                              tracktion::BeatDuration::fromBeats ((double) n.getProperty ("length", 1.0)),
                              (int) n.getProperty ("velocity", 100), 0, &undoManager());
    }
    // Otherwise the clip is left EMPTY: a new MIDI clip from the "+ MIDI" button has
    // no notes — the user programs it in the piano roll. (No default arpeggio: that
    // surprised users with phantom notes. Callers wanting seed content pass `notes`.)

    auto* data = new DynamicObject();
    data->setProperty ("clipId", clip->itemID.toString());
    data->setProperty ("trackId", track->itemID.toString());
    logLine ("add_midi_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("add_midi_clip", var (data));
}

// DRM-002 — add_drum_pattern: a whole drum grid in ONE undoable command. The DSL
// parser (DrumPattern.h) is mirrored 1:1 by ui/src/ui/drumPatternUtil.ts, and the
// mock case in bridge.mock.ts mirrors THIS handler's semantics + error strings.
// Policy (owner-approved design, docs/superpowers/specs/2026-07-10-add-drum-pattern-design.md):
// clipId → per-lane replace (only the lanes named in the pattern are cleared, then
// re-laid); else a new clip lands on trackId (omitted → new "Drums" drum track).
// Instrument-less target → trackType "drum" + kit in the SAME transaction (the
// DRM-001 posture: the pattern must be audible, and specifically as DRUMS, not
// 4OSC); instrument present → untouched (melodic-808 / custom kits keep working);
// wave-audio target → error (a front-of-chain sampler clears the track buffer).
juce::var MoshOps::cmdAddDrumPattern (const juce::var& args)
{
    // Literal per-arg reads: the agent-catalog contract test regex-matches these.
    const auto pattern     = args.getProperty ("pattern", var());
    const auto trackId     = args.getProperty ("trackId", var()).toString();
    const auto clipId      = args.getProperty ("clipId", var()).toString();
    const int  stepsPerBar = (int) args.getProperty ("stepsPerBar", 16);
    const int  bars        = (int) args.getProperty ("bars", 0);
    const int  velocity    = (int) args.getProperty ("velocity", 100);
    const double start     = (double) args.getProperty ("start", 0.0);
    const auto clipName    = args.getProperty ("name", "Drums").toString();

    // Validate + parse + resolve the target BEFORE the transaction: every error
    // path below leaves no empty undo step (the cmdLoadDrumKit discipline).
    const auto parsed = parseDrumPattern (pattern, stepsPerBar, bars, velocity);
    if (! parsed.ok)
        return errResult ("add_drum_pattern", parsed.error);
    const auto laneHasPitch = [&parsed] (int pitch)
    {
        for (int p : parsed.lanePitches) if (p == pitch) return true;
        return false;
    };

    te::MidiClip* targetClip = nullptr;
    te::AudioTrack* track = nullptr;
    if (clipId.isNotEmpty())
    {
        targetClip = dynamic_cast<te::MidiClip*> (findClip (clipId));
        if (targetClip == nullptr)
            return errResult ("add_drum_pattern", "no midi clip with that id");
    }
    else if (trackId.isNotEmpty())
    {
        track = findTrack (trackId);
        if (track == nullptr)
            return errResult ("add_drum_pattern", "no track with that id");
        for (auto* c : track->getClips())
            if (dynamic_cast<te::WaveAudioClip*> (c) != nullptr)
                return errResult ("add_drum_pattern",
                    juce::String (juce::CharPointer_UTF8 ("track holds wave audio — a drum sampler would silence it; use a drum track")));
    }

    beginTxn ("add_drum_pattern");
    juce::String outClipId, outTrackId;
    int noteCount = 0;
    auto& ts = eng.edit().tempoSequence;

    if (targetClip != nullptr)
    {
        // Per-lane replace: drop ONLY the named lanes' notes (descending keeps
        // indices valid — the cmdAssignSample pad-removal idiom), then re-lay.
        auto& seq = targetClip->getSequence();
        for (int i = seq.getNumNotes(); --i >= 0;)
            if (auto* n = seq.getNote (i))
                if (laneHasPitch (n->getNoteNumber()))
                    seq.removeNote (*n, &undoManager());

        const int beatsPerBar = ts.getTimeSigAt (targetClip->getPosition().getStart()).numerator.get();
        const double sb = drumPatternStepBeats ((double) beatsPerBar, parsed.stepsPerBar);
        for (const auto& s : parsed.steps)
            seq.addNote (s.pitch, tracktion::BeatPosition::fromBeats (s.step * sb),
                         tracktion::BeatDuration::fromBeats (sb), s.velocity, 0, &undoManager());
        noteCount = seq.getNumNotes();
        outClipId = targetClip->itemID.toString();
        if (auto* tr = targetClip->getTrack())
            outTrackId = tr->itemID.toString();
    }
    else
    {
        if (track == nullptr)
        {
            track = createAudioTrack ("Drums");
            if (track == nullptr) return errResult ("add_drum_pattern", "no track");
            track->state.setProperty (ids::trackType, "drum", &undoManager());
            ensureDefaultInstrument (*track, true);
        }
        else if (! trackHasInstrument (*track))
        {
            if (track->state.getProperty (ids::trackType, "audio").toString() != "drum")
                track->state.setProperty (ids::trackType, "drum", &undoManager());
            ensureDefaultInstrument (*track, true);
        }
        // else: the track's instrument choice is respected (raw-pitch lanes can
        // drive an assign_sample'd melodic 808 or a custom pad map).

        const auto startTime = tracktion::TimePosition::fromSeconds (start);
        const int beatsPerBar = ts.getTimeSigAt (startTime).numerator.get();
        const double sb = drumPatternStepBeats ((double) beatsPerBar, parsed.stepsPerBar);
        const auto endTime = ts.toTime (tracktion::BeatPosition::fromBeats (
            ts.toBeats (startTime).inBeats() + (double) parsed.bars * beatsPerBar));
        auto clip = track->insertMIDIClip (clipName, { startTime, endTime }, nullptr);
        if (clip == nullptr) return errResult ("add_drum_pattern", "insertMIDIClip failed");

        auto& seq = clip->getSequence();
        for (const auto& s : parsed.steps)
            seq.addNote (s.pitch, tracktion::BeatPosition::fromBeats (s.step * sb),
                         tracktion::BeatDuration::fromBeats (sb), s.velocity, 0, &undoManager());
        noteCount = seq.getNumNotes();
        outClipId = clip->itemID.toString();
        outTrackId = track->itemID.toString();
    }

    auto* data = new DynamicObject();
    data->setProperty ("clipId", outClipId);
    data->setProperty ("trackId", outTrackId);
    data->setProperty ("noteCount", noteCount);
    data->setProperty ("steps", parsed.totalSteps);
    data->setProperty ("bars", parsed.bars);
    logLine ("add_drum_pattern", args, true, {}, true);
    emitSnapshotInvalidated();
    if (targetClip != nullptr)
        reactiveTouch (outClipId);   // add_note parity: a re-laid pattern re-fires a live re-imagine
    return okResult ("add_drum_pattern", var (data));
}

// Audio -> MIDI: transcribe a wave clip with Basic Pitch (out-of-process, via the
// service /transcribe). ASYNC — inference is ~1-3s, so we run it off the message
// thread and emit transcribe_status {working|done|error}; on success the result is
// landed via the existing add_midi_clip mutation path (a new, time-aligned MIDI
// track). v1 transcribes the whole SOURCE file and places notes from 0 (exact for an
// untrimmed take; a trimmed/offset clip is a documented refinement).
juce::var MoshOps::cmdTranscribeClip (const juce::var& args)
{
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto mode = args.getProperty ("mode", "mono").toString();
    if (mode != "mono" && mode != "poly") mode = "mono";

    auto* w = dynamic_cast<te::WaveAudioClip*> (findClip (clipId));
    if (w == nullptr) return errResult ("transcribe_clip", "no wave clip with that id");
    const auto srcFile = w->getCurrentSourceFile();
    if (! srcFile.existsAsFile()) return errResult ("transcribe_clip", "clip has no readable source audio");

    const double clipStart = w->getPosition().getStart().inSeconds();
    const auto srcName = w->getName();
    auto& edit = eng.edit();
    auto* tempo = edit.tempoSequence.getNumTempos() > 0 ? edit.tempoSequence.getTempo (0) : nullptr;
    const double bpm = tempo != nullptr ? tempo->getBpm() : 120.0;

    // Land a transcription result (notes in SECONDS) as a new, time-aligned MIDI track
    // via the existing add_midi_clip mutation path. ALWAYS runs on the message thread
    // (inline for wait:true; via callAsync for the async GUI path). Returns the
    // command result so the synchronous caller (harness / agent) sees the new ids.
    auto land = [this, clipId, srcName, clipStart, bpm] (bool ok, const juce::String& err, const juce::var& notesVar) -> juce::var
    {
        if (! ok || ! notesVar.isArray())
        {
            const auto msg = err.isNotEmpty() ? err : juce::String ("transcription unavailable");
            emit ("transcribe_status", [&] { auto* o = new juce::DynamicObject();
                o->setProperty ("clipId", clipId); o->setProperty ("state", "error");
                o->setProperty ("error", msg); return juce::var (o); }());
            return errResult ("transcribe_clip", msg);
        }
        // Convert seconds -> clip-local beats.
        juce::Array<var> notes;
        double maxEndS = 0.0;
        for (auto& n : *notesVar.getArray())
        {
            const double s = (double) n.getProperty ("start", 0.0);
            const double e = (double) n.getProperty ("end", 0.0);
            auto* note = new juce::DynamicObject();
            note->setProperty ("pitch", (int) n.getProperty ("pitch", 60));
            note->setProperty ("start", s * bpm / 60.0);
            note->setProperty ("length", juce::jmax (0.0625, (e - s) * bpm / 60.0));
            note->setProperty ("velocity", (int) n.getProperty ("velocity", 100));
            notes.add (juce::var (note));
            maxEndS = juce::jmax (maxEndS, e);
        }
        auto* a = new juce::DynamicObject();
        a->setProperty ("name", juce::String (juce::CharPointer_UTF8 ("MIDI \xe2\x80\xa2 ")) + srcName);   // "MIDI • <clip>"
        a->setProperty ("start", clipStart);
        a->setProperty ("length", juce::jmax (1.0, maxEndS + 0.1));
        a->setProperty ("notes", juce::var (notes));
        auto addRes = cmdAddMidiClip (juce::var (a));   // new track + clip + notes; emits snapshot_invalidated
        auto addData = addRes.getProperty ("data", var());

        emit ("transcribe_status", [&] { auto* o = new juce::DynamicObject();
            o->setProperty ("clipId", clipId); o->setProperty ("state", "done");
            o->setProperty ("noteCount", (int) notes.size()); return juce::var (o); }());

        auto* d = new juce::DynamicObject();
        d->setProperty ("status", "done");
        d->setProperty ("noteCount", (int) notes.size());
        d->setProperty ("trackId", addData.getProperty ("trackId", var()));
        d->setProperty ("midiClipId", addData.getProperty ("clipId", var()));
        return okResult ("transcribe_clip", juce::var (d));
    };

    emit ("transcribe_status", [&] { auto* o = new DynamicObject();
        o->setProperty ("clipId", clipId); o->setProperty ("state", "working");
        o->setProperty ("mode", mode); return var (o); }());
    logLine ("transcribe_clip", args, true, {}, false);

    // Synchronous mode (harness / agent): block on the transcription + land inline.
    if ((bool) args.getProperty ("wait", false))
    {
        auto result = jobManager.transcribe (srcFile, mode);
        return land ((bool) result.getProperty ("ok", false),
                     result.getProperty ("error", var()).toString(),
                     result.getProperty ("notes", var()));
    }

    // Async (GUI): inference off the message thread; land via callAsync.
    std::thread ([this, srcFile, mode, land]
    {
        auto result = jobManager.transcribe (srcFile, mode);
        const bool ok = (bool) result.getProperty ("ok", false);
        const auto err = result.getProperty ("error", var()).toString();
        auto notesVar = result.getProperty ("notes", var());
        juce::MessageManager::callAsync ([land, ok, err, notesVar] { land (ok, err, notesVar); });
    }).detach();

    auto* data = new DynamicObject();
    data->setProperty ("status", "started");
    return okResult ("transcribe_clip", var (data));
}

// Sketch Phase 0 (the embodied-capture wedge): a recorded beatbox WAV + a KNOWN bpm
// becomes a real, editable drum clip, emitted PURELY as MoshOps. The transduction
// (onset detect → kick/snare/hat heuristic → 16th-grid quantise → velocity) runs
// out-of-process under the dedicated sketch venv via the service /sketch; the result
// is landed through the existing command bodies (set_tempo → create_track{drum} →
// add_midi_clip). Deterministic: same WAV + same bpm + same bars → same hits → same
// notes (the CLI fixes its analysis params and uses no RNG). Mirrors cmdTranscribeClip.
juce::var MoshOps::cmdSketchBeatbox (const juce::var& args)
{
    const auto file = args.getProperty ("file", var()).toString();
    const double bpm = (double) args.getProperty ("bpm", 0.0);
    const int    bars = juce::jlimit (1, 2, (int) args.getProperty ("bars", 1));
    const bool   wait = (bool) args.getProperty ("wait", false);

    juce::File wav (file);
    if (file.isEmpty() || ! wav.existsAsFile())
        return errResult ("sketch_beatbox", "no readable audio file: " + file);
    if (bpm < 20.0 || bpm > 300.0)
        return errResult ("sketch_beatbox", juce::String (juce::CharPointer_UTF8 ("bpm must be 20-300 (the tempo is known — box to a click)")));

    const auto srcName = wav.getFileNameWithoutExtension();

    // Land transduced hits ({step,role,velocity}) as drum MoshOps. ALWAYS on the message
    // thread (inline for wait:true; via callAsync for the async GUI path). Returns the
    // command result so the synchronous caller (harness / agent) sees the new ids + the
    // deterministic transduction artifacts (hits/notes) for an across-runs equality check.
    auto land = [this, file, bpm, bars, srcName] (bool ok, const juce::String& err, const juce::var& hitsVar) -> juce::var
    {
        if (! ok || ! hitsVar.isArray())
        {
            const auto msg = err.isNotEmpty() ? err : juce::String ("beatbox transduction unavailable");
            emit ("sketch_status", [&] { auto* o = new juce::DynamicObject();
                o->setProperty ("file", file); o->setProperty ("state", "error");
                o->setProperty ("error", msg); return juce::var (o); }());
            return errResult ("sketch_beatbox", msg);
        }

        // role → GM percussion pitch (mirrors kDefaultKit: kick 36, snare 38, closed hat 42).
        auto rolePitch = [] (const juce::String& r) -> int {
            if (r == "snare") return 38;
            if (r == "hat")   return 42;
            return 36;   // kick (and the safe default)
        };

        const double sixteenth  = 0.25;            // beats — one 16th on the grid
        const double loopBeats  = bars * 4.0;      // 4/4
        const double loopSeconds = loopBeats * 60.0 / bpm;

        // Musical events (in clip-local BEATS) + a normalised copy of the hits. Neither
        // carries engine ids, so both are byte-identical across runs for the same input.
        juce::Array<var> notes, hitsOut;
        for (auto& h : *hitsVar.getArray())
        {
            const int step = (int) h.getProperty ("step", 0);
            const auto role = h.getProperty ("role", "kick").toString();
            const int vel  = juce::jlimit (1, 127, (int) h.getProperty ("velocity", 100));

            auto* note = new juce::DynamicObject();
            note->setProperty ("pitch", rolePitch (role));
            note->setProperty ("start", step * sixteenth);
            note->setProperty ("length", sixteenth);
            note->setProperty ("velocity", vel);
            notes.add (juce::var (note));

            auto* ho = new juce::DynamicObject();
            ho->setProperty ("step", step);
            ho->setProperty ("role", role);
            ho->setProperty ("velocity", vel);
            hitsOut.add (juce::var (ho));
        }

        auto recordOp = [] (const char* cmd, const juce::var& a) {
            auto* o = new juce::DynamicObject();
            o->setProperty ("command", cmd);
            o->setProperty ("args", a);
            return juce::var (o);
        };

        // Emit PURELY as MoshOps, via the existing command bodies (the one mutation path).
        // Coalesce the trio into ONE undo transaction so a single Ctrl-Z reverts the whole
        // "sketch a beatbox" action (otherwise it fragments into 3 steps and a partial undo
        // strands an empty drum track + altered tempo). Reuse the batch flag the agent uses
        // (beginTxn skips its own beginNewTransaction while inBatch); respect an outer batch.
        const bool ownBatch = ! inBatch;
        if (ownBatch) { undoManager().beginNewTransaction ("sketch_beatbox"); inBatch = true; }

        juce::Array<var> emitted;

        { auto* a = new juce::DynamicObject(); a->setProperty ("bpm", bpm);
          juce::var av (a); cmdSetTempo (av); emitted.add (recordOp ("set_tempo", av)); }

        juce::String trackId;
        { auto* a = new juce::DynamicObject(); a->setProperty ("type", "drum"); a->setProperty ("name", "Sketch");
          juce::var av (a); auto r = cmdCreateTrack (av);
          trackId = r.getProperty ("data", var()).getProperty ("trackId", var()).toString();
          emitted.add (recordOp ("create_track", av)); }

        juce::String clipId;
        { auto* a = new juce::DynamicObject();
          a->setProperty ("trackId", trackId);
          a->setProperty ("name", juce::String (juce::CharPointer_UTF8 ("Sketch \xe2\x80\xa2 ")) + srcName);   // "Sketch • <file>" (parity with transcribe)
          a->setProperty ("start", 0.0);
          a->setProperty ("length", loopSeconds);
          a->setProperty ("notes", juce::var (notes));
          juce::var av (a); auto r = cmdAddMidiClip (av);
          clipId = r.getProperty ("data", var()).getProperty ("clipId", var()).toString();
          emitted.add (recordOp ("add_midi_clip", av)); }

        if (ownBatch) inBatch = false;

        // §6 training byproduct — append the session tuple (RETAIN the user's own audio
        // ref: it is clean, owned provenance). Cheap to log now, expensive to reconstruct.
        {
            auto* t = new juce::DynamicObject();
            t->setProperty ("ts", juce::Time::getCurrentTime().toMilliseconds());
            t->setProperty ("tempo_bpm", bpm);
            t->setProperty ("bars", bars);
            juce::Array<var> mods; mods.add ("drums");
            t->setProperty ("modalities", juce::var (mods));
            auto* in = new juce::DynamicObject(); in->setProperty ("audio_ref", file);
            t->setProperty ("input", juce::var (in));
            auto* prim = new juce::DynamicObject(); prim->setProperty ("drums", juce::var (hitsOut));
            t->setProperty ("transduced_primitives", juce::var (prim));
            t->setProperty ("emitted_moshops", juce::var (emitted));
            auto* res = new juce::DynamicObject();
            res->setProperty ("trackId", trackId);
            res->setProperty ("midiClipId", clipId);
            res->setProperty ("noteCount", notes.size());
            t->setProperty ("result", juce::var (res));
            eng.sessionDir().getChildFile ("sketch-sessions.jsonl")
                .appendText (juce::JSON::toString (juce::var (t), true) + "\n");
        }

        emit ("sketch_status", [&] { auto* o = new juce::DynamicObject();
            o->setProperty ("file", file); o->setProperty ("state", "done");
            o->setProperty ("hitCount", (int) hitsOut.size());
            o->setProperty ("noteCount", (int) notes.size()); return juce::var (o); }());

        auto* d = new juce::DynamicObject();
        d->setProperty ("status", "done");
        d->setProperty ("bpm", bpm);
        d->setProperty ("bars", bars);
        d->setProperty ("trackId", trackId);
        d->setProperty ("midiClipId", clipId);
        d->setProperty ("hitCount", (int) hitsOut.size());
        d->setProperty ("noteCount", (int) notes.size());
        d->setProperty ("hits", juce::var (hitsOut));   // transduced primitives (deterministic)
        d->setProperty ("notes", juce::var (notes));    // musical events in beats (deterministic)
        d->setProperty ("moshops", juce::var (emitted));
        return okResult ("sketch_beatbox", juce::var (d));
    };

    // sketch_status {working|done|error} mirrors transcribe_status for a future capture UI
    // (Phase 4). In Phase 0 the only caller is the agent/harness via wait:true, which surfaces
    // any failure directly in the command RESULT (errResult) — so an error is never swallowed;
    // the async branch's event is purely forward-looking until that UI lands.
    emit ("sketch_status", [&] { auto* o = new DynamicObject();
        o->setProperty ("file", file); o->setProperty ("state", "working");
        o->setProperty ("bpm", bpm); o->setProperty ("bars", bars); return var (o); }());
    logLine ("sketch_beatbox", args, true, {}, false);

    // Synchronous (harness / agent): block on the transduction + land inline.
    if (wait)
    {
        auto result = jobManager.sketchBeatbox (wav, bpm, bars);
        return land ((bool) result.getProperty ("ok", false),
                     result.getProperty ("error", var()).toString(),
                     result.getProperty ("hits", var()));
    }

    // Async (GUI): onset analysis off the message thread; land via callAsync.
    std::thread ([this, wav, bpm, bars, land]
    {
        auto result = jobManager.sketchBeatbox (wav, bpm, bars);
        const bool ok = (bool) result.getProperty ("ok", false);
        const auto err = result.getProperty ("error", var()).toString();
        auto hitsVar = result.getProperty ("hits", var());
        juce::MessageManager::callAsync ([land, ok, err, hitsVar] { land (ok, err, hitsVar); });
    }).detach();

    auto* data = new DynamicObject();
    data->setProperty ("status", "started");
    return okResult ("sketch_beatbox", var (data));
}

juce::var MoshOps::cmdGenerateBeatRecipe (const juce::var& args)
{
    auto* body = new DynamicObject();
    if (args.hasProperty ("mood")) body->setProperty ("mood", args.getProperty ("mood", var()));
    if (args.hasProperty ("tempo")) body->setProperty ("tempo", args.getProperty ("tempo", var()));
    if (args.hasProperty ("key")) body->setProperty ("key", args.getProperty ("key", var()));
    if (args.hasProperty ("seed")) body->setProperty ("seed", args.getProperty ("seed", var()));
    if (args.hasProperty ("lead")) body->setProperty ("lead", args.getProperty ("lead", var()));
    if (args.hasProperty ("libraryDir")) body->setProperty ("libraryDir", args.getProperty ("libraryDir", var()));
    if (args.hasProperty ("paletteManifest")) body->setProperty ("paletteManifest", args.getProperty ("paletteManifest", var()));

    auto generated = jobManager.generateBeatRecipe (var (body));
    if (! generated.isObject() || ! (bool) generated.getProperty ("ok", false))
    {
        const auto msg = generated.isObject()
            ? generated.getProperty ("error", var ("recipe generation service unavailable")).toString()
            : juce::String ("recipe generation service unavailable");
        logLine ("generate_beat_recipe", args, false, msg, false);
        return errResult ("generate_beat_recipe", msg);
    }

    auto program = generated.getProperty ("program", var());
    auto commands = program.getProperty ("commands", var());
    if (! commands.isArray() || commands.size() == 0)
    {
        logLine ("generate_beat_recipe", args, false, "empty generated program", false);
        return errResult ("generate_beat_recipe", "empty generated program");
    }

    const bool ownBatch = ! inBatch;
    if (ownBatch)
    {
        undoManager().beginNewTransaction ("generate_beat_recipe");
        inBatch = true;
    }

    juce::NamedValueSet refs;
    juce::Array<var> applied;
    juce::String failure;
    int appliedCount = 0;

    for (auto& call : *commands.getArray())
    {
        const auto name = call.getProperty ("command", var()).toString();
        if (! isGeneratedRecipeCommandAllowed (name))
        {
            failure = "generated program contains disallowed command: " + name;
            break;
        }

        juce::StringArray missing;
        auto resolvedArgs = resolveGeneratedRecipeRefs (call.getProperty ("args", var (new DynamicObject())),
                                                        refs, missing);
        if (! missing.isEmpty())
        {
            failure = "generated program has unbound ref " + missing.joinIntoString (", ");
            break;
        }

        auto* step = new DynamicObject();
        step->setProperty ("command", name);
        step->setProperty ("args", resolvedArgs);
        auto stepResult = execute (var (step));
        const bool ok = (bool) stepResult.getProperty ("ok", false);

        auto* record = new DynamicObject();
        record->setProperty ("command", name);
        record->setProperty ("args", resolvedArgs);
        record->setProperty ("ok", ok);
        if (! ok)
            record->setProperty ("error", stepResult.getProperty ("error", var()).toString());
        applied.add (var (record));

        if (! ok)
        {
            failure = name + ": " + stepResult.getProperty ("error", var ("failed")).toString();
            break;
        }

        captureGeneratedRecipeRefs (call, stepResult, refs);
        ++appliedCount;
    }

    if (ownBatch)
        inBatch = false;

    if (failure.isNotEmpty())
    {
        if (ownBatch && appliedCount > 0)
        {
            undoManager().undo();
            eng.markDirty();
            emitSnapshotInvalidated();
        }
        logLine ("generate_beat_recipe", args, false, failure, false);
        return errResult ("generate_beat_recipe", failure);
    }

    logLine ("generate_beat_recipe", args, true, {}, false);
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("status", "done");
    data->setProperty ("recipeId", generated.getProperty ("recipeId", var()));
    data->setProperty ("commandCount", commands.size());
    data->setProperty ("appliedCount", appliedCount);
    data->setProperty ("unresolved", program.getProperty ("unresolved", var (Array<var>{})));
    data->setProperty ("provenance", generated.getProperty ("provenance", var()));
    data->setProperty ("applied", var (applied));
    return okResult ("generate_beat_recipe", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Wave 4 — MIDI note editing (piano-roll). Notes are addressed in BEATS within
// the clip's sequence; the index is the position in getNotes() for the current
// snapshot (the UI refetches after every edit, so indices stay valid).
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdAddNote (const juce::var& args)
{
    auto* mc = dynamic_cast<te::MidiClip*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (mc == nullptr) return errResult ("add_note", "no midi clip");

    const int pitch = juce::jlimit (0, 127, (int) args.getProperty ("pitch", 60));
    const double start = juce::jmax (0.0, (double) args.getProperty ("start", 0.0));
    const double length = juce::jmax (0.0625, (double) args.getProperty ("length", 1.0));
    const int vel = juce::jlimit (1, 127, (int) args.getProperty ("velocity", 100));

    beginTxn ("add_note");
    mc->getSequence().addNote (pitch, tracktion::BeatPosition::fromBeats (start),
                               tracktion::BeatDuration::fromBeats (length), vel, 0, &undoManager());
    logLine ("add_note", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouch (args.getProperty ("clipId", var()).toString());   // Phase 3 — auto-re-render the live hidden audio
    auto* data = new DynamicObject();
    data->setProperty ("noteCount", mc->getSequence().getNumNotes());
    return okResult ("add_note", var (data));
}

juce::var MoshOps::cmdRemoveNote (const juce::var& args)
{
    auto* mc = dynamic_cast<te::MidiClip*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (mc == nullptr) return errResult ("remove_note", "no midi clip");
    auto& seq = mc->getSequence();
    const int idx = (int) args.getProperty ("noteIndex", -1);
    if (idx < 0 || idx >= seq.getNumNotes()) return errResult ("remove_note", "bad noteIndex");

    beginTxn ("remove_note");
    seq.removeNote (*seq.getNote (idx), &undoManager());
    logLine ("remove_note", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouch (args.getProperty ("clipId", var()).toString());   // Phase 3
    return okResult ("remove_note");
}

juce::var MoshOps::cmdSetNote (const juce::var& args)
{
    auto* mc = dynamic_cast<te::MidiClip*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (mc == nullptr) return errResult ("set_note", "no midi clip");
    auto& seq = mc->getSequence();
    const int idx = (int) args.getProperty ("noteIndex", -1);
    if (idx < 0 || idx >= seq.getNumNotes()) return errResult ("set_note", "bad noteIndex");
    auto* note = seq.getNote (idx);

    beginTxn ("set_note");
    if (args.hasProperty ("pitch"))
        note->setNoteNumber (juce::jlimit (0, 127, (int) args.getProperty ("pitch", note->getNoteNumber())), &undoManager());
    if (args.hasProperty ("start") || args.hasProperty ("length"))
    {
        const double start  = juce::jmax (0.0, (double) args.getProperty ("start",  note->getStartBeat().inBeats()));
        const double length = juce::jmax (0.0625, (double) args.getProperty ("length", note->getLengthBeats().inBeats()));
        note->setStartAndLength (tracktion::BeatPosition::fromBeats (start),
                                 tracktion::BeatDuration::fromBeats (length), &undoManager());
    }
    if (args.hasProperty ("velocity"))
        note->setVelocity (juce::jlimit (1, 127, (int) args.getProperty ("velocity", note->getVelocity())), &undoManager());

    logLine ("set_note", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouch (args.getProperty ("clipId", var()).toString());   // Phase 3
    return okResult ("set_note");
}

juce::var MoshOps::cmdQuantizeNotes (const juce::var& args)
{
    auto* mc = dynamic_cast<te::MidiClip*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (mc == nullptr) return errResult ("quantize_notes", "no midi clip");
    auto& seq = mc->getSequence();

    const double division = juce::jmax (0.03125, (double) args.getProperty ("division", 1.0));   // beats
    const double strength = juce::jlimit (0.0, 1.0, (double) args.getProperty ("strength", 1.0));

    beginTxn ("quantize_notes");
    int moved = 0;
    // Snapshot the note pointers ONCE before mutating: setStartAndLength() writes
    // IDs::b, which triggers tracktion's synchronous re-sort of the live MidiList
    // (the same hazard MidiList::moveAllBeatPositions/rescale guard against by
    // binding getNotes() once). Walking seq.getNote(i) live means a note that gets
    // re-sorted past an already-visited index is silently skipped; iterating a
    // fixed local list avoids that.
    juce::Array<te::MidiNote*> notes;
    for (int i = 0; i < seq.getNumNotes(); ++i)
        notes.add (seq.getNote (i));
    for (auto* note : notes)
    {
        const double start = note->getStartBeat().inBeats();
        const double q = std::round (start / division) * division;
        const double next = start + (q - start) * strength;
        if (std::abs (next - start) > 1.0e-6)
        {
            note->setStartAndLength (tracktion::BeatPosition::fromBeats (juce::jmax (0.0, next)),
                                     note->getLengthBeats(), &undoManager());
            ++moved;
        }
    }
    logLine ("quantize_notes", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouch (args.getProperty ("clipId", var()).toString());   // Phase 3
    auto* data = new DynamicObject(); data->setProperty ("moved", moved);
    return okResult ("quantize_notes", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 7 — rights-cleared type-beat LoRA training
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdImportTrainingSource (const juce::var& args)
{
    String error;
    auto src = trainerRegistry.importSource (args, error);
    if (! error.isEmpty()) return errResult ("import_training_source", error);
    logLine ("import_training_source", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("import_training_source", src);
}

juce::var MoshOps::cmdListTrainingSources (const juce::var&)
{
    return okResult ("list_training_sources", trainerRegistry.listSources());
}

juce::var MoshOps::cmdApproveTrainingSource (const juce::var& args)
{
    String error;
    const auto sourceId = args.getProperty ("sourceId", var()).toString();
    if (sourceId.isEmpty()) return errResult ("approve_training_source", "missing sourceId");
    const bool approved = (bool) args.getProperty ("approved", true);
    auto src = trainerRegistry.approveSource (sourceId, approved, error);
    if (! error.isEmpty()) return errResult ("approve_training_source", error);
    logLine ("approve_training_source", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("approve_training_source", src);
}

juce::var MoshOps::cmdBuildTrainingCorpus (const juce::var& args)
{
    String error;
    auto bundle = trainerRegistry.buildCorpus (args, error);
    if (! error.isEmpty()) return errResult ("build_training_corpus", error);
    logLine ("build_training_corpus", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("build_training_corpus", bundle);
}

juce::var MoshOps::cmdSubmitTrainingJob (const juce::var& args)
{
    if (! trainingJobManager.ensureServiceRunning())
        return errResult ("submit_training_job", "training service unavailable");

    const auto bundlePath = args.getProperty ("corpusBundle", var()).toString();
    if (bundlePath.isEmpty())
        return errResult ("submit_training_job", "missing corpusBundle");
    const auto config = args.getProperty ("config", var());
    const auto outputDir = args.getProperty ("outputDir", var()).toString();
    const auto jobId = trainingJobManager.submitJob (bundlePath, config, outputDir);
    if (jobId.isEmpty()) return errResult ("submit_training_job", "job submit failed");

    auto* job = new DynamicObject();
    job->setProperty ("jobId", jobId);
    job->setProperty ("status", "queued");
    job->setProperty ("progress", 0.0);
    job->setProperty ("bundlePath", bundlePath);
    job->setProperty ("outputDir", outputDir.isNotEmpty()
                                    ? outputDir
                                    : File (bundlePath).getChildFile ("training-output").getChildFile (jobId).getFullPathName());
    job->setProperty ("config", config);
    trainerRegistry.updateJob (var (job));

    auto* data = new DynamicObject();
    data->setProperty ("jobId", jobId);
    data->setProperty ("bundlePath", bundlePath);
    data->setProperty ("outputDir", job->getProperty ("outputDir"));
    logLine ("submit_training_job", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("submit_training_job", var (data));
}

juce::var MoshOps::cmdTrainingJobStatus (const juce::var& args)
{
    const auto jobId = args.getProperty ("jobId", var()).toString();
    if (jobId.isEmpty()) return errResult ("training_job_status", "missing jobId");
    auto st = trainingJobManager.jobStatus (jobId);
    if (! (bool) st.getProperty ("ok", false))
        return errResult ("training_job_status", st.getProperty ("error", "job lookup failed").toString());

    auto* job = new DynamicObject();
    job->setProperty ("jobId", jobId);
    job->setProperty ("status", st.getProperty ("status", "queued"));
    job->setProperty ("progress", st.getProperty ("progress", 0.0));
    job->setProperty ("error", st.getProperty ("error", var()));
    job->setProperty ("result", st.getProperty ("result", var()));
    trainerRegistry.updateJob (var (job));
    return okResult ("training_job_status", st);
}

juce::var MoshOps::cmdCancelTrainingJob (const juce::var& args)
{
    const auto jobId = args.getProperty ("jobId", var()).toString();
    if (jobId.isEmpty()) return errResult ("cancel_training_job", "missing jobId");
    trainingJobManager.cancelJob (jobId);
    auto* job = new DynamicObject();
    job->setProperty ("jobId", jobId);
    job->setProperty ("status", "cancelled");
    job->setProperty ("progress", 0.0);
    trainerRegistry.updateJob (var (job));
    logLine ("cancel_training_job", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("cancel_training_job");
}

juce::var MoshOps::cmdImportLoraAdapter (const juce::var& args)
{
    const auto jobId = args.getProperty ("jobId", var()).toString();
    auto artifactPath = args.getProperty ("artifactPath", var()).toString();
    auto manifestPath = args.getProperty ("manifestPath", var()).toString();
    auto adapterId = args.getProperty ("adapterId", var()).toString();

    if (artifactPath.isEmpty() && jobId.isNotEmpty())
    {
        auto st = trainingJobManager.jobStatus (jobId);
        if ((bool) st.getProperty ("ok", false))
        {
            auto result = st.getProperty ("result", var());
            artifactPath = result.getProperty ("artifact_path", var()).toString();
            manifestPath = result.getProperty ("manifest_path", var()).toString();
            adapterId = result.getProperty ("adapter_id", var()).toString();
        }
    }

    String error;
    auto rec = trainerRegistry.importAdapter (artifactPath, manifestPath, adapterId, error);
    if (! error.isEmpty()) return errResult ("import_lora_adapter", error);
    logLine ("import_lora_adapter", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("import_lora_adapter", rec);
}

juce::var MoshOps::cmdActivateLoraAdapter (const juce::var& args)
{
    const auto adapterId = args.getProperty ("adapterId", var()).toString();
    if (adapterId.isEmpty()) return errResult ("activate_lora_adapter", "missing adapterId");

    auto adapters = trainerRegistry.listAdapters();
    auto adapterList = adapters.getProperty ("adapters", Array<var>());
    String adapterPath, corpusHash;
    if (auto* arr = adapterList.getArray())
        for (auto& a : *arr)
            if (a.getProperty ("adapterId", var()).toString() == adapterId)
            {
                adapterPath = a.getProperty ("artifactPath", var()).toString();
                corpusHash = a.getProperty ("bundleHash", var()).toString();
                break;
            }
    if (adapterPath.isEmpty())
        adapterPath = args.getProperty ("adapterPath", var()).toString();
    if (corpusHash.isEmpty())
        corpusHash = args.getProperty ("corpusHash", var()).toString();
    if (adapterPath.isEmpty())
        return errResult ("activate_lora_adapter", "adapter not found");

    String error;
    auto rec = trainerRegistry.activateAdapter (adapterId, adapterPath, corpusHash, error);
    if (! error.isEmpty()) return errResult ("activate_lora_adapter", error);
    logLine ("activate_lora_adapter", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("activate_lora_adapter", rec);
}

juce::var MoshOps::cmdListLoraAdapters (const juce::var&)
{
    return okResult ("list_lora_adapters", trainerRegistry.listAdapters());
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 5 — Tier-B generative layer (RenderLayer flow)
// ─────────────────────────────────────────────────────────────────────────────
juce::ValueTree MoshOps::findRenderLayer (const juce::String& clipId)
{
    if (auto* clip = findClip (clipId))
        return clip->state.getChildWithName (ids::MOSH_RENDERLAYER);
    return {};
}

juce::String MoshOps::computeFingerprint (const juce::ValueTree& node, const juce::File& inputWav,
                                         const juce::String& upstreamOverride,
                                         const juce::String& lorasKey)
{
    // Wave clips hash the staged audio. MIDI/drum clips are auto-bounced, but the bounce
    // isn't bit-deterministic (a synth's free-running phase), so they pass a stable source
    // signature instead (notes + instrument/FX state) — identical source → cache HIT.
    const auto upstreamHash = upstreamOverride.isNotEmpty() ? upstreamOverride
                                                            : juce::MD5 (inputWav).toHexString();

    // KEY-001 — feed the LIVE tempo/key context into the fingerprint (was the
    // hardcoded "120bpm/Cmaj" placeholder). bpm is the playback bpm at the start of
    // the edit; the key is the stored project intent (defaulting A/minor where unset),
    // read straight from the MOSH_PROJECT node so it matches the snapshot. A key (or
    // tempo) change therefore changes the fingerprint → render cache MISS.
    const double bpm = eng.edit().tempoSequence.getBpmAt (tracktion::TimePosition());
    auto proj = eng.edit().state.getChildWithName (ids::MOSH_PROJECT);
    const juce::String tonic = proj.hasProperty (ids::musicalTonic)
                                   ? proj.getProperty (ids::musicalTonic).toString()
                                   : juce::String (kDefaultKeyTonic);
    const juce::String keyMode = proj.hasProperty (ids::musicalMode)
                                     ? proj.getProperty (ids::musicalMode).toString()
                                     : juce::String (kDefaultKeyMode);
    const juce::String tempoKeyContext =
        juce::String (bpm, 4) + "bpm/" + tonic + " " + keyMode;

    return RenderLayer::fingerprint (node, upstreamHash, tempoKeyContext, 44100, 2,
                                     jobManager.serviceBuild(), lorasKey);
}

bool MoshOps::resolveLorasKey (const juce::ValueTree& node, juce::String& lorasKey, juce::String& err)
{
    // "name=value@sha12:trigger;" per ACTIVE (value != 0) row, rack order — resolved at
    // RENDER time via GET /loras so the key carries content identity: a retrained
    // same-name file (new sha) or a sidecar trigger edit is a cache MISS, and an
    // unknown name errors BEFORE any job submit. Non-SA3 adapters key name=value only
    // (the fake never applies adapters) — hermetic, no service round-trip.
    lorasKey = {};
    auto params = node.getChildWithName (ids::PARAMS);
    auto loras = params.getChildWithName (ids::LORAS);
    if (! loras.isValid() || loras.getNumChildren() == 0)
        return true;

    juce::Array<juce::ValueTree> active;
    for (int i = 0; i < loras.getNumChildren(); ++i)
        if (auto row = loras.getChild (i); (double) row[ids::value] != 0.0)
            active.add (row);
    if (active.isEmpty())
        return true;

    const auto adapter = node[ids::modelAdapter].toString();
    const bool isSa3 = adapter == "stable_audio3" || adapter == "sa3";
    if (! isSa3)
    {
        for (auto& row : active)
            lorasKey << row[ids::name].toString() << "=" << row[ids::value].toString() << ";";
        return true;
    }

    auto reg = jobManager.listLoras();
    if (! (bool) reg.getProperty ("ok", false))
    {
        err = "LoRA registry unavailable (generative service)";
        return false;
    }
    std::map<juce::String, juce::var> byName;
    if (auto* arr = reg.getProperty ("loras", var()).getArray())
        for (auto& r : *arr)
            byName[r.getProperty ("name", "").toString()] = r;

    for (auto& row : active)
    {
        const auto name = row[ids::name].toString();
        auto it = byName.find (name);
        if (it == byName.end() || ! (bool) it->second.getProperty ("valid", false))
        {
            const auto dir = reg.getProperty ("dir", "~/Library/Mosh/loras/sa3").toString();
            err = "LoRA '" + name + "' not found — drop the .safetensors in " + dir;
            return false;
        }
        lorasKey << name << "=" << row[ids::value].toString()
                 << "@" << it->second.getProperty ("sha12", "").toString()
                 << ":" << it->second.getProperty ("trigger", "").toString() << ";";
    }
    return true;
}

// Slice [srcStartSec, srcEndSec] of an audio file into destWav (raw, no FX) — the
// staged input for a render — ALWAYS written at 44100 Hz / 16-bit / stereo, which is
// the rate the generative engine's reader handles natively (it otherwise shells out to
// ffmpeg, fragile in the deployed app's spawned PATH). Resamples per channel with a
// deterministic LagrangeInterpolator when the source rate differs; 44100/2 also matches
// what computeFingerprint() claims. Pass [0, lengthInSeconds] for a whole clip. Returns
// false (caller errors) if the source can't be read or the range is degenerate, so a
// failed slice never silently renders the wrong audio.
static bool stageWavRegionAt44k (const juce::File& sourceFile, double srcStartSec, double srcEndSec,
                                 const juce::File& destWav)
{
    static constexpr double kStageSR   = 44100.0;
    static constexpr int    kStageBits = 16;
    static constexpr int    kStageCh   = 2;   // engine read_wav duplicates mono → stereo anyway

    if (srcEndSec <= srcStartSec) return false;
    juce::AudioFormatManager fm; fm.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader (fm.createReaderFor (sourceFile));
    if (reader == nullptr || reader->sampleRate <= 0.0) return false;

    const double sr = reader->sampleRate;
    const juce::int64 total = reader->lengthInSamples;
    juce::int64 startSamp = juce::jlimit ((juce::int64) 0, total, (juce::int64) std::floor (srcStartSec * sr));
    juce::int64 endSamp   = juce::jlimit (startSamp,       total, (juce::int64) std::ceil  (srcEndSec   * sr));
    const int numSamps = (int) (endSamp - startSamp);
    if (numSamps <= 0) return false;

    const int srcNumCh = (int) juce::jmax ((unsigned) 1, reader->numChannels);
    juce::AudioBuffer<float> srcBuf (srcNumCh, numSamps);
    if (! reader->read (&srcBuf, 0, numSamps, startSamp, true, true)) return false;

    const bool needResample = std::abs (sr - kStageSR) > 1.0e-6;
    const double ratio = sr / kStageSR;   // > 1 downsamples (48k→44.1k)
    // floor keeps outNum*ratio <= numSamps so the interpolator never reads past srcBuf
    // (a sub-sample duration loss, inaudible). For a 44100 source ratio==1 → outNum==numSamps.
    const int outNum = needResample
        ? (int) std::floor ((double) numSamps * kStageSR / sr)
        : numSamps;
    if (outNum <= 0) return false;

    juce::AudioBuffer<float> outBuf (kStageCh, outNum);
    for (int ch = 0; ch < kStageCh; ++ch)
    {
        const int srcCh = juce::jmin (ch, srcNumCh - 1);   // mono → duplicate into L/R
        if (needResample)
        {
            juce::LagrangeInterpolator interp;             // fresh per channel: zeroed history, deterministic
            interp.process (ratio, srcBuf.getReadPointer (srcCh), outBuf.getWritePointer (ch), outNum);
        }
        else
            outBuf.copyFrom (ch, 0, srcBuf, srcCh, 0, outNum);
    }

    destWav.deleteFile();
    std::unique_ptr<juce::FileOutputStream> os (destWav.createOutputStream());
    if (os == nullptr) return false;
    juce::WavAudioFormat wav;
    std::unique_ptr<juce::AudioFormatWriter> writer (
        wav.createWriterFor (os.get(), kStageSR, (unsigned) kStageCh, kStageBits, {}, 0));
    if (writer == nullptr) return false;
    os.release();   // the writer owns the stream now
    const bool wrote = writer->writeFromAudioSampleBuffer (outBuf, 0, outNum);
    writer.reset(); // flush + close before the caller reads the file back
    return wrote;
}

juce::var MoshOps::cmdCreateRenderLayer (const juce::var& args)
{
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (clipId);
    if (clip == nullptr) return errResult ("create_render_layer", "no clip: " + clipId);
    if (clip->state.getChildWithName (ids::MOSH_RENDERLAYER).isValid())
        return errResult ("create_render_layer", "clip already has a render layer");

    beginTxn ("create_render_layer");
    auto pos = clip->getPosition();
    double rStart = pos.getStart().inSeconds();
    double rEnd   = pos.getEnd().inSeconds();
    // Section-scoped render (agent "rework the hook"): an explicit sub-region — beats
    // resolved to seconds by the caller — bounds the layer to part of the clip. Clamp
    // to the clip's own range; ignore a degenerate range and fall back to the whole clip.
    if (args.hasProperty ("regionStart") && args.hasProperty ("regionEnd"))
    {
        const double cs = rStart, ce = rEnd;
        const double qs = juce::jlimit (cs, ce, (double) args.getProperty ("regionStart", cs));
        const double qe = juce::jlimit (cs, ce, (double) args.getProperty ("regionEnd",   ce));
        if (juce::jmax (qs, qe) - juce::jmin (qs, qe) > 1.0e-3) { rStart = juce::jmin (qs, qe); rEnd = juce::jmax (qs, qe); }
    }
    auto node = RenderLayer::create ("rl-" + String (Time::getCurrentTime().toMilliseconds()),
        clipId, rStart, rEnd,
        args.getProperty ("adapter", "fake").toString());
    if (args.hasProperty ("mode"))         node.setProperty (ids::mode, args.getProperty ("mode", "reimagine"), nullptr);
    if (args.hasProperty ("modelVariant")) node.setProperty (ids::modelVariant, args.getProperty ("modelVariant", ""), nullptr);
    clip->state.appendChild (node, &undoManager());

    auto* data = new DynamicObject();
    data->setProperty ("layerId", node[ids::id].toString());
    logLine ("create_render_layer", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("create_render_layer", var (data));
}

juce::var MoshOps::cmdSetRenderParam (const juce::var& args)
{
    auto node = findRenderLayer (args.getProperty ("clipId", var()).toString());
    if (! node.isValid()) return errResult ("set_render_param", "no render layer");

    beginTxn ("set_render_param");
    auto params = node.getChildWithName (ids::PARAMS);
    if (args.hasProperty ("prompt")) params.setProperty (ids::prompt, args.getProperty ("prompt", ""), &undoManager());
    // cfg/steps are engine-level sampler tuning (env), not per-render controls — not accepted here.
    if (args.hasProperty ("nl"))     params.setProperty (ids::nl, args.getProperty ("nl", 0.4), &undoManager());
    if (args.hasProperty ("target"))   params.setProperty (ids::target, args.getProperty ("target", ""), &undoManager());      // Route B
    if (args.hasProperty ("strength")) params.setProperty (ids::strength, args.getProperty ("strength", 65.0), &undoManager());  // Route B
    if (args.hasProperty ("seed"))   node.setProperty (ids::seed, args.getProperty ("seed", 0), &undoManager());
    if (args.hasProperty ("mode"))   node.setProperty (ids::mode, args.getProperty ("mode", "reimagine"), &undoManager());
    if (args.hasProperty ("coverage")) node.setProperty (ids::coverage, args.getProperty ("coverage", "auto"), &undoManager());  // whole-clip: auto|loop|stitch
    if (args.hasProperty ("modelVariant")) node.setProperty (ids::modelVariant, args.getProperty ("modelVariant", ""), &undoManager());
    if (args.hasProperty ("lab"))    params.setProperty (juce::Identifier ("lab"), args.getProperty ("lab", false), &undoManager());

    if (args.hasProperty ("colors"))   // ≤3, ordered (01 §4.4)
    {
        auto colors = params.getChildWithName (ids::COLORS);
        colors.removeAllChildren (&undoManager());
        if (auto* arr = args.getProperty ("colors", var()).getArray())
            for (int i = 0; i < juce::jmin (3, arr->size()); ++i)
            {
                auto& c = arr->getReference (i);
                juce::ValueTree col (ids::COLOR);
                col.setProperty (ids::name, c.getProperty ("name", ""), nullptr);
                col.setProperty (ids::value, c.getProperty ("value", 0), nullptr);
                colors.appendChild (col, &undoManager());
            }
    }

    if (args.hasProperty ("loras"))   // LoRA rack: unbounded, ordered (stacks merge sequentially)
    {
        // getOrCreate: layers created before the rack shipped have no LORAS child.
        // No count cap / strength clamp (owner call): value > 100 = deliberate overdrive.
        auto loras = params.getOrCreateChildWithName (ids::LORAS, &undoManager());
        loras.removeAllChildren (&undoManager());
        if (auto* arr = args.getProperty ("loras", var()).getArray())
            for (int i = 0; i < arr->size(); ++i)
            {
                auto& l = arr->getReference (i);
                juce::ValueTree lo (ids::LORA);
                lo.setProperty (ids::name, l.getProperty ("name", ""), nullptr);
                lo.setProperty (ids::value, l.getProperty ("value", 0), nullptr);
                loras.appendChild (lo, &undoManager());
            }
    }

    node.setProperty (ids::status, "dirty", nullptr);   // params changed → re-render
    logLine ("set_render_param", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouch (args.getProperty ("clipId", var()).toString());   // Phase 3 — knob auto-apply (re-render in place)
    return okResult ("set_render_param");
}

// compile_render (generative-only v1): a loose instruction → a VALIDATED render envelope,
// applied to the clip's render layer through the SAME PARAMS writes set_render_param uses
// (undoable). Mirrors runLyricGeneration's async land (inline for wait:true; off-thread +
// callAsync, epoch-guarded, for the GUI). The compiler service classifies reimagine vs
// transform vs unsupported; an "unsupported" verdict (corrective/vocal) mutates NOTHING and
// surfaces the honest `say` — we never silently re-perform the take. The compiled envelope
// flows through the existing PARAMS, so the render-cache fingerprint already covers it (no
// new key field). A transient `compiledEnvelope` blob (non-undoable, like lyricProposals)
// carries the mode/backend/reasoning to the UI.
juce::var MoshOps::cmdCompileRender (const juce::var& args)
{
    const auto clipId      = args.getProperty ("clipId", var()).toString();
    const auto instruction = args.getProperty ("instruction", var()).toString();
    const int  intensity   = (int) args.getProperty ("intensity", -1);
    const auto backend     = args.getProperty ("backend", var()).toString();   // ""(auto)|"fake"|"llm"
    const bool autoRender  = (bool) args.getProperty ("autoRender", false);
    const bool wait        = (bool) args.getProperty ("wait", false);

    if (instruction.trim().isEmpty()) return errResult ("compile_render", "instruction required");
    if (findClip (clipId) == nullptr) return errResult ("compile_render", "no clip: " + clipId);

    auto land = [this, clipId, autoRender, wait, args] (const juce::var& result) -> juce::var
    {
        auto* c = findClip (clipId);
        if (c == nullptr) return errResult ("compile_render", "clip gone");
        if (! result.isObject() || ! (bool) result.getProperty ("ok", false))
            return errResult ("compile_render", "compiler service unavailable (start the generative service)");

        const auto mode      = result.getProperty ("mode", "").toString();
        const auto reasoning = result.getProperty ("reasoning", "").toString();
        const auto backendId = result.getProperty ("backend", "").toString();
        const auto say       = result.getProperty ("say", var()).toString();

        if (mode != "reimagine" && mode != "transform")
        {
            // Non-render verdicts — the honest boundary. "corrective" names an EXISTING
            // tool (moshAutoTune/eq/moshOTT/quantize_notes) the caller runs with its own
            // track/clip context; "unsupported" (vocal/noise) declines. Either way we
            // MUTATE NOTHING — generative-only v1 never silently re-performs the take.
            logLine ("compile_render", args, true, {}, false);
            emitSnapshotInvalidated();
            auto* d = new DynamicObject();
            d->setProperty ("mode", mode);
            d->setProperty ("say", say);
            d->setProperty ("reasoning", reasoning);
            d->setProperty ("backend", backendId);
            if (result.hasProperty ("subtype")) d->setProperty ("subtype", result.getProperty ("subtype", var()));
            if (result.hasProperty ("tool"))    d->setProperty ("tool", result.getProperty ("tool", var()));
            return okResult ("compile_render", var (d));
        }

        auto env = result.getProperty ("envelope", var());
        if (! env.isObject()) return errResult ("compile_render", "compiler returned no envelope");

        beginTxn ("compile_render");
        auto node = findRenderLayer (clipId);
        if (! node.isValid())
        {
            auto pos = c->getPosition();
            const juce::String adapter =
                mode == "transform" ? juce::String ("transform")
                : (args.getProperty ("adapter", var()).toString().isNotEmpty()
                       ? args.getProperty ("adapter", "").toString()
                       : juce::String ("fake"));
            node = RenderLayer::create ("rl-" + juce::String (juce::Time::getCurrentTime().toMilliseconds()),
                                        clipId, pos.getStart().inSeconds(), pos.getEnd().inSeconds(), adapter);
            node.setProperty (ids::mode, mode, nullptr);
            if (args.hasProperty ("modelVariant")) node.setProperty (ids::modelVariant, args.getProperty ("modelVariant", ""), nullptr);
            c->state.appendChild (node, &undoManager());
        }
        else
            node.setProperty (ids::mode, mode, &undoManager());

        auto params = node.getChildWithName (ids::PARAMS);
        if (mode == "reimagine")
        {
            params.setProperty (ids::prompt, env.getProperty ("prompt", ""), &undoManager());
            params.setProperty (ids::nl,     env.getProperty ("nl", 0.4),    &undoManager());
            params.setProperty (juce::Identifier ("lab"), env.getProperty ("lab", false), &undoManager());
            auto colors = params.getChildWithName (ids::COLORS);
            colors.removeAllChildren (&undoManager());
            if (auto* arr = env.getProperty ("colors", var()).getArray())
                for (int i = 0; i < juce::jmin (3, arr->size()); ++i)
                {
                    auto& cc = arr->getReference (i);
                    juce::ValueTree col (ids::COLOR);
                    col.setProperty (ids::name,  cc.getProperty ("name", ""), nullptr);
                    col.setProperty (ids::value, cc.getProperty ("value", 0), nullptr);
                    colors.appendChild (col, &undoManager());
                }
        }
        else // transform
        {
            params.setProperty (ids::target,   env.getProperty ("target", ""),     &undoManager());
            params.setProperty (ids::strength, env.getProperty ("strength", 65.0), &undoManager());
        }
        node.setProperty (ids::seed, env.getProperty ("seed", 0), &undoManager());
        node.setProperty (ids::status, "dirty", nullptr);
        node.setProperty (ids::compiledEnvelope, juce::JSON::toString (result), nullptr);  // transient

        logLine ("compile_render", args, true, {}, true);
        emitSnapshotInvalidated();

        var renderRes;
        if (autoRender)   // convenience: kick the render immediately after compiling
        {
            auto* ra = new DynamicObject();
            ra->setProperty ("clipId", clipId);
            ra->setProperty ("wait", wait);
            renderRes = cmdRenderLayer (var (ra));
        }

        auto* d = new DynamicObject();
        d->setProperty ("mode", mode);
        d->setProperty ("backend", backendId);
        d->setProperty ("reasoning", reasoning);
        d->setProperty ("envelope", env);   // the validated envelope (UI display + eval/preference data)
        d->setProperty ("layerId", node[ids::id].toString());
        if (! renderRes.isVoid()) d->setProperty ("render", renderRes);
        return okResult ("compile_render", var (d));
    };

    // Synchronous (harness / agent): block on the compile + land inline.
    if (wait)
        return land (jobManager.compileRender (instruction, intensity, backend));

    // Async (GUI): compile off the message thread; land via callAsync, skipping if a later
    // compile superseded this one.
    const int epoch = ++compileEpoch_;
    std::thread ([this, instruction, intensity, backend, land, epoch]
    {
        auto result = jobManager.compileRender (instruction, intensity, backend);
        juce::MessageManager::callAsync ([this, land, result, epoch]
        {
            if (epoch != compileEpoch_) return;
            land (result);
        });
    }).detach();

    auto* d = new DynamicObject();
    d->setProperty ("status", "compiling");
    return okResult ("compile_render", var (d));
}

// A stable, deterministic signature of a clip's GENERATIVE SOURCE — its MIDI note content
// plus the owning track's instrument + insert-FX names and param VALUES. Used as the
// render-cache upstream hash for non-wave clips, whose bounced audio isn't bit-stable.
// Editing a note OR an instrument/FX param changes this → cache MISS; an unchanged source
// → identical signature → cache HIT. Deliberately hashes note fields + param values, NOT
// the clip/plugin `state` ValueTrees — a synth scribbles its free-running phase into its
// opaque state chunk during render, which would make the signature differ every render.
static juce::String stableSourceSig (te::Clip& clip)
{
    juce::MemoryOutputStream mos;
    if (auto* m = dynamic_cast<te::MidiClip*> (&clip))
    {
        auto& seq = m->getSequence();
        for (int i = 0; i < seq.getNumNotes(); ++i)
            if (auto* n = seq.getNote (i))
            {
                mos.writeInt (n->getNoteNumber());
                mos.writeDouble (n->getStartBeat().inBeats());
                mos.writeDouble (n->getLengthBeats().inBeats());
                mos.writeInt (n->getVelocity());
            }
    }
    if (auto* tr = clip.getTrack())
        for (auto* p : tr->pluginList.getPlugins())
            if (p != nullptr)
            {
                mos.writeString (p->getName());                         // instrument/FX identity
                mos.writeBool (p->isEnabled());                         // bypass changes the bounced audio
                const int np = p->getNumAutomatableParameters();
                for (int i = 0; i < np; ++i)
                    if (auto par = p->getAutomatableParameter (i))
                    {
                        mos.writeFloat ((float) par->getCurrentNormalisedValue());  // base value (user setting)
                        if (par->hasAutomationPoints())                 // + the automation curve shape, if any
                        {
                            auto& curve = par->getCurve();
                            for (int j = 0; j < curve.getNumPoints(); ++j)
                            {
                                mos.writeDouble (curve.getPointTime (j).inSeconds());
                                mos.writeFloat ((float) par->valueRange.convertTo0to1 (curve.getPointValue (j)));
                            }
                        }
                    }
            }
    return juce::MD5 (mos.getMemoryBlock()).toHexString();
}

bool MoshOps::bounceClipToWav (te::Clip& clip, double startSec, double endSec, const juce::File& destWav)
{
    auto* track = clip.getTrack();
    if (track == nullptr || endSec <= startSec + 1.0e-4) return false;

    auto& edit = eng.edit();

    // Render exclusivity (01 §5): detach the Edit from the device before an offline
    // render (Tracktion asserts otherwise). Mirror cmdExportAudio's teardown so the
    // master meter re-attaches to the NEXT context (no ABA reuse). No-op when headless.
    unregisterAllMeterClients();
    edit.getTransport().stop (false, false);
    edit.getTransport().freePlaybackContext();
    lastSeenContext = nullptr;

    destWav.getParentDirectory().createDirectory();
    destWav.deleteFile();

    te::Renderer::Parameters params (edit);
    params.destFile = destWav;
    params.audioFormat = edit.engine.getAudioFileFormatManager().getWavFormat();
    params.bitDepth = 24;
    params.sampleRateForAudio = 44100.0;   // match computeFingerprint's claimed SR/ch (44100/2)
    params.blockSizeForAudio = edit.engine.getDeviceManager().getBlockSize();
    if (params.blockSizeForAudio <= 0) params.blockSizeForAudio = 512;
    params.time = { tracktion::TimePosition::fromSeconds (startSec),
                    tracktion::TimePosition::fromSeconds (endSec) };       // the clip's edit-time window
    juce::Array<te::Track*> just; just.add (track);
    params.tracksToDo = te::toBitSet (just);                              // ONLY this clip's track…
    params.allowedClips.add (&clip);                                      // …and ONLY this clip (no neighbour bleed)
    params.usePlugins = true;            // we WANT the instrument + insert FX (that's the clip's sound)
    params.useMasterPlugins = false;     // bounce the track's own signal, not the full master mix
    params.createMidiFile = false;
    // Realtime-only hosted synths (e.g. Serum) can't render offline — reuse the export guard.
    params.realTimeRender = findSerumRealtimeRenderReason (edit).isNotEmpty();

    juce::String renderError;
    {
        const te::Edit::ScopedRenderStatus srs (edit, true);
        te::TransportControl::stopAllTransports (edit.engine, false, true);
        te::Renderer::turnOffAllPlugins (edit);

        if (params.tracksToDo.countNumberOfSetBits() > 0 && ! params.destFile.isDirectory())
        {
            te::Renderer::RenderTask task ("Mosh bounce", params, nullptr, nullptr);

            // Same no-progress watchdog + absolute deadline cmdExportAudio uses, so a
            // stuck bounce (e.g. an unreadable source) errors cleanly instead of hanging.
            const double secs = juce::jmax (0.1, endSec - startSec);
            const juce::uint32 startMs    = juce::Time::getMillisecondCounter();
            const juce::uint32 deadlineMs = (juce::uint32) juce::jmax (60000.0, secs * 8000.0 + 60000.0);
            const juce::uint32 stallMs    = 20000;
            float  lastProgress   = -1.0f;
            juce::uint32 lastProgressMs = startMs;
            while (task.runJob() == juce::ThreadPoolJob::jobNeedsRunningAgain)
            {
                const juce::uint32 nowMs = juce::Time::getMillisecondCounter();
                const float p = task.getCurrentTaskProgress();
                if (p > lastProgress) { lastProgress = p; lastProgressMs = nowMs; }
                if (nowMs - lastProgressMs > stallMs || nowMs - startMs > deadlineMs)
                {
                    if (task.errorMessage.isEmpty()) task.errorMessage = "bounce render stalled";
                    break;
                }
            }
            te::Renderer::turnOffAllPlugins (edit);
            if (task.errorMessage.isNotEmpty()) { renderError = task.errorMessage; destWav.deleteFile(); }
        }
        else renderError = "no renderable track for bounce";
    }
    return renderError.isEmpty() && destWav.existsAsFile() && destWav.getSize() > 0;
}

juce::var MoshOps::cmdRenderLayer (const juce::var& args)
{
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (clipId);
    auto node = findRenderLayer (clipId);
    if (clip == nullptr || ! node.isValid()) return errResult ("render_layer", "no render layer");

    // Sing precondition FIRST — before any staging work. A sheet-less sing render on a
    // MIDI/drum clip would otherwise pay a full instrument bounce before erroring (the
    // sheet can vanish between create_render_layer and render_layer via remove_lyric_sheet).
    if (node[ids::mode].toString() == "sing")
    {
        auto* singTrack = dynamic_cast<te::AudioTrack*> (clip->getTrack());
        const auto sheet = singTrack != nullptr ? singTrack->state.getChildWithName (ids::MOSH_LYRICSHEET)
                                                : juce::ValueTree();
        if (! sheet.isValid())
            return errResult ("render_layer", "sing needs a lyric sheet on the clip's track (build a flow from a take first)");
        auto lines = mosh::LyricSheet::lines (sheet);
        int singableLines = 0;
        for (int i = 0; i < lines.getNumChildren(); ++i)
            if (lyricLineIsAssertedForSing (lines.getChild (i)))
                ++singableLines;
        if (singableLines == 0)
            return errResult ("render_layer", noAssertedWordsToSingMessage());
    }

    // Phase 3 — snapshot the reactive epoch at submit; finalizeRender drops a result whose epoch the
    // node has since moved past (a newer edit-touch superseded this render). -1 ⇒ never raced.
    const int submitEpoch = (int) node[ids::reactiveEpoch];

    // Prepare the job dir + stage the render input as input.wav. Wave clips stage their
    // source audio (whole or a sliced sub-region); MIDI/drum (any non-wave) clips are
    // auto-BOUNCED to audio first (their instrument output) so the audio→audio generative
    // pipeline can run on ANY track — the model never sees MIDI.
    auto jobDir = eng.sessionDir().getChildFile ("renders").getChildFile (node[ids::id].toString());
    jobDir.createDirectory();
    auto input = jobDir.getChildFile ("input.wav");
    auto output = jobDir.getChildFile ("output.wav");
    auto manifest = jobDir.getChildFile ("output_manifest.json");
    input.deleteFile();

    // Section-scoped layers carry a sub-region tighter than the clip. The stored timeRange
    // is absolute timeline seconds frozen at create; CLAMP it to the clip's LIVE position
    // so a clip moved/trimmed since then can't mis-stage — a stale range that no longer
    // overlaps collapses to the whole clip. Computed for ALL clip types (the bounce path
    // renders [rs,re] directly via params.time; the wave path slices it).
    auto cpos = clip->getPosition();
    const double cs = cpos.getStart().inSeconds(), ce = cpos.getEnd().inSeconds();
    double rs = juce::jlimit (cs, ce, (double) node[ids::timeRangeStart]);
    double re = juce::jlimit (cs, ce, (double) node[ids::timeRangeEnd]);
    if (re <= rs + 1.0e-3) { rs = cs; re = ce; }   // stale/degenerate after a move → whole clip
    const bool subRegion = (rs > cs + 1.0e-3) || (re < ce - 1.0e-3);

    // Non-wave clips fingerprint their stable source (notes + instrument/FX), not the
    // non-deterministic bounced audio. Captured BEFORE the bounce so render side-effects
    // can't perturb it. Empty for wave clips → computeFingerprint hashes input.wav.
    juce::String upstreamOverride;

    if (auto* wave = dynamic_cast<te::WaveAudioClip*> (clip))
    {
        // Always re-imagine the PRISTINE original. Once a render is auto-applied in place
        // (the clip's source becomes the artifact), staging getCurrentSourceFile() would
        // re-imagine the previous render and compound it — so prefer originalSourceRef.
        juce::File sourceForStaging = wave->getCurrentSourceFile();
        if (const auto orig = node[ids::originalSourceRef].toString(); orig.isNotEmpty())
        {
            // originalSourceRef may be project-relative — resolve against the edit dir (a bare
            // juce::File("audio/x.wav") would be CWD-relative and miss, then wrongly stage the
            // already-applied artifact and compound the render).
            juce::File of = juce::File::isAbsolutePath (orig) ? juce::File (orig)
                            : eng.editFile().getParentDirectory().getChildFile (orig);
            if (of.existsAsFile()) sourceForStaging = of;
        }

        bool staged = false;
        if (subRegion)
        {
            const bool sliceable = std::abs (wave->getSpeedRatio() - 1.0) < 1.0e-6
                                   && ! wave->isLooping() && ! wave->getAutoTempo();
            if (sliceable)
            {
                const double off = cpos.getOffset().inSeconds();
                staged = stageWavRegionAt44k (sourceForStaging, rs - cs + off, re - cs + off, input);
            }
            if (! staged)   // never fall back to the whole clip for a section request
                return errResult ("render_layer", "section render needs an un-stretched, non-looping wave clip");
        }
        if (! staged)
        {
            // Whole clip: stage the entire source at 44100/16-bit (was a raw copyFileTo, which
            // preserved a non-44100 rate the engine reader can't handle without ffmpeg).
            juce::AudioFormatManager fm; fm.registerBasicFormats();
            std::unique_ptr<juce::AudioFormatReader> rd (fm.createReaderFor (sourceForStaging));
            const double srcLenSec = (rd != nullptr && rd->sampleRate > 0.0)
                ? (double) rd->lengthInSamples / rd->sampleRate : 0.0;
            rd.reset();
            if (srcLenSec <= 0.0
                || ! stageWavRegionAt44k (sourceForStaging, 0.0, srcLenSec, input))
                return errResult ("render_layer", "could not stage source region");
        }
    }
    else
    {
        // MIDI/drum (any non-wave) clip: fingerprint the stable source first, then bounce
        // its instrument output for [rs,re] to input.wav. params.time handles whole-clip
        // AND section renders, so no slicing. Fold the bounce window — as CLIP-RELATIVE
        // offsets — into the signature so a section render busts the cache when the clip is
        // moved/trimmed (the absolute window then covers different notes). Whole-clip stays
        // move-invariant (rs-cs=0, re-cs=clipLen). Mirrors the wave path's self-correction.
        upstreamOverride = stableSourceSig (*clip)
            + ":" + juce::String (rs - cs, 4)
            + ":" + juce::String (re - cs, 4)
            + ":" + juce::String (cpos.getOffset().inSeconds(), 4);
        // Phase 2: when this clip already has a hidden beneath-render it is MUTED (the producer hears
        // the hidden audio). bounceClipToWav must still capture the instrument output, so temporarily
        // un-mute across the (already device-detached) offline render and restore. The net ValueTree
        // change is zero — an undo of it is a no-op.
        const bool wasMuted = clip->isMuted();
        if (wasMuted) clip->setMuted (false);
        const bool bounced = bounceClipToWav (*clip, rs, re, input);
        if (wasMuted) clip->setMuted (true);
        if (! bounced)
            return errResult ("render_layer", "could not bounce clip to audio (add an instrument, or the render failed)");
    }

    // FMS Phase-3 sing mode: the render is a function of the lyric SHEET (words +
    // Stage-1 `lyricScore` flow), not just the staged audio. Gather the clip's track's
    // lines into the job params and fold their hash into the upstream key, so a lyric
    // or flow edit is a cache MISS (while the staged-audio/source hash stays in the key).
    juce::var singLines;
    if (node[ids::mode].toString() == "sing")
    {
        auto* singTrack = dynamic_cast<te::AudioTrack*> (clip->getTrack());
        auto sheet = singTrack != nullptr ? singTrack->state.getChildWithName (ids::MOSH_LYRICSHEET)
                                          : juce::ValueTree();
        if (! sheet.isValid())
            return errResult ("render_layer", "sing needs a lyric sheet on the clip's track (build a flow from a take first)");
        Array<var> arr;
        auto lines = mosh::LyricSheet::lines (sheet);
        for (int i = 0; i < lines.getNumChildren(); ++i)
        {
            auto l = lines.getChild (i);
            if (! lyricLineIsAssertedForSing (l))
                continue;
            auto* lo = new DynamicObject();
            lo->setProperty ("text", l[ids::lyricText].toString());
            const auto parsed = juce::JSON::parse (l[ids::lyricScore].toString());
            if (! parsed.isObject())
                continue;
            lo->setProperty ("score", parsed);
            lo->setProperty ("asserted", true);
            arr.add (var (lo));
        }
        if (arr.isEmpty())
            return errResult ("render_layer", noAssertedWordsToSingMessage());
        singLines = var (arr);
        const auto singJson = juce::JSON::toString (singLines, true);
        const auto singSig = juce::MD5 (singJson.toRawUTF8(), (size_t) singJson.getNumBytesAsUTF8()).toHexString();
        upstreamOverride = (upstreamOverride.isNotEmpty() ? upstreamOverride
                                                          : juce::MD5 (input).toHexString())
                           + ":sing:" + singSig;
    }

    // Ensure the service first so its build/version is part of EVERY fingerprint
    // (else the first render hashes an empty build and the cache never hits).
    if (! jobManager.ensureServiceRunning())
        return errResult ("render_layer", "generative service unavailable");

    // Resolve the LoRA rack to its content identity (sha12 + trigger via /loras) —
    // an unknown adapter name fails HERE, before any submit or cache probe.
    juce::String lorasKey, lorasErr;
    if (! resolveLorasKey (node, lorasKey, lorasErr))
        return errResult ("render_layer", lorasErr);

    const auto fp = computeFingerprint (node, input, upstreamOverride, lorasKey);

    // Cache by FULL fingerprint (05 §5) — reuse only on an exact match. Resolve the
    // artifact move-aware (AL-009): a Save-As'd project stores cacheArtifact relative.
    if (node[ids::cacheKey].toString() == fp
        && mosh::resolveCacheArtifact (node, eng.editFile().getParentDirectory()).existsAsFile())
    {
        // Re-apply on HIT too (a wave clip Reset since the last render must re-swap to the
        // cached artifact). applyRenderInPlace is a no-op repoint when already applied.
        // SING never auto-applies (same gate as finalizeRender — the guide vocal stays
        // an auditionable artifact, it must not replace the recorded take in place).
        auto art = mosh::resolveCacheArtifact (node, eng.editFile().getParentDirectory());
        if (node[ids::mode].toString() == "sing"
            || (! applyRenderInPlace (clipId, node, art, fp)
                && ! applyRenderBeneathMidi (clipId, node, art, fp)))
            node.setProperty (ids::status, "ready", nullptr);
        emit ("layer_status", [&] { auto* o = new DynamicObject();
            o->setProperty ("clipId", clipId); o->setProperty ("layerId", node[ids::id]);
            o->setProperty ("status", "ready"); o->setProperty ("cache", "hit"); return var (o); }());
        logLine ("render_layer", args, true, {}, false);
        auto* d = new DynamicObject(); d->setProperty ("cache", "hit"); d->setProperty ("status", "ready");
        return okResult ("render_layer", var (d));
    }

    // Build the job params from the node.
    auto params = node.getChildWithName (ids::PARAMS);
    auto* p = new DynamicObject();
    p->setProperty ("prompt", params[ids::prompt]);
    p->setProperty ("seed", node[ids::seed]);
    p->setProperty ("nl", params[ids::nl]);
    // cfg/steps intentionally NOT sent — sampler tuning is engine-level env on both
    // backends (MLX SA3_STEPS / CUDA MOSH_SA3_STEPS·MOSH_SA3_CFG), not a per-render param.
    p->setProperty ("mode", node[ids::mode]);          // Route B: route the adapter (reimagine|generate|transform)
    p->setProperty ("target", params[ids::target]);    // Route B transform target
    p->setProperty ("strength", params[ids::strength]); // Route B transform strength (0–100)
    Array<var> colors;
    if (auto cs = params.getChildWithName (ids::COLORS); cs.isValid())
        for (int i = 0; i < cs.getNumChildren(); ++i)
        {
            auto* co = new DynamicObject();
            co->setProperty ("name", cs.getChild (i)[ids::name]);
            co->setProperty ("value", cs.getChild (i)[ids::value]);
            colors.add (var (co));
        }
    p->setProperty ("colors", colors);
    Array<var> lorasArr;
    if (auto ls = params.getChildWithName (ids::LORAS); ls.isValid())
        for (int i = 0; i < ls.getNumChildren(); ++i)
        {
            auto* lo = new DynamicObject();
            lo->setProperty ("name", ls.getChild (i)[ids::name]);
            lo->setProperty ("value", ls.getChild (i)[ids::value]);
            lorasArr.add (var (lo));
        }
    p->setProperty ("loras", lorasArr);
    p->setProperty ("lab", (bool) params.getProperty (juce::Identifier ("lab"), false));
    if (! singLines.isVoid())
        p->setProperty ("lines", singLines);   // sing: sheet text + lyricScore flow per line

    // Whole-clip coverage (1b): tell the adapter the FULL target length + how to cover a clip
    // longer than the model's single render window — tile one cycle ("loop") or window+crossfade
    // ("stitch"). Fixes the "render came back short" 8s-cap bug. The staged input.wav IS the audio
    // to cover, so its duration is the target. "auto" → loop a clip flagged looping, else stitch.
    {
        double inputDur = re - rs;
        { juce::AudioFormatManager fm; fm.registerBasicFormats();
          if (std::unique_ptr<juce::AudioFormatReader> rd (fm.createReaderFor (input));
              rd != nullptr && rd->sampleRate > 0.0)
              inputDur = (double) rd->lengthInSamples / rd->sampleRate; }
        juce::String cov = node[ids::coverage].toString();
        if (cov.isEmpty() || cov == "auto")
        {
            const bool looping = [&] { if (auto* w = dynamic_cast<te::WaveAudioClip*> (clip)) return w->isLooping(); return false; }();
            cov = looping ? "loop" : "stitch";
        }
        p->setProperty ("duration_s", inputDur);
        p->setProperty ("coverage", cov);
        p->setProperty ("loop_seconds", inputDur);   // one cycle; the adapter clamps to its window
        p->setProperty ("xfade_ms", 8.0);
    }

    const auto jobId = jobManager.submitJob (node[ids::modelAdapter].toString(),
                                             input, output, manifest, var (p));
    if (jobId.isEmpty()) return errResult ("render_layer", "job submit failed");

    node.setProperty (ids::cacheKey, fp, nullptr);
    node.setProperty (ids::renderError, "", nullptr);   // clear any stale error from a prior failed render
    node.setProperty (ids::status, "rendering", nullptr);
    emit ("layer_status", [&] { auto* o = new DynamicObject();
        o->setProperty ("clipId", clipId); o->setProperty ("layerId", node[ids::id]);
        o->setProperty ("status", "rendering"); o->setProperty ("cache", "miss");
        o->setProperty ("jobId", jobId); return var (o); }());

    // Poll. Headless harness uses wait:true (inline); the GUI polls async on a
    // background thread so playback never stalls (05 §4) — see below.
    const bool wait = (bool) args.getProperty ("wait", false);
    if (wait)
    {
        const auto adapter = node[ids::modelAdapter].toString();
        // soulx's REAL backend is an SSH round-trip budgeted at up to 900s
        // (MOSH_SOULX_TIMEOUT_S) — the poll must outlast it or a slow render
        // reads as a false timeout. The fake path finishes in <1s regardless.
        const auto defaultWaitMs = (adapter == "stable_audio3" || adapter == "sa3") ? "360000"
                                 : (adapter == "soulx")                             ? "960000"
                                                                                    : "120000";
        const int waitTimeoutMs = juce::jmax (1000, juce::SystemStats::getEnvironmentVariable (
            "MOSH_RENDER_WAIT_TIMEOUT_MS", defaultWaitMs).getIntValue());
        const int maxPolls = juce::jmax (1, waitTimeoutMs / 50);
        const int statusConnectMs = adapter == "soulx" ? 350 : 1000;
        const int healthConnectMs = 250;
        const int maxSilentStatusPolls = adapter == "soulx" ? 3 : 5;
        int silentStatusPolls = 0;
        juce::String lastErr;
        for (int i = 0; i < maxPolls; ++i)   // default ~120s; PC CUDA cold loads can opt into longer waits
        {
            auto st = jobManager.jobStatus (jobId, statusConnectMs);
            const bool statusReachable = st.isObject();
            if (! statusReachable)
            {
                ++silentStatusPolls;
                if (output.existsAsFile() && manifest.existsAsFile())
                    break;
                if (silentStatusPolls >= maxSilentStatusPolls && ! jobManager.isHealthy (healthConnectMs))
                {
                    lastErr = "generative service stopped answering /status and /health while waiting for "
                              + adapter + " render " + jobId;
                    break;
                }
                juce::Thread::sleep (50);
                continue;
            }

            silentStatusPolls = 0;
            const auto status = st.getProperty ("status", var()).toString();
            if (const auto err = st.getProperty ("error", var()).toString(); err.isNotEmpty()) lastErr = err;
            emit ("layer_render_progress", [&] { auto* o = new DynamicObject();
                o->setProperty ("clipId", clipId); o->setProperty ("jobId", jobId);
                o->setProperty ("progress", st.getProperty ("progress", 0.0)); return var (o); }());
            // The file+manifest pair is the durable job contract. Real SA3 can finish
            // and write both files while /status is already unreachable during process
            // teardown, so don't turn a completed render into a false timeout.
            if (status == "ready" || (output.existsAsFile() && manifest.existsAsFile())
                || status == "error" || status == "cancelled")
                break;
            juce::Thread::sleep (50);
        }
        finalizeRender (clipId, output, manifest, fp, lastErr, submitEpoch);
        logLine ("render_layer", args, true, {}, false);
        auto* d = new DynamicObject(); d->setProperty ("cache", "miss");
        d->setProperty ("status", node[ids::status]); d->setProperty ("jobId", jobId);
        return okResult ("render_layer", var (d));
    }

    // Async: poll on a background thread, marshal node updates + events to the
    // message thread (service I/O off the message thread; tree on it).
    // soulx's real SSH backend runs up to 900s — poll long enough that a legitimate
    // slow render isn't abandoned as a false 'error' while the job completes unseen.
    const int asyncPolls = node[ids::modelAdapter].toString() == "soulx" ? 9600 : 1800;
    const auto asyncAdapter = node[ids::modelAdapter].toString();
    std::thread ([this, clipId, jobId, output, manifest, fp, asyncPolls, submitEpoch, asyncAdapter]
    {
        const int statusConnectMs = asyncAdapter == "soulx" ? 350 : 1000;
        const int healthConnectMs = 250;
        const int maxSilentStatusPolls = asyncAdapter == "soulx" ? 3 : 5;
        int silentStatusPolls = 0;
        juce::String lastErr;
        for (int i = 0; i < asyncPolls; ++i)   // 100ms ticks: ~180s default, ~960s soulx
        {
            auto st = jobManager.jobStatus (jobId, statusConnectMs);
            const bool statusReachable = st.isObject();
            if (! statusReachable)
            {
                ++silentStatusPolls;
                if (output.existsAsFile() && manifest.existsAsFile())
                    break;
                if (silentStatusPolls >= maxSilentStatusPolls && ! jobManager.isHealthy (healthConnectMs))
                {
                    lastErr = "generative service stopped answering /status and /health while waiting for "
                              + asyncAdapter + " render " + jobId;
                    break;
                }
                juce::Thread::sleep (100);
                continue;
            }

            silentStatusPolls = 0;
            const auto status = st.getProperty ("status", juce::var()).toString();
            const auto progress = st.getProperty ("progress", 0.0);
            if (const auto err = st.getProperty ("error", juce::var()).toString(); err.isNotEmpty()) lastErr = err;
            juce::MessageManager::callAsync ([this, clipId, jobId, progress]
            {
                emit ("layer_render_progress", [&] { auto* o = new juce::DynamicObject();
                    o->setProperty ("clipId", clipId); o->setProperty ("jobId", jobId);
                    o->setProperty ("progress", progress); return juce::var (o); }());
            });
            if (status == "ready" || (output.existsAsFile() && manifest.existsAsFile())
                || status == "error" || status == "cancelled")
                break;
            juce::Thread::sleep (100);
        }
        juce::MessageManager::callAsync ([this, clipId, output, manifest, fp, lastErr, submitEpoch]
        {
            finalizeRender (clipId, output, manifest, fp, lastErr, submitEpoch);
        });
    }).detach();

    logLine ("render_layer", args, true, {}, false);
    auto* d = new DynamicObject(); d->setProperty ("cache", "miss");
    d->setProperty ("status", "rendering"); d->setProperty ("jobId", jobId);
    return okResult ("render_layer", var (d));
}

void MoshOps::finalizeRender (const juce::String& clipId, const juce::File& outputWav,
                              const juce::File& manifestFile, const juce::String& cacheKey,
                              const juce::String& serviceError, int expectedEpoch)
{
    auto node = findRenderLayer (clipId);
    if (! node.isValid()) return;

    // Phase 3 — drop a SUPERSEDED reactive render: a newer edit-touch bumped reactiveEpoch after this
    // job was submitted, so its (now-stale) output must not overwrite the live state. The newer touch's
    // own debounced render is already coming. (expectedEpoch < 0 ⇒ a render that never raced.)
    if (expectedEpoch >= 0 && (int) node[ids::reactiveEpoch] != expectedEpoch)
        return;
    if (! outputWav.existsAsFile())
    {
        // Surface the real reason (the service's exception, when we captured one) instead of a
        // bare "error" badge — otherwise the only signal is a missing file.
        const juce::String reason = serviceError.isNotEmpty() ? serviceError
                                                              : juce::String ("render produced no output");
        node.setProperty (ids::renderError, reason, nullptr);
        node.setProperty (ids::status, "error", nullptr);
        emit ("layer_status", [&] { auto* o = new DynamicObject();
            o->setProperty ("clipId", clipId); o->setProperty ("layerId", node[ids::id]);
            o->setProperty ("status", "error"); o->setProperty ("error", reason); return var (o); }());
        emitSnapshotInvalidated();
        return;
    }

    node.setProperty (ids::renderError, "", nullptr);   // clear on success

    // P5 — boundary-quantized swap (ORDINARY renders only; the Live lane lands its own
    // windows with a crossfade at the knob, the owner's default): a render that finishes
    // while the producer is LISTENING to the target clip must not swap mid-phrase — hold
    // it until the next musical boundary (the loop wrap when looping, else the next bar),
    // then land. Stopped transport / headless / sing (never auto-applies) / a Live-armed
    // layer land immediately as before.
    double boundarySec = 0.0, armedPosSec = 0.0;
    if (node[ids::mode].toString() != "sing"
        && ! (bool) node[ids::liveArmed]
        && shouldDeferSwap (clipId, boundarySec, armedPosSec))
    {
        pendingSwaps[clipId] = { outputWav, manifestFile, cacheKey, expectedEpoch,
                                 boundarySec, armedPosSec };
        if (swapTimer == nullptr)
            swapTimer = std::make_unique<SwapTimer> (*this);
        if (! swapTimer->isTimerRunning())
            swapTimer->startTimerHz (30);   // the same decimation rate as the transport rail
        return;   // status stays "rendering"; pollPendingSwaps() lands it at the boundary
    }

    applyFinalizedRender (clipId, outputWav, manifestFile, cacheKey);
}

void MoshOps::applyFinalizedRender (const juce::String& clipId, const juce::File& outputWav,
                                    const juce::File& manifestFile, const juce::String& cacheKey)
{
    auto node = findRenderLayer (clipId);
    if (! node.isValid()) return;

    // Auto-apply the render (the new default): WAVE clips swap their own source in place; MIDI/drum
    // clips land a HIDDEN looping audio clip beneath the now-muted MIDI (Phase 2). Either way it's an
    // instant preview with no accept step. A sub-region render (or a clip with no track) falls through
    // to the legacy "Neural Renders" lane (accept_render); the apply helpers return false for it.
    // SING keeps the legacy auditionable landing: the guide vocal must never replace the producer's
    // recorded take in place (and must not arm the reactive loop — a casual edit would fire a
    // multi-minute SSH render). imagine/transform are what the in-place model was built for.
    const bool autoApply = node[ids::mode].toString() != "sing";
    if (! (autoApply && (applyRenderInPlace (clipId, node, outputWav, cacheKey)
                         || applyRenderBeneathMidi (clipId, node, outputWav, cacheKey))))
    {
        node.setProperty (ids::cacheArtifact, outputWav.getFullPathName(), nullptr);
        node.setProperty (ids::cacheKey, cacheKey, nullptr);
        node.setProperty (ids::status, "ready", nullptr);
    }

    var qa = manifestFile.existsAsFile() ? JSON::parse (manifestFile.loadFileAsString()) : var();
    emit ("layer_status", [&] { auto* o = new DynamicObject();
        o->setProperty ("clipId", clipId); o->setProperty ("layerId", node[ids::id]);
        o->setProperty ("status", "ready"); o->setProperty ("cache", "miss");
        o->setProperty ("qa", qa); return var (o); }());
    emitSnapshotInvalidated();
}

bool MoshOps::shouldDeferSwap (const juce::String& clipId, double& boundarySec, double& posSec)
{
    // Only meaningful when audio is actually audible: headless (selftest/run-script)
    // never defers, so the harness stays deterministic by construction.
    if (! eng.hasAudio())
        return false;
    if (juce::SystemStats::getEnvironmentVariable ("MOSH_SWAP_QUANTIZE", "1") == "0")
        return false;   // escape hatch: land renders the instant they finish

    auto& transport = eng.edit().getTransport();
    if (! transport.isPlaying())
        return false;

    auto* clip = findClip (clipId);
    if (clip == nullptr)
        return false;
    const auto cpos = clip->getPosition();
    const double cs = cpos.getStart().inSeconds(), ce = cpos.getEnd().inSeconds();
    posSec = transport.getPosition().inSeconds();
    if (posSec < cs - 1.0e-3 || posSec >= ce - 1.0e-3)
        return false;   // the playhead isn't in this clip — nothing audible interrupts

    // Loop wrap when the transport loop is on and surrounds the playhead — "the change
    // arrives when the loop comes around".
    if (transport.looping.get())
    {
        const auto lr = transport.getLoopRange();
        const double ls = lr.getStart().inSeconds(), le = lr.getEnd().inSeconds();
        if (le > ls && posSec >= ls && posSec < le)
        {
            boundarySec = le;
            return true;
        }
    }

    // Otherwise the next BAR boundary from the tempo sequence.
    const auto bb = eng.edit().tempoSequence.toBarsAndBeats (
        tracktion::TimePosition::fromSeconds (posSec));
    tracktion::tempo::BarsAndBeats next;
    next.bars = bb.bars + 1;
    boundarySec = eng.edit().tempoSequence.toTime (next).inSeconds();
    return boundarySec > posSec + 1.0e-3;
}

void MoshOps::pollPendingSwaps()
{
    if (pendingSwaps.empty())
    {
        if (swapTimer != nullptr)
            swapTimer->stopTimer();
        return;
    }
    auto& transport = eng.edit().getTransport();
    const bool playing = transport.isPlaying();
    const double pos = transport.getPosition().inSeconds();

    for (auto it = pendingSwaps.begin(); it != pendingSwaps.end();)
    {
        auto& ps = it->second;
        const bool wrapped = pos < ps.armedPosSec - 0.05;         // loop wrap or seek-back
        const bool reached = pos >= ps.boundarySec - 1.0e-3;
        if (! playing || wrapped || reached)
        {
            // Same staleness rule as finalizeRender: a reactive render superseded while
            // waiting at the boundary must not land.
            auto node = findRenderLayer (it->first);
            const bool fresh = node.isValid()
                && ! (ps.expectedEpoch >= 0 && (int) node[ids::reactiveEpoch] != ps.expectedEpoch);
            if (fresh)
                applyFinalizedRender (it->first, ps.outputWav, ps.manifestFile, ps.cacheKey);
            it = pendingSwaps.erase (it);
        }
        else
        {
            ps.armedPosSec = pos;   // track motion so a wrap reads as pos going backwards
            ++it;
        }
    }
    if (pendingSwaps.empty() && swapTimer != nullptr)
        swapTimer->stopTimer();
}

bool MoshOps::applyRenderInPlace (const juce::String& clipId, juce::ValueTree node,
                                  const juce::File& artifact, const juce::String& cacheKey)
{
    auto* wave = dynamic_cast<te::WaveAudioClip*> (findClip (clipId));
    if (wave == nullptr || ! artifact.existsAsFile()) return false;   // non-wave → legacy lane path

    // In-place apply replaces the WHOLE clip's source. A sub-region (section-scoped) render
    // can't simply repoint the whole source, so those keep the legacy lane landing.
    {
        auto pos = wave->getPosition();
        const double cs = pos.getStart().inSeconds(), ce = pos.getEnd().inSeconds();
        const double rs = juce::jlimit (cs, ce, (double) node[ids::timeRangeStart]);
        const double re = juce::jlimit (cs, ce, (double) node[ids::timeRangeEnd]);
        if ((rs > cs + 1.0e-3) || (re < ce - 1.0e-3)) return false;   // sub-region → legacy path
    }

    // Durable per-render copy (a disposable artifact), named by the fingerprint so a re-render
    // writes a NEW file instead of overwriting the one the clip currently plays/displays.
    auto dest = eng.sessionDir().getChildFile ("audio")
                    .getChildFile (node[ids::id].toString() + "-" + cacheKey.substring (0, 12))
                    .withFileExtension ("wav");
    dest.getParentDirectory().createDirectory();
    if (dest != artifact && ! dest.existsAsFile() && ! artifact.copyFileTo (dest))
        return false;

    // Capture the ORIGINAL source ONCE (first apply: the clip's current source IS the original).
    // Stored ABSOLUTE; cmdSaveAs's consolidateRenderArtifacts copies it into audio/renders/ and
    // re-points it relative, so the saved project carries no absolute pool path AND "Reset to
    // original" survives a Save-As + move.
    if (node[ids::originalSourceRef].toString().isEmpty())
        node.setProperty (ids::originalSourceRef, wave->getCurrentSourceFile().getFullPathName(), nullptr);

    // The in-place swap is a regenerable PREVIEW, not an undo-history edit — Tracktion's
    // SourceFileReference change isn't routed through the UndoManager. reset_render_layer is the
    // way back; it persists across save/reload via originalSourceRef. (relative iff under the
    // project dir, mirroring relink_clip.)
    const bool local = dest.isAChildOf (eng.editFile().getParentDirectory());
    mosh::repointWaveClipSource (*wave, dest, eng.editFile().getParentDirectory(), local);
    node.setProperty (ids::appliedInPlace, true, nullptr);
    // cacheArtifact stored ABSOLUTE; cmdSaveAs's consolidateRenderArtifacts copies it into
    // audio/renders/ + re-points it relative (so the saved project carries no absolute pool path).
    node.setProperty (ids::cacheArtifact, dest.getFullPathName(), nullptr);
    node.setProperty (ids::cacheKey, cacheKey, nullptr);
    node.setProperty (ids::status, "ready", nullptr);
    return true;
}

bool MoshOps::applyRenderBeneathMidi (const juce::String& clipId, juce::ValueTree node,
                                      const juce::File& artifact, const juce::String& cacheKey)
{
    auto* midi = findClip (clipId);
    if (midi == nullptr || dynamic_cast<te::WaveAudioClip*> (midi) != nullptr) return false;   // wave → in-place path
    if (! artifact.existsAsFile()) return false;

    // Whole-clip only — a sub-region (section-scoped) MIDI render can't be the clip's "hidden self",
    // so those keep the legacy lane landing.
    {
        auto pos = midi->getPosition();
        const double cs = pos.getStart().inSeconds(), ce = pos.getEnd().inSeconds();
        const double rs = juce::jlimit (cs, ce, (double) node[ids::timeRangeStart]);
        const double re = juce::jlimit (cs, ce, (double) node[ids::timeRangeEnd]);
        if ((rs > cs + 1.0e-3) || (re < ce - 1.0e-3)) return false;   // sub-region → legacy path
    }

    // Durable per-render copy (a disposable artifact), named by the fingerprint so a re-render writes
    // a NEW file rather than overwriting the one the hidden clip currently plays.
    auto dest = eng.sessionDir().getChildFile ("audio")
                    .getChildFile (node[ids::id].toString() + "-" + cacheKey.substring (0, 12))
                    .withFileExtension ("wav");
    dest.getParentDirectory().createDirectory();
    if (dest != artifact && ! dest.existsAsFile() && ! artifact.copyFileTo (dest))
        return false;
    const bool local = dest.isAChildOf (eng.editFile().getParentDirectory());

    // RE-RENDER → HOT-SWAP: the hidden clip already exists, so just repoint its source (no structural
    // edit, no undo churn). The MIDI stays muted; the producer hears the updated audio in place.
    if (auto hiddenId = node[kLandedClipId].toString(); hiddenId.isNotEmpty())
        if (auto* hidden = dynamic_cast<te::WaveAudioClip*> (findClip (hiddenId)))
        {
            mosh::repointWaveClipSource (*hidden, dest, eng.editFile().getParentDirectory(), local);
            node.setProperty (ids::cacheArtifact, dest.getFullPathName(), nullptr);
            node.setProperty (ids::cacheKey, cacheKey, nullptr);
            node.setProperty (ids::status, "ready", nullptr);
            return true;
        }

    // FIRST apply: land the hidden full-span audio on a dedicated HIDDEN, INSTRUMENT-FREE track (NOT
    // the source track — its synth would overwrite the buffer and silence the clip) at the MIDI clip's
    // edit position, and MUTE the source MIDI so the re-imagined audio is what plays. snapshot()
    // excludes the hidden track, so the producer hears it but never sees it. One undoable unit — an undo
    // of it is exactly reset_render_layer (hidden clip removed + MIDI un-muted). The hidden track/clip +
    // the mute + the node markers persist with the .tracktionedit, so the model survives save/reload.
    auto pos = midi->getPosition();
    beginTxn ("apply_render_beneath");
    auto* hiddenTrack = findOrCreateHiddenRenderTrack();
    if (hiddenTrack == nullptr) return false;
    auto landed = hiddenTrack->insertWaveClip ("mosh-render-" + midi->getName(), dest,
        { { pos.getStart(), pos.getLength() }, {} }, false);
    if (landed == nullptr) return false;
    landed->state.setProperty (ids::moshHidden, true, &undoManager());
    midi->setMuted (true);
    node.setProperty (kLandedClipId, landed->itemID.toString(), &undoManager());
    node.setProperty (kSourceMutedByLayer, true, &undoManager());
    node.setProperty (ids::cacheArtifact, dest.getFullPathName(), nullptr);   // regenerable metadata → no undo
    node.setProperty (ids::cacheKey, cacheKey, nullptr);
    node.setProperty (ids::status, "ready", nullptr);
    return true;
}

te::AudioTrack* MoshOps::findOrCreateHiddenRenderTrack()
{
    // The single shared, instrument-free, snapshot-excluded track that holds every drum/MIDI
    // beneath-render clip (Phase 2). Found by its moshHidden flag (the name is cosmetic); created
    // once and reused. NOT undo-created on purpose mismatch — it's created inside the caller's txn.
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr && (bool) t->state.getProperty (ids::moshHidden, false))
            return t;
    auto* t = createAudioTrack ("re-imagined (hidden)");
    if (t != nullptr)
        t->state.setProperty (ids::moshHidden, true, &undoManager());
    return t;
}

juce::var MoshOps::cmdResetRenderLayer (const juce::var& args)
{
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (clipId);
    auto node = findRenderLayer (clipId);
    if (clip == nullptr || ! node.isValid()) return errResult ("reset_render_layer", "no render layer");

    // Phase 2 — MIDI/drum beneath-model: remove the hidden audio clip and un-mute the source MIDI, so
    // the producer is back to the live, editable instrument. Undoable (mirrors the apply txn).
    if (dynamic_cast<te::WaveAudioClip*> (clip) == nullptr)
    {
        if (! (bool) node[kSourceMutedByLayer])
            return errResult ("reset_render_layer", "nothing to reset");
        beginTxn ("reset_render_layer");
        if (auto hiddenId = node[kLandedClipId].toString(); hiddenId.isNotEmpty())
            if (auto* hidden = findClip (hiddenId); hidden != nullptr && hidden != clip)
                hidden->removeFromParent();
        clip->setMuted (false);
        node.setProperty (kLandedClipId, "", &undoManager());
        node.setProperty (kSourceMutedByLayer, false, &undoManager());
        node.setProperty (ids::status, "dirty", &undoManager());   // re-imagine is available again
        logLine ("reset_render_layer", args, true, {}, false);
        emitSnapshotInvalidated();
        return okResult ("reset_render_layer");
    }

    auto* wave = dynamic_cast<te::WaveAudioClip*> (clip);
    const auto orig = node[ids::originalSourceRef].toString();
    if (orig.isEmpty()) return errResult ("reset_render_layer", "no original source to restore");
    juce::File of = juce::File::isAbsolutePath (orig) ? juce::File (orig)
                    : eng.editFile().getParentDirectory().getChildFile (orig);
    if (! of.existsAsFile()) return errResult ("reset_render_layer", "original source missing");

    const bool local = of.isAChildOf (eng.editFile().getParentDirectory());
    mosh::repointWaveClipSource (*wave, of, eng.editFile().getParentDirectory(), local);
    node.setProperty (ids::appliedInPlace, false, nullptr);
    node.setProperty (ids::status, "dirty", nullptr);   // re-imagine is available again
    logLine ("reset_render_layer", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("reset_render_layer");
}

// ── Phase 3 — reactive auto-re-render ────────────────────────────────────────
void MoshOps::reactiveTouch (const juce::String& clipId)
{
    // Lane A — while this clip is Live-armed, render-ahead OWNS re-rendering: route a knob/edit touch
    // to a re-lay from the playhead forward (new params) instead of the debounced whole-clip fire.
    // Placed BEFORE the hasAudio guard so a hermetic run-script that armed Live still re-lays; in
    // --selftest renderAhead_ is never armed, so this is a no-op (hermetic preserved).
    if (renderAhead_.active && renderAhead_.clipId == clipId)
    { renderAheadParamChanged (clipId); return; }

    // Hermetic-harness guard: a reactive render SPAWNS the generative service, so in headless runs
    // (no audio device — --selftest / --run-script) it stays OFF unless a test explicitly opts in via
    // MOSH_REACTIVE_DEBOUNCE_MS. Keeps --selftest deterministic + service-free; the real GUI (hasAudio)
    // and the reactive verify check both arm it.
    static const bool explicitDebounce =
        juce::SystemStats::getEnvironmentVariable ("MOSH_REACTIVE_DEBOUNCE_MS", "").trim().isNotEmpty();
    if (! eng.hasAudio() && ! explicitDebounce) return;

    auto node = findRenderLayer (clipId);
    if (! node.isValid()) return;
    if (! (bool) node.getProperty (ids::reactive, true)) return;   // per-layer opt-out (default on)
    // Only when a render is actually LIVE: a wave clip's source IS the render (appliedInPlace), or a
    // MIDI/drum clip's hidden audio plays beneath it (kSourceMutedByLayer). A dormant layer (created
    // but never rendered, or reset) is left alone — editing it shouldn't conjure a render.
    if (! ((bool) node[ids::appliedInPlace] || (bool) node[kSourceMutedByLayer])) return;

    // Bump the epoch so any in-flight render for this clip is dropped on finalize (superseded), then
    // (re)start the debounce — a burst of edits collapses to ONE re-render after it settles.
    node.setProperty (ids::reactiveEpoch, (int) node[ids::reactiveEpoch] + 1, nullptr);
    const int ms = juce::jmax (1, juce::SystemStats::getEnvironmentVariable (
        "MOSH_REACTIVE_DEBOUNCE_MS", "500").getIntValue());
    auto& timer = reactiveTimers[clipId];
    if (timer == nullptr)
    {
        auto t = std::make_unique<LambdaTimer>();
        t->fn = [this, clipId] { reactiveFire (clipId); };
        timer = std::move (t);
    }
    timer->startTimer (ms);
}

void MoshOps::reactiveTouchTrack (const juce::String& trackId)
{
    // An instrument/FX edit changes a MIDI clip's bounce (the stableSourceSig folds the track's
    // plugins in) → re-touch every applied NON-wave clip on the track. Wave in-place renders stage
    // the clip's own audio (independent of track FX), so they're not affected.
    auto* track = findTrack (trackId);
    if (track == nullptr) return;
    for (auto* c : track->getClips())
        if (c != nullptr && dynamic_cast<te::WaveAudioClip*> (c) == nullptr)
            reactiveTouch (c->itemID.toString());
}

void MoshOps::reactiveFire (const juce::String& clipId)
{
    // The debounce elapsed — fire a background (wait:false) re-render. cmdRenderLayer re-stages the
    // CURRENT source (post-edit), so an identical source HITs the cache (instant) and a changed one
    // re-renders + hot-swaps. The result envelope is ignored (this is an internal regeneration).
    if (! findRenderLayer (clipId).isValid()) return;   // layer removed since the touch
    auto* o = new juce::DynamicObject();
    o->setProperty ("clipId", clipId);
    o->setProperty ("wait", false);
    cmdRenderLayer (juce::var (o));
}

// ── Lane A — render-ahead ("Live") ───────────────────────────────────────────────
juce::var MoshOps::buildRenderAheadParams (const juce::ValueTree& node) const
{
    // node → single-window render params (same shape as cmdRenderLayer's job params, minus the
    // whole-clip coverage: the scheduler stages one 8s slice per window and stitches them itself).
    auto params = node.getChildWithName (ids::PARAMS);
    auto* p = new juce::DynamicObject();
    p->setProperty ("prompt", params[ids::prompt]);
    p->setProperty ("seed", node[ids::seed]);          // stable across windows → consistent "voice"
    p->setProperty ("nl", params[ids::nl]);
    // cfg/steps intentionally NOT sent — engine-level sampler tuning (see cmdRenderLayer).
    p->setProperty ("mode", node[ids::mode]);          // reimagine (Live is wave-clip re-imagine)
    p->setProperty ("target", params[ids::target]);
    p->setProperty ("strength", params[ids::strength]);
    juce::Array<juce::var> colors;
    if (auto cs = params.getChildWithName (ids::COLORS); cs.isValid())
        for (int i = 0; i < cs.getNumChildren(); ++i)
        {
            auto* co = new juce::DynamicObject();
            co->setProperty ("name", cs.getChild (i)[ids::name]);
            co->setProperty ("value", cs.getChild (i)[ids::value]);
            colors.add (juce::var (co));
        }
    p->setProperty ("colors", colors);
    juce::Array<juce::var> loras;
    if (auto ls = params.getChildWithName (ids::LORAS); ls.isValid())
        for (int i = 0; i < ls.getNumChildren(); ++i)
        {
            auto* lo = new juce::DynamicObject();
            lo->setProperty ("name", ls.getChild (i)[ids::name]);
            lo->setProperty ("value", ls.getChild (i)[ids::value]);
            loras.add (juce::var (lo));
        }
    p->setProperty ("loras", loras);
    p->setProperty ("lab", (bool) params.getProperty (juce::Identifier ("lab"), false));
    p->setProperty ("coverage", "single");             // one 8s window — no tile/stitch inside a window
    return juce::var (p);
}

juce::var MoshOps::cmdRenderAheadArm (const juce::var& args)
{
    const auto clipId = args.getProperty ("clipId", var()).toString();
    const bool armed  = (bool) args.getProperty ("armed", true);
    auto* clip = findClip (clipId);
    auto node  = findRenderLayer (clipId);
    if (clip == nullptr || ! node.isValid()) return errResult ("render_ahead_arm", "no render layer");

    if (! armed)
    {
        renderAheadDisarm();
        logLine ("render_ahead_arm", args, true, {}, false);
        return okResult ("render_ahead_arm", [] { auto* o = new DynamicObject(); o->setProperty ("armed", false); return var (o); }());
    }

    // v1 is WAVE-clip only: the clip's own source is progressively repointed. (MIDI/drum keep the
    // existing whole-clip beneath-render path — a progressive beneath variant is a later increment.)
    auto* wave = dynamic_cast<te::WaveAudioClip*> (clip);
    if (wave == nullptr)
        return errResult ("render_ahead_arm", "live render-ahead is wave-clip only (v1)");

    // Bring the generative service up ONCE at arm time (submitJob/stitchWindows don't self-spawn).
    if (! jobManager.ensureServiceRunning())
        return errResult ("render_ahead_arm", "generative service unavailable");

    // If another clip was armed, disarm it first (one Live clip at a time — the MLX worker is serial).
    if (renderAhead_.active && renderAhead_.clipId != clipId)
        renderAheadDisarm();

    auto& ra = renderAhead_;
    ra.active   = true;
    ra.clipId   = clipId;
    ra.layerId  = node[ids::id].toString();
    ra.epoch   += 1;                                    // fresh generation
    ra.winLen   = juce::jmax (1.0, juce::SystemStats::getEnvironmentVariable ("SA3_SECONDS", "8.0").getDoubleValue());
    auto cpos   = clip->getPosition();
    ra.clipStart = cpos.getStart().inSeconds();
    ra.clipEnd   = cpos.getEnd().inSeconds();
    ra.srcOffset = cpos.getOffset().inSeconds();
    ra.lastPlayheadSec = ra.clipStart;

    // Pristine original (prefer originalSourceRef so we never compound a prior in-place render).
    juce::File src = wave->getCurrentSourceFile();
    if (const auto orig = node[ids::originalSourceRef].toString(); orig.isNotEmpty())
    {
        juce::File of = juce::File::isAbsolutePath (orig) ? juce::File (orig)
                        : eng.editFile().getParentDirectory().getChildFile (orig);
        if (of.existsAsFile()) src = of;
    }
    ra.sourceFile = src;
    ra.adapter    = node[ids::modelAdapter].toString();
    ra.jobParams  = buildRenderAheadParams (node);
    ra.jobDir     = eng.sessionDir().getChildFile ("renders").getChildFile (ra.layerId).getChildFile ("live");
    ra.jobDir.createDirectory();

    const double clipLen = juce::jmax (0.0, ra.clipEnd - ra.clipStart);
    ra.numWindows = juce::jmax (1, (int) std::ceil (clipLen / ra.winLen - 1.0e-6));
    ra.nextWindow = 0;
    ra.growSeq    = 0;
    ra.rendering  = false;
    ra.originalCaptured = false;
    ra.windows.assign ((size_t) ra.numWindows, juce::File());

    node.setProperty (ids::liveArmed, true, nullptr);
    emit ("layer_status", [&] { auto* o = new DynamicObject();
        o->setProperty ("clipId", clipId); o->setProperty ("layerId", ra.layerId);
        o->setProperty ("status", "live"); o->setProperty ("live", true); return var (o); }());

    // Pre-warm from the current transport position (arming mid-play shouldn't render windows behind
    // the playhead). Async in the GUI; a hermetic run-script drives the clock via render_ahead_tick.
    if (eng.hasAudio())
        renderAheadTick (eng.edit().getTransport().getPosition().inSeconds());

    logLine ("render_ahead_arm", args, true, {}, false);
    auto* d = new DynamicObject();
    d->setProperty ("armed", true);
    d->setProperty ("windows", ra.numWindows);
    d->setProperty ("windowSeconds", ra.winLen);
    return okResult ("render_ahead_arm", var (d));
}

void MoshOps::renderAheadDisarm()
{
    auto& ra = renderAhead_;
    if (! ra.active && ra.clipId.isEmpty()) return;
    ra.epoch += 1;                                      // drop any in-flight window completion
    ra.active = false;
    if (auto node = findRenderLayer (ra.clipId); node.isValid())
        node.setProperty (ids::liveArmed, false, nullptr);
    const auto clipId = ra.clipId;
    ra.clipId = {}; ra.layerId = {};
    ra.windows.clear();
    emit ("layer_status", [&] { auto* o = new DynamicObject();
        o->setProperty ("clipId", clipId); o->setProperty ("status", "ready");
        o->setProperty ("live", false); return var (o); }());
}

void MoshOps::renderAheadTick (double playheadSec)
{
    auto& ra = renderAhead_;
    if (! ra.active) return;
    ra.lastPlayheadSec = playheadSec;
    if (ra.rendering) return;                           // one window in flight (MLX serial)

    const int cw = juce::jlimit (0, ra.numWindows - 1,
                                 (int) std::floor ((playheadSec - ra.clipStart) / ra.winLen));
    const int target = juce::jmin (cw + ra.lookahead, ra.numWindows - 1);
    if (ra.nextWindow <= target && ra.nextWindow < ra.numWindows)
        renderAheadStartWindow (ra.nextWindow);
}

bool MoshOps::renderAheadSubmitWindow (int k, int epoch, juce::String& jobId,
                                       juce::File& outFile, juce::File& manifest)
{
    auto& ra = renderAhead_;
    const double srcStart = ra.srcOffset + (double) k * ra.winLen;
    const double srcEnd   = ra.srcOffset + juce::jmin ((double) (k + 1) * ra.winLen, ra.clipEnd - ra.clipStart);
    const juce::String stem = "win_" + juce::String (k) + "_e" + juce::String (epoch);
    auto inFile = ra.jobDir.getChildFile (stem + "_in.wav");
    outFile     = ra.jobDir.getChildFile (stem + "_out.wav");
    manifest    = ra.jobDir.getChildFile (stem + "_out.wav.manifest.json");
    if (! stageWavRegionAt44k (ra.sourceFile, srcStart, srcEnd, inFile))
        return false;
    jobId = jobManager.submitJob (ra.adapter, inFile, outFile, manifest, ra.jobParams);
    return jobId.isNotEmpty();
}

void MoshOps::renderAheadStartWindow (int k)
{
    auto& ra = renderAhead_;
    ra.rendering = true;
    const int capturedEpoch = ra.epoch;
    juce::String jobId; juce::File outFile, manifest;
    if (! renderAheadSubmitWindow (k, capturedEpoch, jobId, outFile, manifest))
    {
        ra.rendering = false;
        emit ("layer_status", [&] { auto* o = new DynamicObject();
            o->setProperty ("clipId", ra.clipId); o->setProperty ("status", "error");
            o->setProperty ("error", "render-ahead window submit failed"); return var (o); }());
        renderAheadDisarm();
        return;
    }

    // Ceiling for one window, 100ms ticks. Default unchanged (~180s); PC CUDA cold
    // loads (model load + first render) can opt into longer via the same knob the
    // render-layer wait honours (verify-pc-build.ps1 -RealSA3 sets 600000).
    const int waitMs = juce::jmax (1000, juce::SystemStats::getEnvironmentVariable (
        "MOSH_RENDER_WAIT_TIMEOUT_MS", "180000").getIntValue());
    const int maxPolls = juce::jmax (1, waitMs / 100);

    // Poll on a background thread (service I/O off the message thread); marshal the placement back.
    std::thread ([this, k, capturedEpoch, jobId, outFile, manifest, maxPolls]
    {
        for (int i = 0; i < maxPolls; ++i)
        {
            auto st = jobManager.jobStatus (jobId);
            const auto status = st.getProperty ("status", juce::var()).toString();
            if (status == "ready" || (outFile.existsAsFile() && manifest.existsAsFile())
                || status == "error" || status == "cancelled")
                break;
            juce::Thread::sleep (100);
        }
        juce::MessageManager::callAsync ([this, k, capturedEpoch, outFile]
        {
            auto& r = renderAhead_;
            r.rendering = false;
            if (! r.active || capturedEpoch != r.epoch) { if (r.active) renderAheadTick (r.lastPlayheadSec); return; }
            if (! outFile.existsAsFile())
            {
                emit ("layer_status", [&] { auto* o = new DynamicObject();
                    o->setProperty ("clipId", r.clipId); o->setProperty ("status", "error");
                    o->setProperty ("error", "render-ahead window failed"); return var (o); }());
                renderAheadDisarm();
                return;
            }
            // A window that rendered but failed to STITCH/repoint must surface, not
            // silently no-op (a /stitch_windows failure once made the whole Live lane
            // report success while never changing the audio). A false return with a
            // matching epoch == the stitch/repoint failed; superseded/disarmed is fine.
            if (! renderAheadWindowDone (k, capturedEpoch, outFile)
                && r.active && capturedEpoch == r.epoch)
            {
                emit ("layer_status", [&] { auto* o = new DynamicObject();
                    o->setProperty ("clipId", r.clipId); o->setProperty ("status", "error");
                    o->setProperty ("error", "render-ahead stitch failed"); return var (o); }());
                renderAheadDisarm();
                return;
            }
            if (r.active) renderAheadTick (r.lastPlayheadSec);   // chain the next window
        });
    }).detach();
}

bool MoshOps::renderAheadWindowDone (int k, int epoch, const juce::File& outFile)
{
    auto& ra = renderAhead_;
    if (! ra.active || epoch != ra.epoch) return false;   // disarmed / superseded by a re-lay
    if (! outFile.existsAsFile()) return false;

    if (k >= (int) ra.windows.size()) ra.windows.resize ((size_t) (k + 1));
    ra.windows[(size_t) k] = outFile;
    ra.nextWindow = juce::jmax (ra.nextWindow, k + 1);

    // Contiguous completed prefix [0..m]; stitch it into the growing render-ahead file.
    int m = -1;
    for (int i = 0; i < (int) ra.windows.size(); ++i)
    {
        if (ra.windows[(size_t) i] != juce::File() && ra.windows[(size_t) i].existsAsFile()) m = i;
        else break;
    }
    if (m < 0) return true;

    juce::StringArray paths;
    for (int i = 0; i <= m; ++i) paths.add (ra.windows[(size_t) i].getFullPathName());
    auto dest = ra.jobDir.getChildFile ("render_ahead_" + juce::String (ra.growSeq) + ".wav");
    const double covered = jobManager.stitchWindows (paths, dest, 0.0, 1.0);   // 1ms — owner-tuned
    if (covered <= 0.0 || ! dest.existsAsFile()) return false;

    if (auto* wave = dynamic_cast<te::WaveAudioClip*> (findClip (ra.clipId)))
    {
        auto node = findRenderLayer (ra.clipId);
        if (! ra.originalCaptured)
        {
            if (node.isValid() && node[ids::originalSourceRef].toString().isEmpty())
                node.setProperty (ids::originalSourceRef, wave->getCurrentSourceFile().getFullPathName(), nullptr);
            ra.originalCaptured = true;
        }
        const bool local = dest.isAChildOf (eng.editFile().getParentDirectory());
        mosh::repointWaveClipSource (*wave, dest, eng.editFile().getParentDirectory(), local);
        if (node.isValid())
        {
            node.setProperty (ids::appliedInPlace, true, nullptr);
            node.setProperty (ids::cacheArtifact, dest.getFullPathName(), nullptr);
            node.setProperty (ids::status, "ready", nullptr);
        }
    }
    ra.growSeq += 1;

    emit ("render_ahead", [&] { auto* o = new DynamicObject();
        o->setProperty ("clipId", ra.clipId);
        o->setProperty ("coveredSeconds", covered);
        o->setProperty ("windows", m + 1);
        o->setProperty ("total", ra.numWindows); return var (o); }());
    return true;
}

void MoshOps::renderAheadParamChanged (const juce::String& clipId)
{
    auto& ra = renderAhead_;
    if (! ra.active || ra.clipId != clipId) return;
    auto node = findRenderLayer (clipId);
    if (! node.isValid()) return;

    ra.epoch += 1;                                      // supersede any in-flight window
    ra.jobParams = buildRenderAheadParams (node);       // capture the new knob values

    // Keep windows BEHIND the playhead (already heard, old params fine); re-render from the current
    // window forward. The stitch crossfades old→new at that seam (1ms, at the playhead) — a smooth
    // timbral shift exactly where the producer turned the knob.
    const int cw = juce::jlimit (0, ra.numWindows - 1,
                                 (int) std::floor ((ra.lastPlayheadSec - ra.clipStart) / ra.winLen));
    for (int i = cw; i < (int) ra.windows.size(); ++i) ra.windows[(size_t) i] = juce::File();
    ra.nextWindow = cw;
    // Do NOT kick a render here: the GUI's 30Hz transport tick (or a run-script's explicit wait-tick)
    // picks up the reset nextWindow within ~33ms. Kicking the async path directly would wedge headless
    // (callAsync never fires without a pumped message loop) and could race an in-flight window.
}

juce::var MoshOps::cmdRenderAheadTick (const juce::var& args)
{
    // Explicit clock tick. The GUI drives renderAheadTick from the transport timer (async); this
    // command lets a HERMETIC run-script drive a simulated playhead. wait:true renders the due
    // windows INLINE (no message-loop dependence) so a headless harness sees deterministic coverage.
    auto& ra = renderAhead_;
    if (! ra.active) return errResult ("render_ahead_tick", "not armed");
    const double playhead = (double) args.getProperty ("playheadSec", ra.lastPlayheadSec);
    const bool wait = (bool) args.getProperty ("wait", false);
    ra.lastPlayheadSec = playhead;

    if (! wait) { renderAheadTick (playhead); return okResult ("render_ahead_tick"); }

    const int cw = juce::jlimit (0, ra.numWindows - 1,
                                 (int) std::floor ((playhead - ra.clipStart) / ra.winLen));
    const int target = juce::jmin (cw + ra.lookahead, ra.numWindows - 1);
    int placed = 0;
    while (ra.active && ra.nextWindow <= target && ra.nextWindow < ra.numWindows)
    {
        const int k = ra.nextWindow;
        juce::String jobId; juce::File outFile, manifest;
        if (! renderAheadSubmitWindow (k, ra.epoch, jobId, outFile, manifest))
        { renderAheadDisarm(); return errResult ("render_ahead_tick", "window submit failed"); }
        for (int i = 0; i < 4800; ++i)                  // ~240s inline ceiling
        {
            auto st = jobManager.jobStatus (jobId);
            const auto status = st.getProperty ("status", var()).toString();
            if (status == "ready" || (outFile.existsAsFile() && manifest.existsAsFile())
                || status == "error" || status == "cancelled")
                break;
            juce::Thread::sleep (50);
        }
        if (! outFile.existsAsFile())
        { renderAheadDisarm(); return errResult ("render_ahead_tick", "window render failed"); }
        // Fail CLOSED on a stitch/repoint failure (found live: a /stitch_windows 404
        // silently no-op'd the whole lane while `placed` still reported success).
        if (! renderAheadWindowDone (k, ra.epoch, outFile))
        { renderAheadDisarm(); return errResult ("render_ahead_tick", "window stitch failed"); }
        ++placed;
    }
    auto* d = new DynamicObject();
    d->setProperty ("placed", placed);
    d->setProperty ("nextWindow", ra.nextWindow);
    d->setProperty ("total", ra.numWindows);
    return okResult ("render_ahead_tick", var (d));
}

juce::var MoshOps::cmdListColors (const juce::var&)
{
    // The SA3 colour rack (name + ASTD ceiling per color) for the generative UI.
    if (! jobManager.ensureServiceRunning())
        return errResult ("list_colors", "generative service unavailable");
    auto r = jobManager.listColors();
    if (! (bool) r.getProperty ("ok", false))
        return okResult ("list_colors", [] { auto* o = new DynamicObject(); o->setProperty ("colors", Array<var>{}); return var (o); }());
    return okResult ("list_colors", r);
}

juce::var MoshOps::cmdListLoras (const juce::var&)
{
    // The LoRA rack library (drop-in adapters + cards) for the generative UI.
    if (! jobManager.ensureServiceRunning())
        return errResult ("list_loras", "generative service unavailable");
    auto r = jobManager.listLoras();
    if (! (bool) r.getProperty ("ok", false))
        return okResult ("list_loras", [] { auto* o = new DynamicObject(); o->setProperty ("loras", Array<var>{}); return var (o); }());
    return okResult ("list_loras", r);
}

juce::var MoshOps::cmdListTransformTargets (const juce::var&)
{
    // Route B: the transform target list (instruments / models) for the generative UI.
    if (! jobManager.ensureServiceRunning())
        return errResult ("list_transform_targets", "generative service unavailable");
    auto r = jobManager.listTransformTargets();
    if (! (bool) r.getProperty ("ok", false))
        return okResult ("list_transform_targets", [] { auto* o = new DynamicObject();
            o->setProperty ("targets", Array<var>{}); o->setProperty ("freeText", true); return var (o); }());
    return okResult ("list_transform_targets", r);
}

// Non-gated: the RAVE model library dir (RAVE_MODEL_DIR, else ~/AI/rave-models). Used by the
// anira insert (raveModelPathFor) AND the always-available model browser (cmdListRaveModels) —
// listing is a filesystem scan and needs no anira, so the browser works in the default build too.
static juce::File raveModelDirFile()
{
    const auto dir = juce::SystemStats::getEnvironmentVariable ("RAVE_MODEL_DIR",
                         juce::File::getSpecialLocation (juce::File::userHomeDirectory)
                             .getChildFile ("AI").getChildFile ("rave-models").getFullPathName());
    return juce::File (dir);
}

#if MOSH_HAVE_ANIRA
// ─────────────────────────────────────────────────────────────────────────────
// Route C.2 — real-time RAVE insert (Tier-A; only built with anira+LibTorch)
// ─────────────────────────────────────────────────────────────────────────────
static juce::String raveModelPathFor (const juce::String& target)
{
    if (target.isEmpty()) return {};
    return raveModelDirFile().getChildFile (target + ".ts").getFullPathName();
}

juce::var MoshOps::cmdAddRaveInsert (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("add_rave_insert", "no track");

    beginTxn ("add_rave_insert");
    auto plugin = eng.edit().getPluginCache().createNewPlugin (RaveInsertPlugin::xmlTypeName, {});
    if (plugin == nullptr) return errResult ("add_rave_insert", "create failed");
    int index = (int) args.getProperty ("index", -1);
    if (index < 0) index = track->pluginList.getPlugins().size();
    track->pluginList.insertPlugin (plugin, index, nullptr);

    juce::String path = args.getProperty ("path", var()).toString();
    if (path.isEmpty()) path = raveModelPathFor (args.getProperty ("target", var()).toString());
    bool loaded = false;
    juce::String loadError;   // AL-022 — surfaced below when the best-effort load fails
    if (path.isNotEmpty())
        if (auto* r = asRave (plugin.get()))
        {
            loaded = r->loadModelFromFile (juce::File (path));
            if (! loaded) loadError = r->lastLoadError();
        }

    auto* data = new DynamicObject();
    data->setProperty ("index", track->pluginList.indexOf (plugin.get()));
    data->setProperty ("modelLoaded", loaded);
    if (! loaded && loadError.isNotEmpty()) data->setProperty ("lastError", loadError);
    logLine ("add_rave_insert", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("add_rave_insert", var (data));
}

juce::var MoshOps::cmdSetRaveParam (const juce::var& args)
{
    auto* r = asRave (findPlugin (args.getProperty ("trackId", var()).toString(),
                                  (int) args.getProperty ("index", -1)));
    if (r == nullptr) return errResult ("set_rave_param", "no rave insert");
    beginTxn ("set_rave_param");
    if (args.getProperty ("paramId", "mix").toString() == "mix")
        r->setMixUi ((float) (double) args.getProperty ("value", 100.0));   // 0–100 dry/wet
    logLine ("set_rave_param", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_rave_param");
}

juce::var MoshOps::cmdLoadRaveModel (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int idx = args.hasProperty ("pluginIndex") ? (int) args.getProperty ("pluginIndex", -1)
                                                     : (int) args.getProperty ("index", -1);
    auto* r = asRave (findPlugin (trackId, idx));
    if (r == nullptr) return errResult ("load_rave_model", "no rave insert");
    juce::String path = args.getProperty ("path", var()).toString();
    if (path.isEmpty()) path = raveModelPathFor (args.getProperty ("target", var()).toString());
    if (path.isEmpty()) return errResult ("load_rave_model", "path or target required");
    if (! juce::File (path).existsAsFile()) return errResult ("load_rave_model", "model file not found: " + path);
    const bool ok = r->loadModelFromFile (juce::File (path));
    logLine ("load_rave_model", args, ok, ok ? juce::String() : juce::String ("load failed"), false);
    emitSnapshotInvalidated();
    if (! ok)
    {
        // AL-022 — append the engine's diagnostic (exception message / failure
        // reason) to the error, when one was captured. Additive: the base
        // message is unchanged when there is no diagnostic to add.
        const auto detail = r->lastLoadError();
        return errResult ("load_rave_model", "could not load model: " + path
            + (detail.isNotEmpty() ? (" (" + detail + ")") : juce::String()));
    }
    auto* data = new DynamicObject();
    data->setProperty ("applied", true);
    data->setProperty ("describe", r->describe());
    return okResult ("load_rave_model", var (data));
}

juce::var MoshOps::cmdResetRave (const juce::var& args)
{
    auto* r = asRave (findPlugin (args.getProperty ("trackId", var()).toString(),
                                  (int) args.getProperty ("index", -1)));
    if (r == nullptr) return errResult ("reset_rave", "no rave insert");
    r->resetModel();
    logLine ("reset_rave", args, true, {}, false);
    return okResult ("reset_rave");
}
#endif // MOSH_HAVE_ANIRA

juce::var MoshOps::cmdListRaveModels (const juce::var&)
{
    // Lane B — browse the RAVE model library (RAVE_MODEL_DIR / ~/AI/rave-models). A pure filesystem
    // scan of *.ts, so it works in the DEFAULT build too (loading is still gated on
    // session.raveAvailable — only the anira build hosts the live insert). Mirrors the LoRA rack:
    // the UI card offers a dropdown instead of a raw path prompt. Sorted by name (std::map) for a
    // stable list; non-mutating, non-undoable.
    std::map<juce::String, int> found;   // name → sizeMB (auto-sorted by key)
    auto dir = raveModelDirFile();
    const bool available = dir.isDirectory();
    if (available)
        for (auto& f : dir.findChildFiles (juce::File::findFiles, false, "*.ts"))
            found[f.getFileNameWithoutExtension()] = juce::roundToInt (f.getSize() / (1024.0 * 1024.0));

    Array<var> models;
    for (auto& [name, sizeMB] : found)
    {
        auto* o = new DynamicObject();
        o->setProperty ("name", name);
        o->setProperty ("sizeMB", sizeMB);
        models.add (var (o));
    }
    auto* d = new DynamicObject();
    d->setProperty ("models", models);
    d->setProperty ("dir", dir.getFullPathName());
    d->setProperty ("available", available);
    return okResult ("list_rave_models", var (d));
}

juce::var MoshOps::cmdCancelRender (const juce::var& args)
{
    jobManager.cancelJob (args.getProperty ("jobId", var()).toString());
    if (auto node = findRenderLayer (args.getProperty ("clipId", var()).toString()); node.isValid())
        node.setProperty (ids::status, "dirty", nullptr);
    logLine ("cancel_render", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("cancel_render");
}

juce::var MoshOps::cmdAcceptRender (const juce::var& args)
{
    eng.saveIfDirty();   // A2 — pre-risky-op save (commits a generative render into the arrangement)
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (clipId);
    auto node = findRenderLayer (clipId);
    if (clip == nullptr || ! node.isValid()) return errResult ("accept_render", "no render layer");
    if (dynamic_cast<te::WaveAudioClip*> (clip) != nullptr && (bool) node[ids::appliedInPlace])
    {
        // Whole-clip wave renders AUTO-APPLY in place (no lane, no accept step). accept is a
        // no-op for them — Reset restores the original. (Sub-region wave renders are NOT
        // applied in place and still land via the lane path below.)
        logLine ("accept_render", args, true, {}, false);
        return okResult ("accept_render");
    }
    if (dynamic_cast<te::WaveAudioClip*> (clip) == nullptr && (bool) node[kSourceMutedByLayer])
    {
        // Phase 2 — MIDI/drum auto-applies beneath the muted source. accept is a no-op (the hidden
        // audio is already what plays); Reset un-mutes the MIDI and removes the hidden clip.
        logLine ("accept_render", args, true, {}, false);
        return okResult ("accept_render");
    }
    // Resolve move-aware (AL-009): a Save-As'd project stores cacheArtifact relative.
    juce::File artifact = mosh::resolveCacheArtifact (node, eng.editFile().getParentDirectory());
    if (! artifact.existsAsFile()) return errResult ("accept_render", "nothing rendered to accept");

    // Copy the render artifact into the project audio dir BEFORE any edit mutation.
    // copyFileTo does not create parent dirs and can fail (disk full, perms); doing
    // it up front and checking the result means a failed copy is a clean error
    // rather than a clip pointing at a missing/partial file landing in the saved
    // project. (createAudioTrack below is an undoable mutation, so we must not reach
    // it on a copy failure.)
    auto dest = eng.sessionDir().getChildFile ("audio")
                    .getChildFile (node[ids::id].toString()).withFileExtension ("wav");
    dest.getParentDirectory().createDirectory();
    dest.deleteFile();
    if (! artifact.copyFileTo (dest))
        return errResult ("accept_render", "failed to copy render artifact");

    // Landing: new clip on a dedicated "neural" lane (the documented guaranteed
    // fallback, 05 §3.1 — ships as a user-selectable mode, not a defeat).
    beginTxn ("accept_render");
    auto& edit = eng.edit();
    te::AudioTrack* lane = nullptr;
    for (auto* t : te::getAudioTracks (edit))
        if (t != nullptr && t->getName() == "Neural Renders") lane = t;
    if (lane == nullptr)
    {
        lane = createAudioTrack ("Neural Renders");
    }
    if (lane == nullptr) return errResult ("accept_render", "no lane");

    // Land the render. Anchor to the clip's LIVE position; only when the layer carries a
    // genuine sub-region (tighter than the current clip span) do we land that sub-range.
    // The stored timeRange is frozen at create, so clamp it to the live clip — a clip
    // moved/trimmed since render lands over its current self, not a stale spot.
    auto pos = clip->getPosition();
    const double cs = pos.getStart().inSeconds(), ce = pos.getEnd().inSeconds();
    auto landStart = pos.getStart();
    auto landLen   = pos.getLength();
    {
        const double rs = juce::jlimit (cs, ce, (double) node[ids::timeRangeStart]);
        const double re = juce::jlimit (cs, ce, (double) node[ids::timeRangeEnd]);
        if (re > rs + 1.0e-3 && (re - rs) < (ce - cs) - 1.0e-3)   // genuine sub-region of the live clip
        {
            landStart = tracktion::TimePosition::fromSeconds (rs);
            landLen   = tracktion::TimeDuration::fromSeconds (re - rs);
        }
    }
    auto landed = lane->insertWaveClip ("neural-" + clip->getName(), dest,
        { { landStart, landLen }, {} }, false);

    node.setProperty (ids::userKept, true, &undoManager());
    node.setProperty (ids::status, "ready", &undoManager());
    // Record the landed neural clip so bypass_layer can re-route real audio (AL-008):
    // bypassing mutes THIS clip → the mix falls back to the original (pre-render) source.
    // A re-accept after bypass must start un-bypassed, so the new landed clip plays.
    if (landed != nullptr)
        node.setProperty (kLandedClipId, landed->itemID.toString(), &undoManager());

    // JSONL TASTE LABEL (05 §9): accept feeds the taste flywheel.
    auto* tl = new DynamicObject();
    tl->setProperty ("clipId", clipId); tl->setProperty ("layerId", node[ids::id]);
    tl->setProperty ("landing", "new_clip");
    logLine ("accept_render", var (tl), true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("accept_render");
}

juce::var MoshOps::cmdRejectRender (const juce::var& args)
{
    auto node = findRenderLayer (args.getProperty ("clipId", var()).toString());
    if (! node.isValid()) return errResult ("reject_render", "no render layer");
    beginTxn ("reject_render");
    node.setProperty (ids::userKept, false, &undoManager());
    node.setProperty (ids::status, "dirty", &undoManager());
    logLine ("reject_render", args, true, {}, true);   // TASTE LABEL (reject)
    emitSnapshotInvalidated();
    return okResult ("reject_render");
}

juce::var MoshOps::cmdBypassLayer (const juce::var& args)
{
    auto node = findRenderLayer (args.getProperty ("clipId", var()).toString());
    if (! node.isValid()) return errResult ("bypass_layer", "no render layer");
    const bool bypassed = (bool) args.getProperty ("bypassed", false);
    const auto bypClipId = args.getProperty ("clipId", var()).toString();
    beginTxn ("bypass_layer");
    node.setProperty (ids::status, bypassed ? "bypassed" : "ready", &undoManager());

    // Wave clips apply in place → bypass is an A/B: swap the source to the ORIGINAL when
    // bypassed, back to the render artifact when enabled. (Non-wave clips use the landed-clip
    // mute below.) The swap is the same regenerable-preview op as apply/reset.
    if (auto* wave = dynamic_cast<te::WaveAudioClip*> (findClip (bypClipId)))
    {
        if (const auto origRef = node[ids::originalSourceRef].toString(); origRef.isNotEmpty())
        {
            const auto art = mosh::resolveCacheArtifact (node, eng.editFile().getParentDirectory()).getFullPathName();
            const juce::String origAbs = juce::File::isAbsolutePath (origRef) ? origRef
                : eng.editFile().getParentDirectory().getChildFile (origRef).getFullPathName();
            const juce::String tgt = bypassed ? origAbs : art;
            if (juce::File tf (tgt); tf.existsAsFile())
            {
                const bool local = tf.isAChildOf (eng.editFile().getParentDirectory());
                mosh::repointWaveClipSource (*wave, tf, eng.editFile().getParentDirectory(), local);
            }
        }
    }

    // Phase 2 — for the MIDI/drum beneath-model, bypass routes back to the LIVE instrument: un-mute
    // the source MIDI when bypassed, re-mute it when enabled. (The landed-clip mute below mutes the
    // hidden audio inversely, so exactly one of the two sounds at a time.)
    if ((bool) node[kSourceMutedByLayer])
        if (auto* src = findClip (bypClipId))
            src->setMuted (! bypassed);

    // AL-008 — re-route REAL audio, not just the status flag: mute the landed neural / hidden
    // clip when bypassed so the mix falls back to the original (pre-render) source, and
    // un-mute it when re-enabled. Only meaningful once the layer was accepted / auto-applied (it
    // has a landed clip); a bypass before that is a pure status toggle (nothing to route).
    if (auto landedId = node[kLandedClipId].toString(); landedId.isNotEmpty())
        if (auto* landedClip = findClip (landedId))
            landedClip->setMuted (bypassed);

    logLine ("bypass_layer", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("bypass_layer");
}

juce::var MoshOps::cmdFreezeLayer (const juce::var& args)
{
    eng.saveIfDirty();   // A2 — pre-risky-op save (commits the cached render as durable audio)
    // Freeze = commit the cached render as the durable audio (already a file).
    auto node = findRenderLayer (args.getProperty ("clipId", var()).toString());
    if (! node.isValid()) return errResult ("freeze_layer", "no render layer");
    // Resolve move-aware (AL-009): a Save-As'd project stores cacheArtifact relative.
    if (! mosh::resolveCacheArtifact (node, eng.editFile().getParentDirectory()).existsAsFile())
        return errResult ("freeze_layer", "nothing rendered to freeze");
    beginTxn ("freeze_layer");
    node.setProperty (ids::status, "frozen", &undoManager());
    logLine ("freeze_layer", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("freeze_layer");
}

juce::var MoshOps::cmdBounceLayerToClip (const juce::var& args)
{
    eng.saveIfDirty();   // A2 — pre-risky-op save (bounce commits the render to a clip)
    // Bounce = accept_render then mark the layer bounced (the render becomes a
    // plain clip on the neural lane; lineage stays in the RenderLayer link).
    auto r = cmdAcceptRender (args);
    if (! (bool) r.getProperty ("ok", false)) return r;
    if (auto node = findRenderLayer (args.getProperty ("clipId", var()).toString()); node.isValid())
        node.setProperty (ids::status, "bounced", nullptr);
    logLine ("bounce_layer_to_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("bounce_layer_to_clip");
}

juce::var MoshOps::cmdRemoveRenderLayer (const juce::var& args)
{
    // Clear the MOSH_RENDERLAYER node off the clip (the genuine "remove" — reject_render
    // only marks the take dirty, it does NOT remove the layer). After this the clip has
    // no layer and create_render_layer succeeds again. Undoable (mirrors remove_plugin);
    // any accepted/bounced clip already landed on the neural lane is left untouched.
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (clipId);
    if (clip == nullptr) return errResult ("remove_render_layer", "no clip: " + clipId);
    auto node = clip->state.getChildWithName (ids::MOSH_RENDERLAYER);
    if (! node.isValid()) return errResult ("remove_render_layer", "clip has no render layer");

    beginTxn ("remove_render_layer");
    // Phase 2 — a MIDI/drum beneath-render owns a HIDDEN audio clip + a MUTED source. Tear them down
    // so removing the layer doesn't strand a hidden clip or leave the MIDI silently muted.
    if ((bool) node[kSourceMutedByLayer])
    {
        if (auto hiddenId = node[kLandedClipId].toString(); hiddenId.isNotEmpty())
            if (auto* hidden = findClip (hiddenId); hidden != nullptr && hidden != clip)
                hidden->removeFromParent();
        clip->setMuted (false);
    }
    clip->state.removeChild (node, &undoManager());
    logLine ("remove_render_layer", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_render_layer");
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 6 — export (the full producer loop ends here)
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdExportAudio (const juce::var& args)
{
    auto& edit = eng.edit();

    // ── Format / extension resolution ────────────────────────────────────────
    // The UI speaks generic media-format names ("wav"/"aiff"/"flac"), never engine
    // type names. Resolve them through the Engine's AudioFileFormatManager (the
    // robust path: per-format getters + getFormatFromFileName), and FALL BACK to
    // the default WAV format on anything unknown. An explicitly-requested-but-
    // unsupported format is a hard error (caught before any render).
    auto& afm = edit.engine.getAudioFileFormatManager();

    const auto requestedFormat = args.getProperty ("format", var()).toString().trim().toLowerCase();

    // Map a format keyword -> (juce::AudioFormat*, canonical extension). Empty
    // keyword means "infer from the destination file extension" below.
    struct FormatChoice { juce::AudioFormat* format = nullptr; juce::String extension; };
    auto formatForKeyword = [&afm] (const juce::String& kw) -> FormatChoice
    {
        if (kw == "wav")  return { afm.getWavFormat(),  ".wav" };
        if (kw == "aiff" || kw == "aif") return { afm.getAiffFormat(), ".aiff" };
        if (kw == "flac") return { afm.getFlacFormat(), ".flac" };
        return {};
    };

    if (requestedFormat.isNotEmpty() && formatForKeyword (requestedFormat).format == nullptr)
        return errResult ("export_audio", "unsupported format: " + requestedFormat
                          + " (supported: wav, aiff, flac)");

    auto file = args.getProperty ("file", var()).toString().isNotEmpty()
                    ? juce::File (args.getProperty ("file", var()).toString())
                    : eng.sessionDir().getChildFile ("exports")
                          .getChildFile ("mix-" + String (Time::getCurrentTime().toMilliseconds()))
                          .withFileExtension ("wav");

    // Choose the format: explicit keyword wins; otherwise infer from the file
    // extension; otherwise the default WAV. Then force the destination extension
    // to match the chosen format so the bytes and the name agree.
    juce::AudioFormat* audioFormat = nullptr;
    juce::String formatName = "wav";
    if (requestedFormat.isNotEmpty())
    {
        auto choice = formatForKeyword (requestedFormat);
        audioFormat = choice.format;
        formatName = requestedFormat == "aif" ? "aiff" : requestedFormat;
        file = file.withFileExtension (choice.extension);
    }
    else
    {
        const auto ext = file.getFileExtension().toLowerCase();
        if (ext == ".wav")       { audioFormat = afm.getWavFormat();  formatName = "wav"; }
        else if (ext == ".aiff" || ext == ".aif") { audioFormat = afm.getAiffFormat(); formatName = "aiff"; file = file.withFileExtension (".aiff"); }
        else if (ext == ".flac") { audioFormat = afm.getFlacFormat(); formatName = "flac"; }
        else if (ext == ".mid")  { audioFormat = afm.getDefaultFormat(); formatName = "mid"; }
        else { audioFormat = afm.getDefaultFormat(); formatName = "wav"; file = file.withFileExtension (".wav"); }
    }
    if (audioFormat == nullptr)   // belt-and-braces: never render with a null format
        audioFormat = afm.getDefaultFormat();

    file.getParentDirectory().createDirectory();
    file.deleteFile();

    // ── Bit depth ────────────────────────────────────────────────────────────
    // Validate the requested depth against what this format can actually write
    // (getPossibleBitDepths). Reject an unsupported depth rather than silently
    // writing the wrong one. Absent -> 24 (or the format's nearest supported).
    // PRJ-008 — when the export omits bitDepth, default it from the stored per-project
    // setting (NON-mutating read; an invalid/absent tree's hasProperty() is false ->
    // the 24-bit / device-rate defaults below).
    auto projectSettings = eng.edit().state.getChildWithName (ids::MOSH_PROJECT);
    int bitDepth = projectSettings.hasProperty (ids::projectBitDepth)
                       ? (int) projectSettings.getProperty (ids::projectBitDepth)
                       : 24;
    {
        auto depths = audioFormat->getPossibleBitDepths();   // local copy of the Array<int>
        const bool depthRequested = args.hasProperty ("bitDepth");
        if (depthRequested)
        {
            bitDepth = (int) args.getProperty ("bitDepth", 24);
            if (! depths.contains (bitDepth))
            {
                juce::StringArray supported;
                for (auto d : depths) supported.add (String (d));
                return errResult ("export_audio", "format " + formatName + " does not support bit depth "
                                  + String (bitDepth) + " (supported: " + supported.joinIntoString (", ") + ")");
            }
        }
        else if (! depths.isEmpty() && ! depths.contains (bitDepth))
        {
            // Nearest supported to the 24-bit default.
            int best = depths[0];
            for (auto d : depths) if (std::abs (d - 24) < std::abs (best - 24)) best = d;
            bitDepth = best;
        }
    }

    const auto requestedMode = args.getProperty ("renderMode", "auto").toString().toLowerCase();
    if (requestedMode != "auto" && requestedMode != "fast" && requestedMode != "realtime")
        return errResult ("export_audio", "renderMode must be 'auto', 'fast', or 'realtime'");

    String renderMode = requestedMode;
    String renderModeReason;
    if (requestedMode == "auto")
    {
        renderModeReason = findSerumRealtimeRenderReason (edit);
        renderMode = renderModeReason.isNotEmpty() ? "realtime" : "fast";
        if (renderModeReason.isEmpty())
            renderModeReason = "no realtime-only hosted plugin detected";
    }
    else if (requestedMode == "realtime")
    {
        renderModeReason = "requested realtime render";
    }
    else
    {
        renderModeReason = "requested fast render";
    }

    // ── Export range (invariant 78) + delay-tail policy (invariant 81) ──────────
    // Resolved + validated BEFORE the device teardown below so a bad range/tail arg
    // returns an error without a needless freePlaybackContext(). getLoopRange() reads
    // transport CachedValue state and is context-independent either way. The actual
    // resolution/validation math is pure + engine-free (mosh::resolveExportRange,
    // src/moshops/ExportRange.h) so it's unit-testable without a live MoshEngine —
    // see tests/test_export_range.cpp.
    const auto loopRange = edit.getTransport().getLoopRange();
    const auto rangeRes = resolveExportRange (
        edit.getLength().inSeconds(),
        loopRange.getStart().inSeconds(), loopRange.getEnd().inSeconds(),
        args.hasProperty ("range"), args.getProperty ("range", var()).toString(),
        args.hasProperty ("start"), (double) args.getProperty ("start", 0.0),
        args.hasProperty ("end"),   (double) args.getProperty ("end", 0.0),
        args.hasProperty ("tail"),  args.getProperty ("tail", var()).toString(),
        args.hasProperty ("tailSeconds"), (double) args.getProperty ("tailSeconds", 2.0));
    if (! rangeRes.ok)
        return errResult ("export_audio", rangeRes.error);
    const double rStart = rangeRes.rangeStart, rEnd = rangeRes.rangeEnd;
    const juce::String rangeKind = rangeRes.rangeKind, tailKind = rangeRes.tailKind;
    const double tailSeconds = rangeRes.tailSeconds;

    // Render exclusivity (01 §5): detach the Edit from the device before an
    // offline/realtime export render (asserts otherwise). No-op when no device
    // is attached. Tear down our level-meter taps first (the master tap lives on
    // the playback context we are about to free) and clear lastSeenContext so the
    // master meter re-attaches to the *next* context rather than an ABA-reused
    // address — same swap guard cmdNewProject/cmdOpenProject use.
    unregisterAllMeterClients();           // master tap follows the context being freed
    edit.getTransport().stop (false, false);
    edit.getTransport().freePlaybackContext();
    lastSeenContext = nullptr;             // old ctx freed; force master-meter re-attach to the next ctx

    const double len = juce::jmax (0.1, rEnd - rStart);

    // Sample rate: honor a valid explicit request (>= 7000), else the stored
    // per-project setting (PRJ-008), else the device rate with the 44100 fallback.
    double sampleRate = edit.engine.getDeviceManager().getSampleRate();
    if (sampleRate < 7000.0)
        sampleRate = 44100.0;
    if (! args.hasProperty ("sampleRate") && projectSettings.hasProperty (ids::projectSampleRate))
    {
        const double projSr = (double) projectSettings.getProperty (ids::projectSampleRate);
        if (projSr >= 7000.0)
            sampleRate = projSr;
    }
    if (args.hasProperty ("sampleRate"))
    {
        const double reqSr = (double) args.getProperty ("sampleRate", sampleRate);
        if (reqSr >= 7000.0)
            sampleRate = reqSr;
    }

    te::Renderer::Parameters params (edit);
    params.destFile = file;
    params.audioFormat = audioFormat;
    params.bitDepth = bitDepth;
    params.sampleRateForAudio = sampleRate;
    params.blockSizeForAudio = edit.engine.getDeviceManager().getBlockSize();
    if (params.blockSizeForAudio <= 0)
        params.blockSizeForAudio = 512;
    params.time = { tracktion::TimePosition::fromSeconds (rStart),
                     tracktion::TimePosition::fromSeconds (rEnd) };
    params.endAllowance = tracktion::TimeDuration::fromSeconds (tailSeconds);
    params.tracksToDo = te::toBitSet (te::getAllTracks (edit));
    params.usePlugins = true;
    params.useMasterPlugins = true;
    params.createMidiFile = file.hasFileExtension (".mid");
    params.realTimeRender = renderMode == "realtime";

    String renderError;
    {
        const te::Edit::ScopedRenderStatus srs (edit, true);
        te::TransportControl::stopAllTransports (edit.engine, false, true);
        te::Renderer::turnOffAllPlugins (edit);

        if (params.tracksToDo.countNumberOfSetBits() > 0
            && params.destFile.hasWriteAccess()
            && ! params.destFile.isDirectory())
        {
            te::Renderer::RenderTask task ("Mosh export", params, nullptr, nullptr);

            // Defense-in-depth: bound the render loop. runJob() returns jobNeedsRunningAgain
            // once per block; if a leaf node can NEVER become ready (e.g. a clip whose source
            // file can't be opened), progress stalls and this loop would otherwise spin
            // forever. A no-progress watchdog + an absolute deadline (scaled to the edit
            // length to allow legitimate realtime renders) turn any such stall into a clean
            // error instead of an app hang.
            const double renderSpan   = (rEnd - rStart) + tailSeconds;   // actual rendered span, not the whole edit
            const juce::uint32 startMs    = juce::Time::getMillisecondCounter();
            const juce::uint32 deadlineMs = (juce::uint32) juce::jmax (60000.0, renderSpan * 8000.0 + 60000.0);
            const juce::uint32 stallMs    = 20000;   // abort if progress doesn't advance for 20s
            float  lastProgress   = -1.0f;
            juce::uint32 lastProgressMs = startMs;

            while (task.runJob() == juce::ThreadPoolJob::jobNeedsRunningAgain)
            {
                const juce::uint32 nowMs = juce::Time::getMillisecondCounter();
                const float p = task.getCurrentTaskProgress();
                if (p > lastProgress) { lastProgress = p; lastProgressMs = nowMs; }

                if (nowMs - lastProgressMs > stallMs || nowMs - startMs > deadlineMs)
                {
                    if (task.errorMessage.isEmpty())
                        task.errorMessage = "export render stalled (a clip's audio source could not be read)";
                    break;
                }
            }

            te::Renderer::turnOffAllPlugins (edit);

            if (task.errorMessage.isNotEmpty())
            {
                renderError = task.errorMessage;
                file.deleteFile();
            }
        }
        else
        {
            renderError = "render target is not writable or no tracks are renderable";
        }
    }

    const bool ok = renderError.isEmpty() && file.existsAsFile() && file.getSize() > 0;

    logLine ("export_audio", args, ok, ok ? String() : (renderError.isNotEmpty() ? renderError : String ("render produced no file")), false);
    if (! ok) return errResult ("export_audio", renderError.isNotEmpty() ? renderError : String ("export render failed"));

    auto* data = new DynamicObject();
    data->setProperty ("file", file.getFullPathName());
    data->setProperty ("format", formatName);
    if (formatName != "mid")   // bit depth / sample rate are meaningless for a MIDI export
    {
        data->setProperty ("bitDepth", bitDepth);
        data->setProperty ("sampleRate", sampleRate);
    }
    data->setProperty ("bytes", (juce::int64) file.getSize());
    data->setProperty ("seconds", len);
    data->setProperty ("range", rangeKind);
    data->setProperty ("rangeStart", rStart);
    data->setProperty ("rangeEnd", rEnd);
    data->setProperty ("tail", tailKind);
    data->setProperty ("endAllowance", tailSeconds);
    data->setProperty ("renderModeRequested", requestedMode);
    data->setProperty ("renderMode", renderMode);
    data->setProperty ("renderModeReason", renderModeReason);
    data->setProperty ("realTimeRender", params.realTimeRender);
    return okResult ("export_audio", var (data));
}

bool MoshOps::writeSilentStemFile (const juce::File& dest, juce::AudioFormat* format, int bitDepth,
                                   double sampleRate, double lengthSeconds)
{
    if (format == nullptr) return false;
    dest.deleteFile();
    std::unique_ptr<juce::FileOutputStream> os (dest.createOutputStream());
    if (os == nullptr) return false;

    const int numChannels = 2;   // stereo, matching the rest of the stem set
    std::unique_ptr<juce::AudioFormatWriter> writer (
        format->createWriterFor (os.get(), sampleRate, (unsigned) numChannels, bitDepth, {}, 0));
    if (writer == nullptr) return false;
    os.release();   // the writer owns the stream now

    const int numSamples = juce::jmax (1, (int) std::ceil (lengthSeconds * sampleRate));
    juce::AudioBuffer<float> silence (numChannels, numSamples);
    silence.clear();
    const bool wrote = writer->writeFromAudioSampleBuffer (silence, 0, numSamples);
    writer.reset();   // flush + close before the caller reads the file back
    return wrote;
}

// ─────────────────────────────────────────────────────────────────────────────
// G7 — cmdExportStems: one WAV/AIFF/FLAC per visible, non-empty audio track, ALL
// sharing the same {0, editLength} render window (the "common zero point" — a
// track whose clips start at bar 8 yields a stem with 8 bars of leading silence,
// so every stem is the same length and re-imports aligned). Mirrors
// cmdExportAudio's format/bit-depth/sample-rate resolution (deliberately kept
// self-contained rather than sharing a helper — see the spec §2 "shared-helper
// refactor (recommended)" note; duplication is the smaller, lower-risk diff and
// the golden/verify gate catches any drift) and reuses bounceClipToWav's
// single-track render primitive in a loop instead of a single all-tracks render.
// NON-undoable (read/render, no ValueTree mutation the undo system needs to
// know about) — same posture as export_audio.
//
// ── CORRECTNESS FIX (found by adversarial review, empirically reproduced): the
// original version of this command set ONLY `params.tracksToDo = te::toBitSet(one)`
// to try to isolate the single target track, per the spec's "NO allowedClips —
// we render the whole track" design. That design was built on a false premise:
// `te::toBitSet()` in the PINNED tracktion_engine clone (2877b621,
// modules/tracktion_engine/model/edit/tracktion_EditUtilities.cpp:179-193) does
// NOT restrict the bitset to the tracks passed in — it's an upstream bug. Its body
// loops `t` over `getAllTracks(edit)` and sets the bit whenever
// `allTracks.indexOf(t) >= 0`, which is trivially true for every t (t is drawn
// FROM allTracks), so it unconditionally sets every track's bit regardless of the
// `tracks` array argument. `params.tracksToDo` therefore evaluated to "every
// track in the edit" no matter which single track was passed in, and
// `cnp.allowedTracks` (tracktion_Renderer.cpp:38/140) ended up permitting ALL
// tracks — so every "stem" actually rendered the full mix. Verified by reading
// the upstream source (see the exact lines above); `bounceClipToWav` (:6867)
// never hit this because it ALSO sets `params.allowedClips` to the one clip it
// wants, and `allowedClips` is filtered independently, per-clip, in
// EditNodeBuilder.cpp regardless of tracksToDo/allowedTracks — so its bug was
// silently masked. The fix: populate `params.allowedClips` with every clip that
// belongs to the target track (not just one), which genuinely isolates it the
// same proven way bounceClipToWav does. `tracksToDo` is left set (harmless —
// it's not load-bearing for isolation) only because the render-gate check below
// reads `tracksToDo.countNumberOfSetBits() > 0`.
//
// One wrinkle: `allowedClips` can't express "zero clips" — an EMPTY array means
// "no filter" (ALL clips), not "no clips." So a genuinely clip-less track
// (`includeEmpty:true`) is written directly as silence via writeSilentStemFile,
// bypassing te::Renderer for that one stem.
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdExportStems (const juce::var& args)
{
    auto& edit = eng.edit();

    // ── Format / extension resolution (trimmed-down cmdExportAudio copy — stems
    // take a destination "dir", not a per-file "file", so there is no extension-
    // inference-from-filename branch to mirror). ───────────────────────────────
    auto& afm = edit.engine.getAudioFileFormatManager();
    const auto requestedFormat = args.getProperty ("format", var()).toString().trim().toLowerCase();

    struct FormatChoice { juce::AudioFormat* format = nullptr; juce::String extension; };
    auto formatForKeyword = [&afm] (const juce::String& kw) -> FormatChoice
    {
        if (kw == "wav")  return { afm.getWavFormat(),  ".wav" };
        if (kw == "aiff" || kw == "aif") return { afm.getAiffFormat(), ".aiff" };
        if (kw == "flac") return { afm.getFlacFormat(), ".flac" };
        return {};
    };

    juce::AudioFormat* audioFormat = afm.getWavFormat();
    juce::String formatName = "wav";
    juce::String extension = ".wav";
    if (requestedFormat.isNotEmpty())
    {
        auto choice = formatForKeyword (requestedFormat);
        if (choice.format == nullptr)
            return errResult ("export_stems", "unsupported format: " + requestedFormat
                              + " (supported: wav, aiff, flac)");
        audioFormat = choice.format;
        formatName  = requestedFormat == "aif" ? "aiff" : requestedFormat;
        extension   = choice.extension;
    }
    if (audioFormat == nullptr)   // belt-and-braces: never render with a null format
        audioFormat = afm.getDefaultFormat();

    // ── Bit depth — PRJ-008: default from the stored per-project setting, same
    // precedence as cmdExportAudio. ─────────────────────────────────────────────
    auto projectSettings = edit.state.getChildWithName (ids::MOSH_PROJECT);
    int bitDepth = projectSettings.hasProperty (ids::projectBitDepth)
                       ? (int) projectSettings.getProperty (ids::projectBitDepth)
                       : 24;
    {
        auto depths = audioFormat->getPossibleBitDepths();
        if (args.hasProperty ("bitDepth"))
        {
            bitDepth = (int) args.getProperty ("bitDepth", 24);
            if (! depths.contains (bitDepth))
            {
                juce::StringArray supported;
                for (auto d : depths) supported.add (String (d));
                return errResult ("export_stems", "format " + formatName + " does not support bit depth "
                                  + String (bitDepth) + " (supported: " + supported.joinIntoString (", ") + ")");
            }
        }
        else if (! depths.isEmpty() && ! depths.contains (bitDepth))
        {
            int best = depths[0];
            for (auto d : depths) if (std::abs (d - 24) < std::abs (best - 24)) best = d;
            bitDepth = best;
        }
    }

    // ── Sample rate — same PRJ-008 precedence as cmdExportAudio. ────────────────
    double sampleRate = edit.engine.getDeviceManager().getSampleRate();
    if (sampleRate < 7000.0)
        sampleRate = 44100.0;
    if (! args.hasProperty ("sampleRate") && projectSettings.hasProperty (ids::projectSampleRate))
    {
        const double projSr = (double) projectSettings.getProperty (ids::projectSampleRate);
        if (projSr >= 7000.0)
            sampleRate = projSr;
    }
    if (args.hasProperty ("sampleRate"))
    {
        const double reqSr = (double) args.getProperty ("sampleRate", sampleRate);
        if (reqSr >= 7000.0)
            sampleRate = reqSr;
    }

    const auto requestedMode = args.getProperty ("renderMode", "auto").toString().toLowerCase();
    if (requestedMode != "auto" && requestedMode != "fast" && requestedMode != "realtime")
        return errResult ("export_stems", "renderMode must be 'auto', 'fast', or 'realtime'");

    // Destination directory: explicit `dir` arg, else sessionDir/exports/stems-<ms>.
    juce::File dir = args.getProperty ("dir", var()).toString().isNotEmpty()
        ? juce::File (args.getProperty ("dir", var()).toString())
        : eng.sessionDir().getChildFile ("exports")
              .getChildFile ("stems-" + String (Time::getCurrentTime().toMilliseconds()));
    dir.createDirectory();

    const bool includeEmpty = (bool) args.getProperty ("includeEmpty", false);

    // Render exclusivity (01 §5), done ONCE for the whole stem set — mirrors
    // cmdExportAudio's teardown so the master meter re-attaches to the NEXT context.
    unregisterAllMeterClients();
    edit.getTransport().stop (false, false);
    edit.getTransport().freePlaybackContext();
    lastSeenContext = nullptr;

    // Edit-wide render mode: one realtime-only hosted synth (e.g. Serum) anywhere in
    // the edit forces ALL stems to render realtime — a safe superset, computed once
    // rather than per-track (mirrors cmdExportAudio's "auto" resolution).
    const bool realtime = requestedMode == "realtime"
                          || (requestedMode == "auto" && findSerumRealtimeRenderReason (edit).isNotEmpty());

    const double len = juce::jmax (0.1, edit.getLength().inSeconds());
    int blockSize = edit.engine.getDeviceManager().getBlockSize();
    if (blockSize <= 0) blockSize = 512;

    juce::Array<var> stems;
    juce::String firstError;
    int index = 0;   // matches snapshot()'s track index (te::getAudioTracks, moshHidden filtered)

    for (auto* t : te::getAudioTracks (edit))
    {
        if (t == nullptr) continue;
        if ((bool) t->state.getProperty (ids::moshHidden, false)) continue;   // Phase-2 hidden beneath-render track — never a stem
        const int myIndex = index++;
        const juce::Array<te::Clip*> trackClips = t->getClips();             // THIS track's own clips (may be empty)
        if (! includeEmpty && trackClips.isEmpty()) continue;                // skip silent tracks by default

        auto file = dir.getChildFile (stemFileBaseName (myIndex, t->getName())).withFileExtension (extension);
        file.deleteFile();

        juce::String renderError;

        if (trackClips.isEmpty())
        {
            // includeEmpty:true on a genuinely clip-less track — allowedClips can't express
            // "zero clips" (see the comment above this function), so write silence directly
            // at the common-zero-point length instead of going through te::Renderer.
            if (! writeSilentStemFile (file, audioFormat, bitDepth, sampleRate, len))
                renderError = "could not write a silent stem file";
        }
        else
        {
            te::Renderer::Parameters params (edit);
            params.destFile           = file;
            params.audioFormat        = audioFormat;
            params.bitDepth           = bitDepth;
            params.sampleRateForAudio = sampleRate;
            params.blockSizeForAudio  = blockSize;
            params.time               = { tracktion::TimePosition(), edit.getLength() };   // COMMON zero point — every stem shares this window
            juce::Array<te::Track*> one; one.add (t);
            params.tracksToDo         = te::toBitSet (one);   // kept for the countNumberOfSetBits() gate below; NOT load-bearing for isolation (see the comment above cmdExportStems)
            params.allowedClips.addArray (trackClips);        // ← the ACTUAL per-track isolation mechanism
            params.usePlugins         = true;                 // instrument + insert FX = the track's own post-fader sound
            params.useMasterPlugins   = false;                // pre-master — sum of stems + master chain reproduces the mix
            params.createMidiFile     = false;
            params.realTimeRender     = realtime;

            const te::Edit::ScopedRenderStatus srs (edit, true);
            te::TransportControl::stopAllTransports (edit.engine, false, true);
            te::Renderer::turnOffAllPlugins (edit);

            if (params.tracksToDo.countNumberOfSetBits() > 0
                && params.destFile.hasWriteAccess()
                && ! params.destFile.isDirectory())
            {
                te::Renderer::RenderTask task ("Mosh stem export", params, nullptr, nullptr);

                // Same no-progress watchdog + absolute deadline as cmdExportAudio /
                // bounceClipToWav, so ONE bad track's stalled render (e.g. an unreadable
                // source) errors cleanly instead of hanging the whole stem set.
                const juce::uint32 startMs    = juce::Time::getMillisecondCounter();
                const juce::uint32 deadlineMs = (juce::uint32) juce::jmax (60000.0, len * 8000.0 + 60000.0);
                const juce::uint32 stallMs    = 20000;
                float  lastProgress   = -1.0f;
                juce::uint32 lastProgressMs = startMs;

                while (task.runJob() == juce::ThreadPoolJob::jobNeedsRunningAgain)
                {
                    const juce::uint32 nowMs = juce::Time::getMillisecondCounter();
                    const float p = task.getCurrentTaskProgress();
                    if (p > lastProgress) { lastProgress = p; lastProgressMs = nowMs; }

                    if (nowMs - lastProgressMs > stallMs || nowMs - startMs > deadlineMs)
                    {
                        if (task.errorMessage.isEmpty())
                            task.errorMessage = "stem render stalled (a clip's audio source could not be read)";
                        break;
                    }
                }

                te::Renderer::turnOffAllPlugins (edit);

                if (task.errorMessage.isNotEmpty())
                {
                    renderError = task.errorMessage;
                    file.deleteFile();
                }
            }
            else
            {
                renderError = "render target is not writable or no tracks are renderable";
            }
        }

        if (renderError.isNotEmpty())
        {
            // Best-effort: one bad track must not abort the whole stem set — record the
            // first failure (surfaced only if EVERY track ends up failing) and continue.
            if (firstError.isEmpty())
                firstError = t->getName() + ": " + renderError;
            continue;
        }

        if (file.existsAsFile() && file.getSize() > 0)
        {
            auto* so = new DynamicObject();
            so->setProperty ("trackId",   t->itemID.toString());
            so->setProperty ("logicalId", logicalid::ensureTrack (t->state));
            so->setProperty ("name",      t->getName());
            so->setProperty ("index",     myIndex);
            so->setProperty ("file",      file.getFullPathName());
            so->setProperty ("bytes",     (juce::int64) file.getSize());
            stems.add (var (so));
        }
    }

    const bool ok = ! stems.isEmpty();
    logLine ("export_stems", args, ok, ok ? String() : (firstError.isNotEmpty() ? firstError : String ("no renderable tracks")), false);
    if (! ok)
        return errResult ("export_stems", firstError.isNotEmpty() ? firstError
                          : String ("no renderable tracks (all empty or hidden)"));

    auto* data = new DynamicObject();
    data->setProperty ("dir",        dir.getFullPathName());
    data->setProperty ("format",     formatName);
    data->setProperty ("bitDepth",   bitDepth);
    data->setProperty ("sampleRate", sampleRate);
    data->setProperty ("seconds",    len);
    data->setProperty ("count",      stems.size());
    data->setProperty ("stems",      var (stems));
    return okResult ("export_stems", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Wave: settings — audio device picker + project lifecycle
//
// Device + project commands are NON-undoable by design (no beginNewTransaction):
// a device change is a machine preference (like set_metronome) and new/open/save-as
// replace or persist the whole Edit — there is nothing to put on the Edit's own
// undo stack, and pushing an empty transaction would silently undo an unrelated
// prior edit. All log undoable:false. list_audio_devices is read-only (no log).
// ─────────────────────────────────────────────────────────────────────────────

juce::var MoshOps::currentAudioSelection()
{
    // Lightweight current-selection summary for the snapshot's audio{} block + the
    // set_audio_device result. NO full device lists here (those stay behind the
    // on-demand list_audio_devices so the snapshot stays small).
    auto& dm = adm();
    auto setup = dm.getAudioDeviceSetup();
    auto* o = new DynamicObject();
    o->setProperty ("type", dm.getCurrentAudioDeviceType());
    o->setProperty ("outputDevice", setup.outputDeviceName);
    o->setProperty ("inputDevice", setup.inputDeviceName);
    o->setProperty ("sampleRate", setup.sampleRate);
    o->setProperty ("bufferSize", setup.bufferSize);
    return var (o);
}

juce::var MoshOps::cmdListAudioDevices (const juce::var&)
{
    // Read-only enumeration — no transaction, no log line. Headless (no audio) the
    // engine never adds system device types (MoshEngine addSystemAudioIODeviceTypes
    // returns false), so `types` is a well-formed empty array and audioEnabled:false.
    auto& dm = adm();

    Array<var> types;
    for (auto* type : dm.getAvailableDeviceTypes())
    {
        if (type == nullptr) continue;
        type->scanForDevices();                          // required before getDeviceNames

        Array<var> outputs, inputs;
        for (auto& n : type->getDeviceNames (false)) outputs.add (n);
        for (auto& n : type->getDeviceNames (true))  inputs.add (n);

        auto* to = new DynamicObject();
        to->setProperty ("name", type->getTypeName());
        to->setProperty ("outputs", outputs);
        to->setProperty ("inputs", inputs);
        types.add (var (to));
    }

    // Valid sample-rate / buffer-size lists are only meaningful when a device is
    // open (null headless → empty arrays).
    Array<var> sampleRates, bufferSizes;
    int defaultBufferSize = 0;
    if (auto* dev = dm.getCurrentAudioDevice())
    {
        for (auto sr : dev->getAvailableSampleRates()) sampleRates.add (sr);
        for (auto bs : dev->getAvailableBufferSizes()) bufferSizes.add (bs);
        defaultBufferSize = dev->getDefaultBufferSize();
    }

    auto* data = new DynamicObject();
    data->setProperty ("types", types);
    data->setProperty ("current", currentAudioSelection());
    data->setProperty ("sampleRates", sampleRates);
    data->setProperty ("bufferSizes", bufferSizes);
    data->setProperty ("defaultBufferSize", defaultBufferSize);
    data->setProperty ("audioEnabled", eng.hasAudio());
    return okResult ("list_audio_devices", var (data));
}

juce::var MoshOps::cmdListMidiInputs (const juce::var&)
{
    // Read-only MIDI-input enumeration (CTL-001) — modelled on cmdListAudioDevices:
    // no transaction, no log line, no event. Headless (no audio device) the engine's
    // MIDI device list is empty (devices are only enumerated once CoreAudio/MIDI is
    // up), so `inputs` is a well-formed empty array. The live note flow (controller ->
    // armed instrument track -> audible synth) is hardware-gated and verified live.
    auto& dm = eng.engine().getDeviceManager();

    Array<var> inputs;
    for (auto& mi : dm.getMidiInDevices())
    {
        if (mi == nullptr) continue;

        auto* o = new DynamicObject();
        o->setProperty ("name", mi->getName());
        o->setProperty ("alias", mi->getAlias());
        o->setProperty ("deviceID", mi->getDeviceID());
        o->setProperty ("enabled", mi->isEnabled());
        switch (mi->getMonitorMode())
        {
            case te::InputDevice::MonitorMode::off:       o->setProperty ("monitor", "off"); break;
            case te::InputDevice::MonitorMode::on:        o->setProperty ("monitor", "on"); break;
            case te::InputDevice::MonitorMode::automatic: o->setProperty ("monitor", "automatic"); break;
            default:                                      o->setProperty ("monitor", "automatic"); break;
        }
        inputs.add (var (o));
    }

    auto* data = new DynamicObject();
    data->setProperty ("inputs", inputs);
    data->setProperty ("audioEnabled", eng.hasAudio());
    return okResult ("list_midi_inputs", var (data));
}

juce::var MoshOps::cmdListDirectory (const juce::var& args)
{
    // BRW-001 — content/file browser enumerator. STRICTLY READ-ONLY: no transaction,
    // no log line, no event. Like cmdListAudioDevices / cmdGetCommandLog it returns
    // okResult(...) directly — listing the filesystem must never pollute the undo
    // stack or mosh-log.jsonl. There is no new mutation path: the UI imports a chosen
    // file via the existing import_clip command (which re-validates at import time).
    //
    // Never recurses (one level per call). Never writes / deletes / mkdir. Graceful on
    // a missing / not-a-directory / permission-denied path: returns ok:true with
    // exists:false + an error string + the well-known roots so the UI can recover.
    // errResult is reserved for a genuinely malformed request.
    using TFTF = File::TypesOfFileToFind;
    static const StringArray audioExts { ".wav", ".aif", ".aiff", ".flac", ".mp3", ".ogg" };

    // Well-known roots — ALWAYS returned regardless of path validity, so the browser
    // always has sane recovery targets. Skip-if-absent keeps this strictly read-only
    // (we never create the imports dir just to advertise it).
    Array<var> roots;
    auto addRoot = [&] (const String& name, const File& dir)
    {
        if (dir.isDirectory())
        {
            auto* o = new DynamicObject();
            o->setProperty ("name", name);
            o->setProperty ("path", dir.getFullPathName());
            roots.add (var (o));
        }
    };
    addRoot ("Home",     File::getSpecialLocation (File::userHomeDirectory));
    addRoot ("Music",    File::getSpecialLocation (File::userMusicDirectory));
    addRoot ("Desktop",  File::getSpecialLocation (File::userDesktopDirectory));
    addRoot ("Documents",File::getSpecialLocation (File::userDocumentsDirectory));
    addRoot ("Imports",  eng.sessionDir().getChildFile ("imports"));

    auto makeResult = [&] (const File& dir, bool exists, const String& error,
                           const Array<var>& entries, const File* parentForUp) -> juce::var
    {
        auto* data = new DynamicObject();
        data->setProperty ("path", dir.getFullPathName());
        // parent drives the Up button; null at the filesystem root.
        if (parentForUp != nullptr && *parentForUp != dir && parentForUp->isDirectory())
            data->setProperty ("parent", parentForUp->getFullPathName());
        else
            data->setProperty ("parent", var());   // null
        data->setProperty ("exists", exists);
        data->setProperty ("error", error.isNotEmpty() ? var (error) : var());
        data->setProperty ("roots", roots);
        data->setProperty ("entries", entries);
        return okResult ("list_directory", var (data));
    };

    const auto req = args.getProperty ("path", var()).toString();

    // Resolve the target. Empty -> default to Home. NEVER resolve a relative path
    // against the (unstable) process cwd, and NEVER construct File() with a non-absolute
    // path (that trips a JUCE assertion) — guard with isAbsolutePath first.
    File dir;
    if (req.isEmpty())
    {
        dir = File::getSpecialLocation (File::userHomeDirectory);
    }
    else if (! File::isAbsolutePath (req))
    {
        // Malformed/relative request: return the home dir's parent? No — just report
        // invalid with roots so the UI recovers, without ever building a relative File.
        auto* data = new DynamicObject();
        data->setProperty ("path", req);
        data->setProperty ("parent", var());
        data->setProperty ("exists", false);
        data->setProperty ("error", "invalid path (must be absolute)");
        data->setProperty ("roots", roots);
        data->setProperty ("entries", Array<var>());
        return okResult ("list_directory", var (data));
    }
    else
    {
        dir = File (req);
    }

    File parent = dir.getParentDirectory();

    if (! dir.isDirectory())
        return makeResult (dir, false, "not a directory or not found", Array<var>(), &parent);
    if (! dir.hasReadAccess())
        return makeResult (dir, false, "permission denied", Array<var>(), &parent);

    // Gather sub-directories then audio files, each sorted case-insensitively, dirs
    // first. ignoreHiddenFiles keeps dotfiles / .DS_Store out. searchRecursively=false.
    Array<File> dirs  = dir.findChildFiles (TFTF::findDirectories | TFTF::ignoreHiddenFiles, false, "*");
    Array<File> files = dir.findChildFiles (TFTF::findFiles       | TFTF::ignoreHiddenFiles, false, "*");

    struct ByName { int compareElements (const File& a, const File& b) const {
        return a.getFileName().compareIgnoreCase (b.getFileName()); } } byName;
    dirs.sort (byName);
    files.sort (byName);

    Array<var> entries;
    auto addEntry = [&] (const File& f, bool isDir)
    {
        auto* o = new DynamicObject();
        o->setProperty ("name", f.getFileName());
        o->setProperty ("path", f.getFullPathName());
        o->setProperty ("isDir", isDir);
        // File::getSize() is int64; juce::var has no int64 ctor — store as double to
        // avoid overflow on large files (formatted in the UI).
        o->setProperty ("size", isDir ? var() : var ((double) f.getSize()));
        entries.add (var (o));
    };

    for (auto& d : dirs)  addEntry (d, true);
    for (auto& f : files)
        if (audioExts.contains (f.getFileExtension().toLowerCase()))
            addEntry (f, false);

    return makeResult (dir, true, {}, entries, &parent);
}

juce::var MoshOps::cmdGetCommandLog (const juce::var& args)
{
    // READ-ONLY inspector over the canonical command log (mosh-log.jsonl). This is
    // the one command that must NOT log/transact/emit — doing so would pollute the
    // very file it returns (and make get_command_log appear in its own results).
    // Modelled on cmdListAudioDevices / cmdListPlugins: returns okResult directly.
    int limit = (int) args.getProperty ("limit", 50);
    if (limit <= 0) limit = 50;
    if (limit > kCommandLogInspectorMaxEntries) limit = kCommandLogInspectorMaxEntries;

    const auto file = eng.sessionDir().getChildFile ("mosh-log.jsonl");
    refreshCommandLogCacheIfNeeded (file);

    Array<var> recent;
    int total = 0;
    double logBytes = 0.0;
    {
        const juce::ScopedLock sl (commandLogCacheLock_);
        total = (int) commandLogTotal_;
        logBytes = (double) juce::jmax<juce::int64> (commandLogBytes_, 0);

        for (int i = commandLogRecentEntries_.size() - 1; i >= 0 && recent.size() < limit; --i)
            recent.add (commandLogRecentEntries_.getReference (i));
    }

    auto* data = new DynamicObject();
    data->setProperty ("entries", recent);
    data->setProperty ("total", total);
    data->setProperty ("limit", limit);
    data->setProperty ("logBytes", logBytes);
    return okResult ("get_command_log", var (data));
}

// Applies a device-setup patch (type/output/input/sampleRate/bufferSize) to the
// AudioDeviceManager. Returns the error string (empty == success). NO logging / no
// snapshot emit — the callers (set_audio_device / set_buffer_size) log exactly once
// under their own command name so the JSONL has one line per user action.
juce::String MoshOps::applyAudioDeviceSetup (const juce::var& args)
{
    auto& dm = adm();

    // Device type switch (optional).
    const auto type = args.getProperty ("type", var()).toString();
    if (type.isNotEmpty() && type != dm.getCurrentAudioDeviceType())
        dm.setCurrentAudioDeviceType (type, true);

    auto setup = dm.getAudioDeviceSetup();
    if (args.hasProperty ("outputDevice"))
        setup.outputDeviceName = args.getProperty ("outputDevice", var()).toString();
    if (args.hasProperty ("inputDevice"))
    {
        setup.inputDeviceName = args.getProperty ("inputDevice", var()).toString();
        // Match the existing working rule (MoshEngine applyRequestedAudioOutputDevice):
        // only request default input channels when an input device is selected.
        setup.inputChannels.clear();
        setup.useDefaultInputChannels = setup.inputDeviceName.isNotEmpty();
    }
    if (args.hasProperty ("sampleRate"))
        setup.sampleRate = (double) args.getProperty ("sampleRate", 0.0);
    if (args.hasProperty ("bufferSize"))
        setup.bufferSize = (int) args.getProperty ("bufferSize", 0);
    setup.useDefaultOutputChannels = true;

    // setAudioDeviceSetup returns an ERROR STRING (empty == success) — do not invert.
    const auto err = dm.setAudioDeviceSetup (setup, true);
    if (err.isNotEmpty())
        return err;

    // Rebuild Tracktion's wave-device wrappers + flush the async device update
    // before the next snapshot (mirrors MoshEngine.cpp applyRequestedAudioOutputDevice).
    eng.engine().getDeviceManager().rescanWaveDeviceList();
    if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
        mm->runDispatchLoopUntil (50);

    // PRE-001 — persist the chosen device setup to the session dir so it is restored
    // on the next launch (MoshEngine reads it before the MOSH_AUDIO_OUTPUT_DEVICE env
    // fallback). A machine/whole-app preference, written without the undo manager.
    if (auto stateXml = std::unique_ptr<juce::XmlElement> (adm().createStateXml()))
        stateXml->writeTo (eng.sessionDir().getChildFile ("audio-device.xml"));

    return {};
}

juce::var MoshOps::cmdSetAudioDevice (const juce::var& args)
{
    // Graceful degradation: headless / no-audio session has no device to drive.
    // Log the failed attempt (undoable:false) so the JSONL trail records it, then
    // return a real, honest error (NOT a crash).
    if (! eng.hasAudio())
    {
        logLine ("set_audio_device", args, false, "no audio device in this session", false);
        return errResult ("set_audio_device", "no audio device in this session");
    }

    const auto err = applyAudioDeviceSetup (args);
    if (err.isNotEmpty())
    {
        logLine ("set_audio_device", args, false, err, false);
        return errResult ("set_audio_device", err);
    }

    logLine ("set_audio_device", args, true, {}, false);   // machine preference — not undoable
    emitSnapshotInvalidated();
    return okResult ("set_audio_device", currentAudioSelection());
}

juce::var MoshOps::cmdSetBufferSize (const juce::var& args)
{
    // Thin convenience wrapper = a bufferSize-only device-setup. Maps 1:1 to a UI
    // control; shares the no-device guard + non-undoable logging. Logs exactly ONE
    // JSONL line under set_buffer_size (it applies the setup directly, not via
    // cmdSetAudioDevice, so there is no phantom set_audio_device line).
    if (! args.hasProperty ("bufferSize"))
        return errResult ("set_buffer_size", "missing 'bufferSize'");
    if (! eng.hasAudio())
    {
        logLine ("set_buffer_size", args, false, "no audio device in this session", false);
        return errResult ("set_buffer_size", "no audio device in this session");
    }

    auto* patch = new DynamicObject();
    patch->setProperty ("bufferSize", args.getProperty ("bufferSize", var()));
    const auto err = applyAudioDeviceSetup (var (patch));
    if (err.isNotEmpty())
    {
        logLine ("set_buffer_size", args, false, err, false);
        return errResult ("set_buffer_size", err);
    }

    logLine ("set_buffer_size", args, true, {}, false);   // machine preference — not undoable
    emitSnapshotInvalidated();
    return okResult ("set_buffer_size", currentAudioSelection());
}

juce::var MoshOps::cmdSetAudioThreads (const juce::var& args)
{
    // PRF-001 — multicore audio processing preference. This is a GENUINE knob, not a
    // dead toggle: it drives MoshEngineBehaviour::getNumberOfCPUsToUseForAudio(), which
    // Tracktion applies as setNumThreads(N-1) on the parallel playback/render graph.
    // UI value 1 => 0 worker threads => single-threaded; higher => more parallelism.
    //
    // Unlike set_buffer_size / set_audio_device this is NOT gated on an open audio
    // device: the preference + readout are valid headless (only the live re-apply,
    // handled inside setAudioThreadPref, is conditional on a running context). That
    // keeps it testable in --selftest (which runs MOSH_NO_AUDIO).
    if (! args.hasProperty ("threads"))
        return errResult ("set_audio_threads", "missing 'threads'");

    const int cores = eng.availableCores();
    const int requested = (int) args.getProperty ("threads", var());

    // Reject clearly-invalid input (<=0 or absurdly large) rather than silently
    // coercing it into the valid range — keeps the readout honest and the UI safe.
    if (requested < 1 || requested > 4096)
        return errResult ("set_audio_threads",
                          "threads out of range (expected 1.." + String (cores) + ")");

    const int clamped = juce::jlimit (1, cores, requested);   // clamp to the real core count
    eng.setAudioThreadPref (clamped);                         // store + LIVE re-apply (if a device is open)

    logLine ("set_audio_threads", args, true, {}, false);     // machine preference — NOT undoable
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("availableCores", cores);
    data->setProperty ("audioThreads", eng.effectiveAudioThreads());
    return okResult ("set_audio_threads", var (data));
}

juce::var MoshOps::cmdNewProject (const juce::var& args)
{
    unregisterAllMeterClients();           // old measurers valid here; dead after the swap
    auto name = args.getProperty ("name", var()).toString().trim();
    if (name.isEmpty())
        name = "untitled-" + String (Time::getCurrentTime().toMilliseconds());

    auto file = eng.sessionDir().getChildFile ("projects")
                    .getChildFile (File::createLegalFileName (name))
                    .withFileExtension ("tracktionedit");

    eng.newProject (file);                 // stops transport + frees ctx before swap, re-points retriever
    lastSeenContext = nullptr;             // old ctx freed; force master-meter re-attach to the new ctx
    logFile = eng.sessionDir().getChildFile ("mosh-log.jsonl");
    invalidateCommandLogCache();
    refreshMpStemDir();   // PR-2: eng.editFile() just changed
    logLine ("new_project", args, true, {}, false);   // replaces the Edit — not undoable
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("editFile", eng.editFile().getFullPathName());
    return okResult ("new_project", var (data));
}

// Shared open-by-path body for open_project / open_recent. The caller has already
// validated the file exists; this performs the identical Edit-swap dance both ops
// need (one mutation path). `commandName` tags the log/result so each op stays
// distinguishable in the JSONL + the structured envelope.
juce::var MoshOps::openProjectFile (const File& file, const juce::var& args, const char* commandName)
{
    unregisterAllMeterClients();           // old measurers valid here; dead after the swap
    // PRJ-FMT — a newer-format file is refused; the current project stays loaded + saveable.
    if (auto refusal = eng.openProject (file); refusal.isNotEmpty())  // else: stops transport + frees ctx before swap
    {
        logLine (commandName, args, false, refusal, false);
        emitSnapshotInvalidated();         // re-attaches meters to the unchanged context
        return errResult (commandName, refusal);
    }
    lastSeenContext = nullptr;             // old ctx freed; force master-meter re-attach to the new ctx
    logFile = eng.sessionDir().getChildFile ("mosh-log.jsonl");
    invalidateCommandLogCache();
    refreshMpStemDir();   // PR-2: eng.editFile() just changed
    logLine (commandName, args, true, {}, false);  // replaces the Edit — not undoable
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("editFile", eng.editFile().getFullPathName());
    return okResult (commandName, var (data));
}

juce::var MoshOps::cmdOpenProject (const juce::var& args)
{
    const auto path = args.getProperty ("file", var()).toString();
    if (path.isEmpty()) return errResult ("open_project", "missing 'file'");

    File file (path);
    if (! file.existsAsFile()) return errResult ("open_project", "file not found: " + path);

    return openProjectFile (file, args, "open_project");
}

// PRJ — Open Recent by position in the recent list (0 = most-recent). The backend
// owns the resolution so the UI never round-trips a stale path: the index is mapped
// against the SAME existing-file Recent list the snapshot exposes (eng.recentProjects),
// which is already filtered to files that exist. Out-of-range indices and an
// already-pruned entry degrade to a clean error result. Replaces the Edit — not undoable.
juce::var MoshOps::cmdOpenRecent (const juce::var& args)
{
    if (! args.hasProperty ("index")) return errResult ("open_recent", "missing 'index'");
    const int index = (int) args.getProperty ("index", var (0));
    if (index < 0) return errResult ("open_recent", "index out of range: " + String (index));

    const auto recents = eng.recentProjects();   // newest-first, existing files only
    if (! recents.isArray() || index >= recents.size())
        return errResult ("open_recent", "no recent project at index " + String (index));

    const auto path = recents[index].getProperty ("path", var()).toString();
    File file (path);
    if (path.isEmpty() || ! file.existsAsFile())
        return errResult ("open_recent", "recent project no longer on disk: " + path);

    return openProjectFile (file, args, "open_recent");
}

juce::var MoshOps::cmdSaveAs (const juce::var& args)
{
    const auto path = args.getProperty ("file", var()).toString();
    if (path.isEmpty()) return errResult ("save_as", "missing 'file'");

    File file (path);
    if (file.getFileExtension().isEmpty())
        file = file.withFileExtension ("tracktionedit");

    const bool didSave = eng.saveProjectAs (file);   // saveAs + adopt the new backing file + consolidate wave/sampler audio
    logLine ("save_as", args, didSave, didSave ? String() : String ("saveAs failed"), false);
    if (! didSave) return errResult ("save_as", "saveAs failed");

    // AL-009 — consolidate Tier-B render-layer artifacts too. eng.saveProjectAs localises
    // wave-clip sources + sampler sounds, but a render layer's cacheArtifact (the file
    // freeze_layer / re-accept_render depend on) is written by finalizeRender as an
    // ABSOLUTE path into the shared session pool, NOT the project dir. Copy each into the
    // project's audio/renders/ and re-point with a portable RELATIVE ref so the rendered
    // audio survives a project move, then persist the rewritten refs. Kept here (not in
    // MoshEngine, a prime-directive seam) and after the engine consolidation.
    mosh::consolidateRenderArtifacts (eng.edit().state, eng.editFile().getParentDirectory());
    eng.save();
    refreshMpStemDir();   // PR-2: eng.editFile() just changed (saveProjectAs adopts the new backing file)
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("file", eng.editFile().getFullPathName());
    return okResult ("save_as", var (data));
}

te::AudioTrack* MoshOps::createAudioTrack (const juce::String& name)
{
    auto& edit = eng.edit();
    auto track = edit.insertNewAudioTrack (te::TrackInsertPoint::getEndOfTracks (edit), nullptr, false);
    if (track == nullptr)
        return nullptr;

    // MP-001 — stamp the stable cross-peer logical id at creation (identity, not
    // user state, so written without the undo manager; see LogicalId.h).
    logicalid::ensureTrack (track->state);

    if (name.isNotEmpty())
        track->setName (name);

    // Tracktion queues a track-order AsyncUpdater after insertion. In headless
    // command runs there is no normal GUI dispatch between commands, so drain it
    // here before the next undo transaction is opened.
    if (! eng.hasAudio())
        if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
            mm->runDispatchLoopUntil (1);

    return track.get();
}

te::VolumeAndPanPlugin* MoshOps::ensureVolumePlugin (te::AudioTrack& track)
{
    if (auto* existing = track.getVolumePlugin())
        return existing;

    if (auto plugin = eng.edit().getPluginCache().createNewPlugin (te::VolumeAndPanPlugin::xmlTypeName, {}))
    {
        track.pluginList.insertPlugin (plugin, -1, nullptr);
        return dynamic_cast<te::VolumeAndPanPlugin*> (plugin.get());
    }

    return nullptr;
}

juce::var MoshOps::pluginToVar (te::Plugin& p, int index, te::AudioTrack* owner)
{
    auto* o = new DynamicObject();
    o->setProperty ("index", index);
    o->setProperty ("name", p.getName());
    o->setProperty ("type", p.getPluginType());
    o->setProperty ("enabled", p.isEnabled());
    auto* ext = dynamic_cast<te::ExternalPlugin*> (&p);
    const auto* bspec = findBuiltin (p.getPluginType());
    o->setProperty ("external", ext != nullptr);
    o->setProperty ("builtin", bspec != nullptr);
    o->setProperty ("isInstrument", (ext != nullptr && ext->isSynth())
                                        || (bspec != nullptr && bspec->isInstrument));
    if (bspec != nullptr)
        o->setProperty ("category", bspec->category);
    if (ext != nullptr)
        addExternalPluginMetadata (*o, *ext);
   #if MOSH_HAVE_ANIRA
    if (auto* r = asRave (&p))
        o->setProperty ("rave", r->describe());
   #endif
    if (auto* mfx = dynamic_cast<MoshFxDescribable*> (&p))
    {
        auto readout = mfx->describeMoshFx();
        if (owner != nullptr && p.getPluginType() == MoshXFeedbackPlugin::xmlTypeName)
        {
            const auto activeCuts = readout.getProperty ("activeCuts", var());
            if (activeCuts.size() == 0)
                readout = xFeedbackPreviewReadout (*owner, p);
        }
        o->setProperty ("moshFx", readout);
    }

    juce::Array<var> params;
    const int n = juce::jmin (16, p.getNumAutomatableParameters());
    for (int i = 0; i < n; ++i)
    {
        auto param = p.getAutomatableParameter (i);
        auto* po = new DynamicObject();
        po->setProperty ("index", i);
        po->setProperty ("name", param->getParameterName());
        po->setProperty ("value", param->getCurrentNormalisedValue());
        const bool automated = param->hasAutomationPoints();
        po->setProperty ("automated", automated);
        if (automated)
        {
            auto& curve = param->getCurve();
            juce::Array<var> pts;
            for (int j = 0; j < curve.getNumPoints(); ++j)
            {
                auto* pt = new DynamicObject();
                pt->setProperty ("t", curve.getPointTime (j).inSeconds());
                pt->setProperty ("v", param->valueRange.convertTo0to1 (curve.getPointValue (j)));
                pts.add (var (pt));
            }
            po->setProperty ("points", pts);
        }
        params.add (var (po));
    }
    o->setProperty ("params", params);
    return var (o);
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::snapshot()
{
    auto& edit = eng.edit();

    auto* session = new DynamicObject();
    // Route C.2 — true only in the anira build; gates the UI "+ RAVE" affordance so the
    // real-time RAVE insert is only offered where it can actually be hosted.
   #if MOSH_HAVE_ANIRA
    session->setProperty ("raveAvailable", true);
   #else
    session->setProperty ("raveAvailable", false);
   #endif
    // FMS Phase-3 sing: the locked-to-self enrollment state (ONE voice per install,
    // ~/Library/Mosh/voice). The fake beep backend renders without it; the UI copy
    // tells the producer whether the REAL own-voice backend has a reference yet.
    {
        const auto voiceDir = juce::File (juce::SystemStats::getEnvironmentVariable (
            "MOSH_VOICE_DIR", juce::File::getSpecialLocation (juce::File::userHomeDirectory)
                                  .getChildFile ("Library/Mosh/voice").getFullPathName()));
        session->setProperty ("singVoiceEnrolled",
                              voiceDir.getChildFile ("reference.wav").existsAsFile()
                                  || voiceDir.getChildFile ("reference-30s.wav").existsAsFile()
                                  || voiceDir.getChildFile ("reference-10s.wav").existsAsFile());
    }
    session->setProperty ("sampleRate", eng.engine().getDeviceManager().getSampleRate());
    session->setProperty ("tempo", edit.tempoSequence.getBpmAt (tracktion::TimePosition()));
    if (auto* ts = edit.tempoSequence.getTimeSig (0))
    {
        session->setProperty ("timeSigNumerator", ts->numerator.get());
        session->setProperty ("timeSigDenominator", ts->denominator.get());
    }

    // SES-001 — the full tempo MAP (additive: tempo/timeSig* above stay point 0 for
    // every existing consumer). Engine-ordered; times in seconds via the engine's
    // own beats->seconds conversion, so the UI's piecewise mapping starts exact.
    {
        Array<var> tempoMap;
        bool anyRamp = false;
        for (int i = 0; i < edit.tempoSequence.getNumTempos(); ++i)
            if (auto* t = edit.tempoSequence.getTempo (i))
            {
                auto* o = new DynamicObject();
                o->setProperty ("time", t->getStartTime().inSeconds());
                o->setProperty ("bpm", t->getBpm());
                o->setProperty ("curve", (double) t->getCurve());
                if (std::abs (t->getCurve()) < 0.9999f && i + 1 < edit.tempoSequence.getNumTempos())
                    anyRamp = true;
                tempoMap.add (var (o));
            }
        session->setProperty ("tempoMap", tempoMap);

        // Tempo RAMPS (curve in (-1,1)): serialize the engine-faithful fine sections
        // so the UI mapping stays exact. We reproduce the engine's own subdivision
        // boundaries (tracktion_core Tempo.h: numSubdivisions = clamp(4 * beatSpan,
        // 1, 100) per ramp span) and read time/bpm back through the engine's toTime /
        // getBpmAt — the very piecewise approximation playback uses. Emitted ONLY
        // when a ramp exists; step-only maps keep the lean tempoMap (the UI falls
        // back to its exact piecewise-constant path).
        if (anyRamp)
        {
            Array<var> sections;
            auto& seq = edit.tempoSequence;
            for (int i = 0; i < seq.getNumTempos(); ++i)
            {
                auto* t = seq.getTempo (i);
                if (t == nullptr) continue;
                auto* o0 = new DynamicObject();
                o0->setProperty ("time", t->getStartTime().inSeconds());
                o0->setProperty ("bpm", seq.getBpmAt (t->getStartTime()));
                sections.add (var (o0));

                if (i + 1 >= seq.getNumTempos() || std::abs (t->getCurve()) >= 0.9999f)
                    continue;   // step span (or the open tail): one section suffices
                const auto b0 = t->getStartBeat();
                const auto b1 = seq.getTempo (i + 1)->getStartBeat();
                const double span = (b1 - b0).inBeats();
                const int subs = (int) std::clamp (4.0 * span, 1.0, 100.0);
                for (int k = 1; k < subs; ++k)
                {
                    const auto bk = tracktion::BeatPosition::fromBeats (b0.inBeats() + span * (double) k / (double) subs);
                    const auto tk = seq.toTime (bk);
                    auto* o = new DynamicObject();
                    o->setProperty ("time", tk.inSeconds());
                    o->setProperty ("bpm", seq.getBpmAt (tk));
                    sections.add (var (o));
                }
            }
            session->setProperty ("tempoSections", sections);
        }

        Array<var> sigMap;
        for (int i = 0; i < edit.tempoSequence.getNumTimeSigs(); ++i)
            if (auto* s = edit.tempoSequence.getTimeSig (i))
            {
                auto* o = new DynamicObject();
                o->setProperty ("time", edit.tempoSequence.toTime (s->getStartBeat()).inSeconds());
                o->setProperty ("numerator", s->numerator.get());
                o->setProperty ("denominator", s->denominator.get());
                sigMap.add (var (o));
            }
        session->setProperty ("timeSigMap", sigMap);
    }
    session->setProperty ("metronome", edit.clickTrackEnabled.get());
    session->setProperty ("length", edit.getLength().inSeconds());
    session->setProperty ("editFile", eng.editFile().getFullPathName());
    session->setProperty ("dirty", eng.isDirty());   // unsaved-changes flag (gap 1)
    // PRJ-FMT — cold-start refusal: the launch session file was made by a newer Mosh, so a
    // safe empty fallback is live. The UI shows this as a blocking "please update Mosh" banner.
    if (eng.hasProjectLoadError())
        session->setProperty ("loadError", eng.projectLoadError());
    // A2/A3 — the prior GUI session ended uncleanly (crashed). recoveryAvailable drives a
    // one-time notice; recoverableCount is how many unsaved arrangement commands the A3 journal
    // can replay (recover_session) to tighten the ≤30s autosave loss toward ~0.
    if (eng.wasUncleanShutdown())
    {
        session->setProperty ("recoveryAvailable", true);
        session->setProperty ("recoverableCount", pendingRecovery_.size());
    }
    session->setProperty ("recentProjects", eng.recentProjects());   // Recent list (gap 2)
    // Project container extension, backend-owned (keeps the storage format out of the
    // UI — the file-dialog filter is built from this, not a hard-coded constant).
    session->setProperty ("projectExtension", eng.editFile().getFileExtension().substring (1));

    // Audio-engine gate + readout (wave: settings — MON-007 / FLY-004). audioEnabled
    // is the gate field the UI reads to disable play/record/export + show the
    // "No audio device" banner. The rest is a small read-only readout; full device
    // lists stay behind on-demand list_audio_devices (keeps this refetched-often
    // snapshot small).
    auto& dm = eng.engine().getDeviceManager();
    session->setProperty ("audioEnabled", eng.hasAudio());
    session->setProperty ("bitDepth", dm.getBitDepth());
    session->setProperty ("bufferSize", dm.getBlockSize());
    session->setProperty ("outputLatencyMs", dm.getOutputLatencySeconds() * 1000.0);

    // PRF-001 — multicore audio readout + preference. availableCores is the logical
    // core count the engine sees; audioThreads is the RESOLVED value it actually uses
    // (== availableCores when 'auto'); audioThreadsAuto lets the UI show "Auto (N)".
    // This is a real, load-bearing preference (drives setNumThreads on the parallel
    // graph), valid headless — not a cosmetic readout. Single-thread is threads=1
    // (no separate on/off flag exists in the engine).
    session->setProperty ("availableCores", eng.availableCores());
    session->setProperty ("audioThreads", eng.effectiveAudioThreads());
    session->setProperty ("audioThreadsAuto", eng.audioThreadPref() <= 0);

    // Monitoring round-trip latency (MON-003). The performer-felt input-monitoring
    // delay is the hardware input + output latency (getRecordAdjustment*), distinct
    // from outputLatencyMs (output only) and totalLatencyMs (whole-graph PDC). Unlike
    // getLatencySamples() this needs only an OPEN device, not a prepared playback
    // graph — so it is valid the moment an interface is present. Read-only state, not
    // a command. Headless / no device -> 0 (surface as "-" in the UI, mirroring how
    // outputLatencyMs is handled). Monitoring is SOFTWARE-ONLY in the pinned engine
    // (no direct/hardware/zero-latency mode); the buffer size is the user's lever.
    // getRecordAdjustment* are non-const, and `dm` here is a non-const reference.
    session->setProperty ("roundTripLatencySamples", dm.getRecordAdjustmentSamples());
    session->setProperty ("roundTripLatencyMs", dm.getRecordAdjustmentMs());

    // Plugin delay compensation readout (MON-004). This is the WHOLE-GRAPH reported
    // latency Tracktion itself compensates — the single authoritative total from the
    // prepared playback graph (te::EditPlaybackContext::getLatencySamples()), which
    // already folds in the neural insert + every hosted plugin (max across parallel
    // paths, sum along chains). It is read-only state, not a command. The context is
    // null until ensureContextAllocated() runs (only with an audio device); headless /
    // no-audio reports 0 + latencyContextReady=false so the UI labels "PDC —" rather
    // than a false "0.0 ms". Distinct from outputLatencyMs (device I/O latency above).
    int totalLatencySamples = 0;
    bool latencyContextReady = false;
    if (auto* ctx = edit.getTransport().getCurrentPlaybackContext())
    {
        totalLatencySamples = ctx->getLatencySamples();
        latencyContextReady = true;
    }
    const double latencySR = dm.getSampleRate() > 0.0 ? dm.getSampleRate() : 44100.0;
    session->setProperty ("totalLatencySamples", totalLatencySamples);
    session->setProperty ("totalLatencyMs", (double) totalLatencySamples / latencySR * 1000.0);
    session->setProperty ("latencyContextReady", latencyContextReady);

    session->setProperty ("audioDeviceName",
        dm.deviceManager.getCurrentAudioDevice() != nullptr
            ? dm.deviceManager.getCurrentAudioDevice()->getName() : String());
    session->setProperty ("audioDeviceError", eng.audioDeviceError());

    // PRJ-008 — per-project format / time-base INTENT (the export/format default +
    // timeline display base). Read from the MOSH_PROJECT child of the Edit tree,
    // falling back to the live device readout where unset (device = live truth,
    // project = remembered intent). This is generic media-format state — no
    // Tracktion concepts cross to the UI.
    auto projectVar = projectSettingsToVar();
    session->setProperty ("project", projectVar);
    // KEY-001 — also mirror the musical key to the TOP level of session (exactly like
    // sampleRate/bitDepth/tempo/metronome above), so the UI reads session.key directly.
    // Single source: the MOSH_PROJECT node via projectSettingsToVar; a convenience mirror,
    // not a second store.
    if (auto* po = projectVar.getDynamicObject())
    {
        session->setProperty ("key", po->getProperty ("key"));
        // G2b — same mirror for the count-in / pre-roll bars, so the UI can read
        // session.countInBars directly (like session.metronome) without reaching
        // into session.project.
        session->setProperty ("countInBars", po->getProperty ("countInBars"));
    }

    Array<var> tracks;
    int index = 0;
    for (auto* t : te::getAudioTracks (edit))
        if (t != nullptr && ! (bool) t->state.getProperty (ids::moshHidden, false))   // Phase 2 — hidden beneath-render track
            tracks.add (trackToVar (*t, index++));

    // MIX-008 — group (submix) tracks, appended AFTER the audio tracks so every
    // existing flat consumer (lanes, mixer strips, selftest firstTrack) is
    // unbroken. A group entry carries isGroup + its real fader (the submix
    // VolumeAndPan the engine added) and an empty clips array.
    for (auto* t : te::getAllTracks (edit))
        if (auto* ft = dynamic_cast<te::FolderTrack*> (t))
        {
            auto* g = new DynamicObject();
            g->setProperty ("id", ft->itemID.toString());
            g->setProperty ("logicalId", logicalid::ensureTrack (ft->state));   // MP-001
            g->setProperty ("index", index++);
            g->setProperty ("name", ft->getName());
            g->setProperty ("type", "group");
            g->setProperty ("isGroup", true);
            g->setProperty ("clips", Array<var>());
            if (auto* vp = ft->getVolumePlugin())
            {
                g->setProperty ("volumeDb", vp->getVolumeDb());
                g->setProperty ("pan", vp->getPan());
            }
            if (auto* parent = ft->getParentFolderTrack())   // nested groups
                g->setProperty ("parentId", parent->itemID.toString());
            tracks.add (var (g));
        }

    auto* root = new DynamicObject();
    root->setProperty ("schemaVersion", mosh::kSnapshotSchemaVersion);  // C++→UI wire contract (≠ file format)
    root->setProperty ("session", var (session));
    root->setProperty ("tracks", tracks);
    root->setProperty ("transport", transportToVar());
    root->setProperty ("controller", controllerToVar());

    // Lightweight current audio-device selection summary for the settings edit form
    // (duplicates session.sampleRate intentionally). Full lists stay on-demand.
    root->setProperty ("audio", currentAudioSelection());

    // Aux buses (Wave 8) — one entry per AuxReturn-carrying track.
    Array<var> buses;
    for (auto* t : te::getAudioTracks (edit))
        if (t != nullptr)
            if (auto* r = firstAuxReturnOn (*t))
            {
                const int bus = r->busNumber.get();
                auto* bo = new DynamicObject();
                bo->setProperty ("bus", bus);
                bo->setProperty ("name", edit.getAuxBusName (bus).isNotEmpty()
                                             ? edit.getAuxBusName (bus) : ("Bus " + String (bus + 1)));
                bo->setProperty ("trackId", t->itemID.toString());
                buses.add (var (bo));
            }
    root->setProperty ("buses", buses);

    // SEC-001 — named song sections (Intro/Verse/Hook/…) from the MOSH_SECTIONS tree.
    root->setProperty ("sections", sectionsToVar());
    root->setProperty ("annotations", annotationsToVar());

    // Master bus (Wave 5) — the edit's master VolumeAndPan, always present.
    if (auto mvp = edit.getMasterVolumePlugin())
    {
        auto* master = new DynamicObject();
        master->setProperty ("volumeDb", mvp->getVolumeDb());
        master->setProperty ("pan", mvp->getPan());
        root->setProperty ("master", var (master));
    }
    return var (root);
}

juce::var MoshOps::trackToVar (te::AudioTrack& t, int index)
{
    Array<var> clips;
    for (auto* c : t.getClips())
        if (c != nullptr)
            clips.add (clipToVar (*c));

    auto* o = new DynamicObject();
    o->setProperty ("id", t.itemID.toString());
    // MP-001 — stable cross-peer logical id (backfilled here for legacy/loaded
    // edits whose tracks predate the stamp; ensure() is a no-op once present).
    o->setProperty ("logicalId", logicalid::ensureTrack (t.state));
    o->setProperty ("index", index);
    o->setProperty ("name", t.getName());
    // DRM-001 — track type ("audio" | "drum"); absent on legacy edits ⇒ "audio".
    o->setProperty ("type", t.state.getProperty (ids::trackType, "audio"));
    o->setProperty ("clips", clips);
    // FL drum-lane mute/solo — the GM pitches whose pad is muted / soloed (empty when
    // none). Lets the drum sequencer render per-lane M·S without a second model.
    {
        auto toArr = [] (const juce::String& s) {
            Array<var> a;
            for (auto& tok : juce::StringArray::fromTokens (s, ",", ""))
                if (tok.trim().isNotEmpty()) a.add (tok.trim().getIntValue());
            return a;
        };
        o->setProperty ("drumMutedPitches", toArr (t.state.getProperty (ids::drumMute, "").toString()));
        o->setProperty ("drumSoloPitches",  toArr (t.state.getProperty (ids::drumSolo, "").toString()));
    }
    // MIX-008 — a track nested under a group (submix folder) carries its parent's
    // id so the UI can indent it / show membership. Additive: flat consumers see
    // the same array, ungrouped tracks have no parentId.
    if (auto* parent = t.getParentFolderTrack())
        o->setProperty ("parentId", parent->itemID.toString());

    // RTG-001 — the explicitly-chosen input (stored preference; the live name is
    // resolved when the device is present, else the persisted id stands alone).
    {
        const auto chosenID = t.state.getProperty (ids::moshInputDevice, var()).toString();
        if (chosenID.isNotEmpty())
        {
            auto* in = new DynamicObject();
            in->setProperty ("deviceID", chosenID);
            auto& dm = eng.engine().getDeviceManager();
            for (int i = 0; i < dm.getNumWaveInDevices(); ++i)
                if (auto* wi = dm.getWaveInDevice (i))
                    if (wi->getDeviceID() == chosenID) { in->setProperty ("name", wi->getName()); break; }
            o->setProperty ("input", var (in));
        }
    }

    // RTG-002 — the track's output destination (te::TrackOutput). Absent = the
    // default output. A route-to-track destination is an implicit submix.
    {
        auto& out = t.getOutput();
        if (auto* dest = out.getDestinationTrack())
        {
            auto* ov = new DynamicObject();
            ov->setProperty ("isTrack", true);
            ov->setProperty ("destId", dest->itemID.toString());
            ov->setProperty ("name", dest->getName());
            o->setProperty ("output", var (ov));
        }
        else if (! out.usesDefaultAudioOut())
        {
            // A non-default device destination (or a persisted-but-missing device):
            // surface the stored name/id so the UI can show it (incl. "missing").
            auto* ov = new DynamicObject();
            ov->setProperty ("isTrack", false);
            ov->setProperty ("name", out.getOutputName());
            ov->setProperty ("deviceID", out.getOutputDeviceID());
            o->setProperty ("output", var (ov));
        }
    }

    // Plugin chain (Stage 3). Indexed within pluginList (built-ins included). The
    // metering tap (Wave 9) is hidden from the rack but keeps its real index so
    // plugin-addressed commands still resolve.
    juce::Array<var> plugins;
    auto pl = t.pluginList.getPlugins();
    for (int i = 0; i < pl.size(); ++i)
        if (pl[i] != nullptr && dynamic_cast<te::LevelMeterPlugin*> (pl[i].get()) == nullptr)
            plugins.add (pluginToVar (*pl[i], i, &t));
    o->setProperty ("plugins", plugins);
    // DRM-001/CTL-001 — does the track host an instrument (synth or builtin)? Lets the
    // header surface the auto-loaded default and label the track MIDI-armable.
    o->setProperty ("isInstrument", trackHasInstrument (t));
    o->setProperty ("meterEnabled", findTrackMeter (t) != nullptr);

    // Mixer state (Stage 2 mixer stub).
    if (auto* vp = t.getVolumePlugin())
    {
        o->setProperty ("volumeDb", vp->getVolumeDb());
        o->setProperty ("pan", vp->getPan());
    }
    else
    {
        o->setProperty ("volumeDb", 0.0);
        o->setProperty ("pan", 0.0);
    }
    o->setProperty ("mute", t.isMuted (false));
    o->setProperty ("solo", t.isSolo (false));

    // Recording state (Wave: recording). Requires a live input-device instance;
    // getAllInputDevices() is empty headless / without a playback context, so all
    // three default false/"automatic"/false. Monitor mode is read off the shared
    // InputDevice behind the instance (per-device, surfaced per-track).
    {
        bool armed = false; juce::String monitor = "automatic"; bool hasInput = false;
        juce::String inputType = "wave"; juce::String midiInputName;
        for (auto* inst : eng.edit().getAllInputDevices())
            if (inst != nullptr && te::isOnTargetTrack (*inst, t, 0))
            {
                hasInput = true;
                armed    = inst->isRecordingEnabled (t.itemID);
                auto& dev = inst->getInputDevice();
                switch (dev.getMonitorMode())
                {
                    case te::InputDevice::MonitorMode::off:       monitor = "off"; break;
                    case te::InputDevice::MonitorMode::on:        monitor = "on"; break;
                    case te::InputDevice::MonitorMode::automatic: monitor = "automatic"; break;
                    default:                                      monitor = "automatic"; break;
                }
                // CTL-001 — let the UI label a MIDI-driven instrument track vs a wave
                // recording track (the routed input device family + its name).
                if (dev.isMidi())
                {
                    inputType     = "midi";
                    midiInputName = dev.getName();
                }
                break;
            }
        o->setProperty ("armed",     armed);     // bool
        o->setProperty ("monitor",   monitor);   // "off" | "automatic" | "on"
        o->setProperty ("hasInput",  hasInput);  // bool — false headless; UI can show "no input"
        o->setProperty ("inputType", inputType); // "wave" | "midi" — kind of the routed input
        if (midiInputName.isNotEmpty())
            o->setProperty ("midiInputName", midiInputName);
    }

    // CTL-001 — does this track host an instrument plugin? The UI shows a "MIDI armed"
    // affordance only on instrument tracks (and arm_track routes live MIDI to them).
    o->setProperty ("isInstrument", trackHasInstrument (t));

    // Sends (post-fader aux sends) owned by this track (Wave 8).
    juce::Array<var> sends;
    for (auto* p : t.pluginList.getPlugins())
        if (auto* s = dynamic_cast<te::AuxSendPlugin*> (p))
        {
            auto* so = new DynamicObject();
            so->setProperty ("bus", s->getBusNumber());
            so->setProperty ("db", s->getGainDb());
            so->setProperty ("mute", s->isMute());
            sends.add (var (so));
        }
    o->setProperty ("sends", sends);
    if (auto* r = firstAuxReturnOn (t))
    {
        o->setProperty ("isReturn", true);
        o->setProperty ("returnBus", r->busNumber.get());
    }
    // LYR-001 — the per-track lyric sheet (absent ⇒ no property; the v2 Lyrics tab
    // shows its empty state). Additive + optional: flat consumers ignore it.
    if (auto sheet = lyricSheetToVar (t); ! sheet.isVoid())
        o->setProperty ("lyricSheet", sheet);
    return var (o);
}

// ── take lanes (audio) — expose Tracktion's native take tree ──────────────────
juce::var MoshOps::cmdListTakes (const juce::var& args)
{
    auto* w = dynamic_cast<te::WaveAudioClip*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (w == nullptr) return errResult ("list_takes", "no wave clip");
    auto descs = w->getTakeDescriptions();
    juce::Array<juce::var> takes;
    for (int i = 0; i < descs.size(); ++i)
    {
        auto* t = new juce::DynamicObject();
        t->setProperty ("index", i);
        t->setProperty ("description", descs[i]);
        t->setProperty ("isCurrent", i == w->getCurrentTake());
        takes.add (juce::var (t));
    }
    auto* o = new juce::DynamicObject();
    o->setProperty ("clipId", w->itemID.toString());
    o->setProperty ("numTakes", w->getNumTakes (false));
    o->setProperty ("currentTakeIndex", w->getCurrentTake());
    o->setProperty ("takes", takes);
    return okResult ("list_takes", juce::var (o));   // read-only: no transaction / log
}

juce::var MoshOps::cmdSetCurrentTake (const juce::var& args)
{
    auto* w = dynamic_cast<te::WaveAudioClip*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (w == nullptr) return errResult ("set_current_take", "no wave clip");
    const int n = w->getNumTakes (false);
    if (n <= 0) return errResult ("set_current_take", "no takes");
    const int idx = juce::jlimit (0, n - 1, (int) args.getProperty ("takeIndex", 0));
    beginTxn ("set_current_take");
    w->setCurrentTake (idx);
    logLine ("set_current_take", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_current_take");
}

juce::var MoshOps::cmdKeepTake (const juce::var& args)
{
    auto* w = dynamic_cast<te::WaveAudioClip*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (w == nullptr) return errResult ("keep_take", "no wave clip");
    if (! w->hasAnyTakes()) return errResult ("keep_take", "no takes to keep");
    beginTxn ("keep_take");
    w->deleteAllUnusedTakes (false);   // keep the current take; preserve source files → undo-safe
    logLine ("keep_take", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("keep_take");
}

juce::var MoshOps::cmdMarkTake (const juce::var& args)
{
    logLine ("mark_take", args, true, {}, false);
    emit ("controller_event", args);
    return okResult ("mark_take");
}

juce::var MoshOps::clipToVar (te::Clip& c)
{
    auto pos = c.getPosition();
    auto* o = new DynamicObject();
    o->setProperty ("id", c.itemID.toString());
    o->setProperty ("name", c.getName());
    o->setProperty ("start", pos.getStart().inSeconds());
    o->setProperty ("length", pos.getLength().inSeconds());
    o->setProperty ("offset", pos.getOffset().inSeconds());

    o->setProperty ("mute", c.isMuted());
    // Phase 2 — a HIDDEN beneath-render audio clip: the UI filters it out of the lanes (it's the
    // audio the producer hears, not a clip to manage). Only present when set, to keep snapshots lean.
    if ((bool) c.state.getProperty (ids::moshHidden, false))
        o->setProperty ("hidden", true);
    if (auto* w = dynamic_cast<te::WaveAudioClip*> (&c))
    {
        o->setProperty ("type", "wave");
        o->setProperty ("sourceFile", w->getCurrentSourceFile().getFullPathName());
        o->setProperty ("sourceMissing", ! w->getCurrentSourceFile().existsAsFile());   // gap 3 — relink cue
        o->setProperty ("sourceLength", w->getSourceLength().inSeconds());
        o->setProperty ("gainDb", w->getGainDB());
        // G4b — clip fades: additive, unconditional (mirrors gainDb) so the snapshot always
        // reflects the current fade even when it's the 0/0 default. getFadeIn()/getFadeOut()
        // would auto-crossfade-adjust when autoCrossfade is on AND a neighbor overlaps; Mosh
        // leaves autoCrossfade off, so this reads the raw stored fade in the common case.
        o->setProperty ("fadeInSec",   w->getFadeIn().inSeconds());
        o->setProperty ("fadeOutSec",  w->getFadeOut().inSeconds());
        o->setProperty ("fadeInType",  (int) w->getFadeInType());   // 1..4 — UI only needs durations for v1
        o->setProperty ("fadeOutType", (int) w->getFadeOutType());
        // Audio warp (auto-tempo): the clip follows the tempo map when on.
        o->setProperty ("autoTempo", w->getAutoTempo());
        if (w->getAutoTempo())
        {
            o->setProperty ("stretchMode", te::TimeStretcher::getNameOfMode (w->getTimeStretchMode()));
            auto info = w->getAudioFile().getInfo();
            o->setProperty ("sourceBpm", w->getLoopInfo().getBpm (info));
        }
        // Take lanes: recording over a region stacks takes in Tracktion's native take
        // tree; the UI renders them as separate lanes (set_current_take / keep_take act
        // on this). Only present when the clip actually has takes.
        if (w->hasAnyTakes())
        {
            o->setProperty ("numTakes", w->getNumTakes (false));
            o->setProperty ("currentTakeIndex", w->getCurrentTake());
            auto descs = w->getTakeDescriptions();
            juce::Array<juce::var> takes;
            for (int i = 0; i < descs.size(); ++i)
            {
                auto* t = new juce::DynamicObject();
                t->setProperty ("index", i);
                t->setProperty ("description", descs[i]);
                t->setProperty ("isCurrent", i == w->getCurrentTake());
                takes.add (juce::var (t));
            }
            o->setProperty ("takes", takes);
        }
    }
    else if (auto* mc = dynamic_cast<te::MidiClip*> (&c))
    {
        o->setProperty ("type", "midi");
        Array<var> notes;
        auto& seq = mc->getSequence();
        for (int i = 0; i < seq.getNumNotes(); ++i)
            if (auto* n = seq.getNote (i))
            {
                auto* no = new DynamicObject();
                no->setProperty ("i", i);
                no->setProperty ("pitch", n->getNoteNumber());
                no->setProperty ("start", n->getStartBeat().inBeats());     // beats within the clip sequence
                no->setProperty ("length", n->getLengthBeats().inBeats());
                no->setProperty ("velocity", n->getVelocity());
                notes.add (var (no));
            }
        o->setProperty ("notes", notes);
    }
    else
        o->setProperty ("type", "clip");

    auto rl = c.state.getChildWithName (ids::MOSH_RENDERLAYER);
    o->setProperty ("hasRenderLayer", rl.isValid());
    if (rl.isValid())
    {
        auto* r = new DynamicObject();
        r->setProperty ("id", rl[ids::id]);
        r->setProperty ("status", rl[ids::status]);
        r->setProperty ("error", rl[ids::renderError]);   // "" unless status=="error"
        r->setProperty ("appliedInPlace", (bool) rl[ids::appliedInPlace]);   // wave: the clip's source IS the render
        r->setProperty ("hasOriginal", rl[ids::originalSourceRef].toString().isNotEmpty());   // wave: Reset is available
        // Phase 2 — MIDI/drum beneath-model is live: the source is muted and a hidden audio clip plays.
        // Drives the "re-imagine active" marker + the Reset button on a MIDI clip. Guarded on the hidden
        // clip still existing so a removed/undone clip clears the marker.
        r->setProperty ("reimagineActive", (bool) rl[kSourceMutedByLayer]
            && rl[kLandedClipId].toString().isNotEmpty()
            && findClip (rl[kLandedClipId].toString()) != nullptr);
        r->setProperty ("coverage", rl[ids::coverage].toString().isNotEmpty() ? rl[ids::coverage] : var ("auto"));   // whole-clip strategy
        r->setProperty ("liveArmed", (bool) rl[ids::liveArmed]);   // Lane A — "Live" render-ahead is armed on this layer
        r->setProperty ("adapter", rl[ids::modelAdapter]);
        r->setProperty ("mode", rl[ids::mode]);
        r->setProperty ("seed", (int) rl[ids::seed]);
        r->setProperty ("userKept", rl[ids::userKept]);
        r->setProperty ("hasArtifact", mosh::resolveCacheArtifact (rl, eng.editFile().getParentDirectory()).existsAsFile());
        // The render's time scope (seconds). For a section-scoped render this is the
        // section's sub-range; for a whole-clip render it equals the clip span.
        r->setProperty ("regionStart", (double) rl[ids::timeRangeStart]);
        r->setProperty ("regionEnd",   (double) rl[ids::timeRangeEnd]);
        if (auto params = rl.getChildWithName (ids::PARAMS); params.isValid())
        {
            r->setProperty ("prompt", params[ids::prompt]);
            r->setProperty ("nl", (double) params[ids::nl]);
            r->setProperty ("lab", (bool) params.getProperty (juce::Identifier ("lab"), false));
            r->setProperty ("target", params[ids::target]);        // Route B transform target
            r->setProperty ("strength", (double) params[ids::strength]); // Route B transform strength
            Array<var> colors;
            if (auto cs = params.getChildWithName (ids::COLORS); cs.isValid())
                for (int i = 0; i < cs.getNumChildren(); ++i)
                {
                    auto* co = new DynamicObject();
                    co->setProperty ("name", cs.getChild (i)[ids::name]);
                    co->setProperty ("value", (double) cs.getChild (i)[ids::value]);
                    colors.add (var (co));
                }
            r->setProperty ("colors", colors);
            Array<var> loras;
            if (auto ls = params.getChildWithName (ids::LORAS); ls.isValid())
                for (int i = 0; i < ls.getNumChildren(); ++i)
                {
                    auto* lo = new DynamicObject();
                    lo->setProperty ("name", ls.getChild (i)[ids::name]);
                    lo->setProperty ("value", (double) ls.getChild (i)[ids::value]);
                    loras.add (var (lo));
                }
            r->setProperty ("loras", loras);
        }
        // The last compile_render verdict (transient) — lets the UI show what it chose +
        // surface an "unsupported" honest message. Parsed back from the JSON blob.
        if (rl.hasProperty (ids::compiledEnvelope))
            r->setProperty ("compiled", juce::JSON::parse (rl[ids::compiledEnvelope].toString()));
        o->setProperty ("renderLayer", var (r));
    }
    return var (o);
}

juce::var MoshOps::transportToVar()
{
    auto& transport = eng.edit().getTransport();
    auto loop = transport.getLoopRange();
    auto* o = new DynamicObject();
    o->setProperty ("playing", transport.isPlaying());
    o->setProperty ("recording", transport.isRecording());
    o->setProperty ("position", transport.getPosition().inSeconds());
    o->setProperty ("looping", transport.looping.get());
    o->setProperty ("loopStart", loop.getStart().inSeconds());
    o->setProperty ("loopEnd", loop.getEnd().inSeconds());
    return var (o);
}

juce::var MoshOps::controllerToVar()
{
    auto& transport = eng.edit().getTransport();

    te::WaveAudioClip* latestWave = nullptr;
    juce::String latestTrackId;
    double latestEnd = -1.0;

    for (auto* track : te::getAudioTracks (eng.edit()))
        if (track != nullptr)
            for (auto* clip : track->getClips())
                if (auto* wave = dynamic_cast<te::WaveAudioClip*> (clip))
                {
                    if ((bool) wave->state.getProperty (ids::moshHidden, false)) continue;   // Phase 2 — not a take
                    const auto pos = wave->getPosition();
                    const double end = pos.getEnd().inSeconds();
                    if (latestWave == nullptr || end >= latestEnd)
                    {
                        latestWave = wave;
                        latestTrackId = track->itemID.toString();
                        latestEnd = end;
                    }
                }

    auto* take = new DynamicObject();
    take->setProperty ("exists", latestWave != nullptr);
    if (latestWave != nullptr)
    {
        const auto pos = latestWave->getPosition();
        const bool hasLanes = latestWave->hasAnyTakes();
        take->setProperty ("clipId", latestWave->itemID.toString());
        take->setProperty ("trackId", latestTrackId);
        take->setProperty ("name", latestWave->getName());
        take->setProperty ("start", pos.getStart().inSeconds());
        take->setProperty ("length", pos.getLength().inSeconds());
        take->setProperty ("hasLanes", hasLanes);
        take->setProperty ("canKeep", hasLanes);
        take->setProperty ("kept", ! hasLanes);
        if (hasLanes)
        {
            take->setProperty ("numTakes", latestWave->getNumTakes (false));
            take->setProperty ("currentTakeIndex", latestWave->getCurrentTake());
        }
    }

    auto* controller = new DynamicObject();
    controller->setProperty ("mode", transport.isRecording() ? "capture" : "judgment");
    controller->setProperty ("record", transport.isRecording() ? "recording" : "idle");
    controller->setProperty ("agent", "idle");
    controller->setProperty ("take", var (take));
    return var (controller);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
te::AudioTrack* MoshOps::findTrack (const juce::String& id)
{
    return te::findAudioTrackForID (eng.edit(), te::EditItemID::fromString (id));
}

bool MoshOps::trackHasInstrument (te::AudioTrack& t)
{
    // Same predicate pluginToVar uses for the "isInstrument" flag: an external
    // synth (ExternalPlugin::isSynth) or a builtin instrument (e.g. 4OSC/sampler).
    auto plugins = t.pluginList.getPlugins();
    for (int i = 0; i < plugins.size(); ++i)
    {
        auto* p = plugins[i].get();
        if (p == nullptr) continue;
        if (auto* ext = dynamic_cast<te::ExternalPlugin*> (p))
            if (ext->isSynth())
                return true;
        if (const auto* bspec = findBuiltin (p->getPluginType()))
            if (bspec->isInstrument)
                return true;
    }
    return false;
}

// DRM-001 — locate the bundled default drum kit. Resolution mirrors WebBridge's UI
// lookup: an env override first (tests / dev), then the app-bundle Resources, then
// next to the executable. Falls back to the bundle path so callers get a sensible
// (if absent) File to test with existsAsFile().
juce::File MoshOps::drumKitDir() const
{
    using juce::File;

    const auto env = juce::SystemStats::getEnvironmentVariable ("MOSH_DRUMKIT_DIR", {});
    if (env.isNotEmpty())
    {
        File d (env);
        if (d.isDirectory()) return d;
    }

    auto appFile = File::getSpecialLocation (File::currentApplicationFile);
    auto bundled = appFile.getChildFile ("Contents/Resources/drumkits/mosh-kit");
    if (bundled.isDirectory()) return bundled;

    auto exeDir = File::getSpecialLocation (File::currentExecutableFile)
                      .getParentDirectory().getChildFile ("drumkits/mosh-kit");
    if (exeDir.isDirectory()) return exeDir;

    return bundled;   // best-effort; callers guard on existsAsFile()
}

bool MoshOps::drumKitAvailable() const
{
    const auto dir = drumKitDir();
    for (auto& pad : kDefaultKit)
        if (dir.getChildFile (pad.file).existsAsFile())
            return true;
    return false;
}

// DRM-001 — the track's existing te::SamplerPlugin, or a fresh one created via the
// Edit's PluginCache (so the inserted plugin IS the one we hold — see cmdLoadPlugin)
// and inserted at the FRONT of the chain (instrument-first: it sources audio that
// the volume/fx downstream then process).
te::SamplerPlugin* MoshOps::ensureSampler (te::AudioTrack& track)
{
    for (auto* p : track.pluginList.getPlugins())
        if (auto* s = dynamic_cast<te::SamplerPlugin*> (p))
            return s;

    auto plugin = eng.edit().getPluginCache().createNewPlugin (te::SamplerPlugin::xmlTypeName, {});
    if (plugin == nullptr) return nullptr;
    track.pluginList.insertPlugin (plugin, 0, nullptr);   // front of chain
    return dynamic_cast<te::SamplerPlugin*> (plugin.get());
}

te::SamplerPlugin* MoshOps::findSampler (te::AudioTrack& track) const
{
    for (auto* p : track.pluginList.getPlugins())
        if (auto* s = dynamic_cast<te::SamplerPlugin*> (p))
            return s;
    return nullptr;
}

// Parse / pack a comma-separated pitch set (the drumMute/drumSolo track props).
static juce::SortedSet<int> parseLanePitches (const juce::String& s)
{
    juce::SortedSet<int> set;
    for (auto& tok : juce::StringArray::fromTokens (s, ",", ""))
        if (tok.trim().isNotEmpty()) set.add (tok.trim().getIntValue());
    return set;
}

void MoshOps::applyDrumLaneGains (te::AudioTrack& track)
{
    auto* sampler = findSampler (track);
    if (sampler == nullptr) return;

    const auto muted = parseLanePitches (track.state.getProperty (ids::drumMute, "").toString());
    const auto solo  = parseLanePitches (track.state.getProperty (ids::drumSolo, "").toString());
    const bool soloActive = solo.size() > 0;

    for (int i = 0; i < sampler->getNumSounds(); ++i)
    {
        const int   key = sampler->getKeyNote (i);
        const bool  eff = soloActive ? ! solo.contains (key) : muted.contains (key);
        const float cur = sampler->getSoundGainDb (i);
        // Only touch a pad crossing the mute threshold — a non-muted pad keeps its own
        // gain; a formerly-muted pad restores to 0 dB.
        if (eff)                   { if (cur > -99.0f) sampler->setSoundGains (i, -100.0f, sampler->getSoundPan (i)); }
        else if (cur <= -99.0f)                        sampler->setSoundGains (i,    0.0f, sampler->getSoundPan (i));
    }
}

// FL drum-lane mute/solo. Stores the muted/soloed GM pitches on the track and applies
// them as sampler pad gains (a muted lane's pad is silenced; soloing lanes silences
// the rest). State persists with the Edit and rides the snapshot for the UI.
juce::var MoshOps::cmdSetDrumLane (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_drum_lane", "no track");
    const int note = juce::jlimit (-1, 127, (int) args.getProperty ("note", -1));
    if (note < 0) return errResult ("set_drum_lane", "note (0-127) required");

    auto pack = [] (const juce::SortedSet<int>& set) {
        juce::StringArray a;
        for (int i = 0; i < set.size(); ++i) a.add (juce::String (set[i]));
        return a.joinIntoString (",");
    };

    beginTxn ("set_drum_lane");
    auto muted = parseLanePitches (track->state.getProperty (ids::drumMute, "").toString());
    auto solo  = parseLanePitches (track->state.getProperty (ids::drumSolo, "").toString());
    if (args.hasProperty ("mute")) { if ((bool) args.getProperty ("mute", false)) muted.add (note); else muted.removeValue (note); }
    if (args.hasProperty ("solo")) { if ((bool) args.getProperty ("solo", false)) solo.add (note);  else solo.removeValue (note); }
    track->state.setProperty (ids::drumMute, pack (muted), &undoManager());
    track->state.setProperty (ids::drumSolo, pack (solo),  &undoManager());
    applyDrumLaneGains (*track);

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("note", note);
    data->setProperty ("muted", muted.contains (note));
    data->setProperty ("solo",  solo.contains (note));
    logLine ("set_drum_lane", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouchTrack (args.getProperty ("trackId", var()).toString());   // Phase 3 — pad mute changes the bounce
    return okResult ("set_drum_lane", var (data));
}

// DRM-001 — clear a sampler and load the 8 bundled pads, each mapped to its GM
// pitch at unity (keyNote==minNote==maxNote) and open-ended (a short note rings the
// whole one-shot). Returns the number of pads actually loaded (0 ⇒ kit not found).
int MoshOps::loadDrumKitInto (te::SamplerPlugin& sampler)
{
    const auto dir = drumKitDir();

    // Confirm at least one pad is actually loadable BEFORE destroying the current
    // sounds — a missing/broken kit dir must be a no-op, never a silent wipe.
    bool anyPresent = false;
    for (auto& pad : kDefaultKit)
        if (dir.getChildFile (pad.file).existsAsFile()) { anyPresent = true; break; }
    if (! anyPresent)
        return 0;

    for (int i = sampler.getNumSounds(); --i >= 0;)
        sampler.removeSound (i);

    int loaded = 0;
    for (auto& pad : kDefaultKit)
    {
        auto f = dir.getChildFile (pad.file);
        if (! f.existsAsFile()) continue;

        const int idx = sampler.getNumSounds();
        if (sampler.addSound (f.getFullPathName(), pad.name, 0.0, 0.0 /*whole file*/, 0.0f).isNotEmpty())
            continue;
        sampler.setSoundParams (idx, pad.pitch, pad.pitch, pad.pitch);
        sampler.setSoundOpenEnded (idx, true);
        ++loaded;
    }

    // Resolve sample files now (see the pump note in cmdAssignSample).
    if (! eng.hasAudio())
        if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
            mm->runDispatchLoopUntil (5);

    return loaded;
}

// DRM-001 — auto-load the sane default instrument so a freshly-created MIDI/drum
// track is audible immediately, WITHOUT clobbering an instrument the user already
// chose. Drum ⇒ sampler + bundled kit; melodic ⇒ 4OSC (the best self-contained
// built-in synth). Discoverable, not magic: the loaded plugin shows up in the
// track's snapshot plugin rack and the header's instrument badge.
void MoshOps::ensureDefaultInstrument (te::AudioTrack& track, bool drum)
{
    if (trackHasInstrument (track))
        return;

    if (drum)
    {
        if (! drumKitAvailable())   // no kit → don't insert an empty, silent sampler
            return;
        if (auto* s = ensureSampler (track))
            loadDrumKitInto (*s);
        return;
    }

    if (auto plugin = eng.edit().getPluginCache().createNewPlugin ("4osc", {}))
        track.pluginList.insertPlugin (plugin, 0, nullptr);   // front of chain (instrument)
}

te::Clip* MoshOps::findClip (const juce::String& id)
{
    const auto target = te::EditItemID::fromString (id);
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr)
            for (auto* c : t->getClips())
                if (c != nullptr && c->itemID == target)
                    return c;
    return nullptr;
}

te::Plugin* MoshOps::findPlugin (const juce::String& trackId, int index)
{
    auto* track = findTrack (trackId);
    if (track == nullptr) return nullptr;
    auto plugins = track->pluginList.getPlugins();
    return (index >= 0 && index < plugins.size()) ? plugins[index].get() : nullptr;
}

void MoshOps::emit (const juce::String& type, juce::var payload)
{
    if (replayingRecovery_) return;   // A3 — suppress per-command events; one final invalidate after replay
    if (! eventSink) return;
    auto* e = new DynamicObject();
    e->setProperty ("type", type);
    e->setProperty ("payload", payload);
    eventSink (var (e));
}

void MoshOps::emitSnapshotInvalidated()
{
    emit ("snapshot_invalidated");
}

void MoshOps::emitTrackPatch (te::AudioTrack& track)
{
    if (eventSink == nullptr) { return; }   // (no sink ⇒ nothing to scope)
    const int idx = te::getAudioTracks (eng.edit()).indexOf (&track);
    auto* p = new DynamicObject();
    p->setProperty ("scope", "track");                  // the UI patches one track, not the world
    p->setProperty ("trackId", track.itemID.toString());
    p->setProperty ("track", trackToVar (track, idx));
    emit ("snapshot_invalidated", var (p));
}

void MoshOps::logLine (const juce::String& command, const juce::var& args,
                       bool ok, const juce::String& error, bool undoable)
{
    auto* o = new DynamicObject();
    o->setProperty ("ts", Time::getCurrentTime().toMilliseconds());
    o->setProperty ("seq", ++seq);
    o->setProperty ("command", command);
    o->setProperty ("args", args);
    o->setProperty ("ok", ok);
    if (error.isNotEmpty()) o->setProperty ("error", error);
    o->setProperty ("undoable", undoable);
    const auto record = var (o);
    const auto line = JSON::toString (record, true);
    const auto filePath = logFile.getFullPathName();
    const auto fileBytesBefore = logFile.existsAsFile() ? logFile.getSize() : 0;
    logFile.appendText (line + "\n");
    const auto fileBytesAfter = logFile.existsAsFile() ? logFile.getSize() : 0;

    const juce::ScopedLock sl (commandLogCacheLock_);
    if (commandLogCachePrimed_ && commandLogPath_ == filePath && commandLogBytes_ == fileBytesBefore)
    {
        ++commandLogTotal_;

        auto entry = makeCommandLogInspectorEntry (record);
        if (entry.isObject())
        {
            commandLogRecentEntries_.add (entry);
            if (commandLogRecentEntries_.size() > kCommandLogInspectorMaxEntries)
                commandLogRecentEntries_.remove (0);
        }

        commandLogBytes_ = fileBytesAfter;
        return;
    }

    commandLogRecentEntries_.clearQuick();
    commandLogTotal_ = 0;
    commandLogBytes_ = -1;
    commandLogPath_.clear();
    commandLogCachePrimed_ = false;
}

// ── A3 — crash-recovery journal ───────────────────────────────────────────────
void MoshOps::initRecoveryJournal()
{
    recoveryJournalFile = eng.sessionDir().getChildFile ("recovery-journal.jsonl");
    if (eng.wasUncleanShutdown() && recoveryJournalFile.existsAsFile())
    {
        // Read the crashed session's unsaved tail into memory BEFORE the first save can
        // truncate the file — so save-truncation can never race recovery.
        for (auto& l : juce::StringArray::fromLines (recoveryJournalFile.loadFileAsString()))
            if (l.trim().isNotEmpty()) pendingRecovery_.add (l.trim());
    }
    recoveryJournalFile.deleteFile();   // start THIS session's journal fresh
}

// Only deterministic, replayable arrangement mutations are journaled — NOT plugin ops (the
// in-process-crash culprits; replaying one would re-crash) nor renders/admin/transport/IO.
// An ALLOWLIST (conservative): an unknown command is simply not recovered, never misapplied.
bool MoshOps::isReplayableCommand (const juce::String& name) const
{
    static const juce::StringArray replayable {
        "create_track", "rename_track", "remove_track", "set_track_type",
        "import_clip", "add_test_tone_clip", "add_midi_clip",
        "move_clip", "trim_clip", "split_clip", "remove_clip", "rename_clip",
        "set_clip_mute", "set_clip_gain", "set_clip_fade", "relink_clip", "set_clip_warp",
        "duplicate_clip", "delete_time_range", "paste_clip",
        "set_track_volume", "set_track_pan", "set_track_mute", "set_track_solo",
        "create_section", "rename_section", "move_section", "remove_section",
        "create_annotation", "edit_annotation", "move_annotation", "remove_annotation",
        "set_tempo", "set_time_signature", "set_metronome", "set_key", "set_project_settings" };
    return replayable.contains (name);
}

void MoshOps::appendRecoveryJournal (const juce::String& name, const juce::var& args, const juce::var& result)
{
    if (! (bool) result.getProperty ("ok", false)) return;     // only successful commands
    if (! isReplayableCommand (name)) return;
    auto* o = new DynamicObject();
    o->setProperty ("c", name);
    o->setProperty ("a", args);
    o->setProperty ("r", result.getProperty ("data", var()));  // assigned ids → id-rebinding on replay
    recoveryJournalFile.appendText (JSON::toString (var (o), true) + "\n");
}

// Replace any top-level string arg whose VALUE is a journaled id with its freshly-assigned
// id (value-based, since different commands carry the id under different keys).
juce::var MoshOps::substituteRecoveryIds (const juce::var& args, const juce::HashMap<juce::String, juce::String>& idMap)
{
    auto* in = args.getDynamicObject();
    if (in == nullptr) return args;
    auto* out = new DynamicObject();
    for (auto& p : in->getProperties())
    {
        auto v = p.value;
        if (v.isString()) { const auto s = v.toString(); if (idMap.contains (s)) v = idMap[s]; }
        out->setProperty (p.name, v);
    }
    return var (out);
}

juce::var MoshOps::cmdRecoverSession (const juce::var& args)
{
    juce::HashMap<juce::String, juce::String> idMap;
    static const juce::StringArray idFields {
        "trackId", "clipId", "newClipId", "layerId", "busId", "groupTrackId", "sectionId", "annotationId" };

    int recovered = 0; bool halted = false;
    replayingRecovery_ = true;       // guards re-journaling AND per-command event emits
    for (int i = 0; i < pendingRecovery_.size(); ++i)
    {
        auto entry = JSON::parse (pendingRecovery_[i]);
        if (! entry.isObject()) continue;
        const auto name      = entry.getProperty ("c", var()).toString();
        const auto oldResult = entry.getProperty ("r", var());

        auto* co = new DynamicObject();
        co->setProperty ("command", name);
        co->setProperty ("args", substituteRecoveryIds (entry.getProperty ("a", var()), idMap));
        const auto result = executeImpl (var (co));
        if (! (bool) result.getProperty ("ok", false)) { halted = true; break; }   // halt; keep prior
        ++recovered;

        // Map this command's old→new assigned ids so later references rebind.
        const auto newData = result.getProperty ("data", var());
        for (auto& f : idFields)
        {
            const auto oldV = oldResult.getProperty (f, var()).toString();
            const auto newV = newData.getProperty (f, var()).toString();
            if (oldV.isNotEmpty() && newV.isNotEmpty() && oldV != newV) idMap.set (oldV, newV);
        }
    }
    replayingRecovery_ = false;

    pendingRecovery_.clear();
    if (recovered > 0) { eng.markDirty(); eng.save(); }   // persist recovered work (also truncates)
    emitSnapshotInvalidated();
    logLine ("recover_session", args, true, {}, false);

    auto* d = new DynamicObject();
    d->setProperty ("recovered", recovered);
    d->setProperty ("halted", halted);
    return okResult ("recover_session", var (d));
}

juce::var MoshOps::cmdDiscardRecovery (const juce::var& args)
{
    pendingRecovery_.clear();
    recoveryJournalFile.deleteFile();
    logLine ("discard_recovery", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("discard_recovery");
}

juce::var MoshOps::okResult (const juce::String& command, juce::var data)
{
    auto* o = new DynamicObject();
    o->setProperty ("ok", true);
    o->setProperty ("command", command);
    if (! data.isVoid()) o->setProperty ("data", data);
    return var (o);
}

juce::var MoshOps::errResult (const juce::String& command, const juce::String& message)
{
    auto* o = new DynamicObject();
    o->setProperty ("ok", false);
    o->setProperty ("command", command);
    o->setProperty ("error", message);
    return var (o);
}

} // namespace mosh
