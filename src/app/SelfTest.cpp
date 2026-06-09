#include "SelfTest.h"
#include "engine/MoshEngine.h"
#include "moshops/MoshOps.h"
#include "plugins/neural/NeuralInsertPlugin.h"
#include <atomic>
#include <iostream>
#include <vector>

namespace mosh
{
namespace
{
    int failures = 0;
    int checks = 0;

    void check (bool cond, const juce::String& what)
    {
        ++checks;
        std::cerr << (cond ? "  ok   " : "  FAIL ") << what << std::endl;  // flush each line
        if (! cond) ++failures;
    }

    juce::var cmd (MoshOps& ops, const juce::String& name, juce::var args = juce::var())
    {
        auto* c = new juce::DynamicObject();
        c->setProperty ("command", name);
        if (! args.isVoid()) c->setProperty ("args", args);
        return ops.execute (juce::var (c));
    }

    juce::var args1 (const char* k, juce::var v)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty (k, v);
        return juce::var (o);
    }

    juce::var objN (std::initializer_list<std::pair<const char*, juce::var>> kv)
    {
        auto* o = new juce::DynamicObject();
        for (auto& p : kv) o->setProperty (p.first, p.second);
        return juce::var (o);
    }

    class LiveAudioProbe final : public juce::AudioIODeviceCallback
    {
    public:
        void audioDeviceAboutToStart (juce::AudioIODevice* device) override
        {
            sampleRate = device != nullptr ? device->getCurrentSampleRate() : 48000.0;
            if (sampleRate <= 0.0)
                sampleRate = 48000.0;
            phase = 0.0;
        }

        void audioDeviceStopped() override {}

        void audioDeviceIOCallbackWithContext (const float* const* inputChannelData,
                                               int numInputChannels,
                                               float* const* outputChannelData,
                                               int numOutputChannels,
                                               int numSamples,
                                               const juce::AudioIODeviceCallbackContext&) override
        {
            callbacks.fetch_add (1, std::memory_order_relaxed);
            samples.fetch_add (numSamples, std::memory_order_relaxed);
            inputSamples.fetch_add (numSamples * juce::jmax (0, numInputChannels), std::memory_order_relaxed);

            for (int ch = 0; ch < numInputChannels; ++ch)
                if (auto* in = inputChannelData[ch])
                    for (int i = 0; i < numSamples; ++i)
                        if (std::abs (in[i]) > 0.01f)
                            inputNonSilentSamples.fetch_add (1, std::memory_order_relaxed);

            const auto inc = juce::MathConstants<double>::twoPi * 440.0 / sampleRate;
            int writtenThisBlock = 0;
            for (int i = 0; i < numSamples; ++i)
            {
                const auto s = (float) (std::sin (phase) * 0.35);
                for (int ch = 0; ch < numOutputChannels; ++ch)
                    if (auto* out = outputChannelData[ch])
                    {
                        out[i] = s;
                        ++writtenThisBlock;
                    }

                phase += inc;
                if (phase >= juce::MathConstants<double>::twoPi)
                    phase -= juce::MathConstants<double>::twoPi;
            }
            writtenSamples.fetch_add (writtenThisBlock, std::memory_order_relaxed);
        }

        int getCallbackCount() const { return callbacks.load (std::memory_order_relaxed); }
        int getSampleCount() const { return samples.load (std::memory_order_relaxed); }
        int getWrittenSampleCount() const { return writtenSamples.load (std::memory_order_relaxed); }
        int getInputSampleCount() const { return inputSamples.load (std::memory_order_relaxed); }
        int getInputNonSilentSampleCount() const { return inputNonSilentSamples.load (std::memory_order_relaxed); }

    private:
        double phase = 0.0;
        double sampleRate = 48000.0;
        std::atomic<int> callbacks { 0 };
        std::atomic<int> samples { 0 };
        std::atomic<int> writtenSamples { 0 };
        std::atomic<int> inputSamples { 0 };
        std::atomic<int> inputNonSilentSamples { 0 };
    };

    bool ok (const juce::var& r) { return (bool) r.getProperty ("ok", false); }

    int tracks (MoshOps& ops) { return ops.snapshot().getProperty ("tracks", juce::var()).size(); }

    juce::var firstTrack (MoshOps& ops) { return ops.snapshot()["tracks"][0]; }
    int trackClips (const juce::var& t) { return t.getProperty ("clips", juce::var()).size(); }
}

int runSelfTest (MoshEngine& eng, MoshOps& ops)
{
    using namespace juce;
    failures = 0; checks = 0;
    std::cerr << "\n===== Mosh Stage 1 command-surface harness =====\n";

    // Capture emitted events.
    std::vector<String> eventTypes;
    ops.setEventSink ([&] (const var& e) { eventTypes.push_back (e.getProperty ("type", var()).toString()); });

    auto hadEvent = [&] (const String& t) {
        for (auto& e : eventTypes) if (e == t) return true; return false; };

    // 1. cold snapshot
    check (tracks (ops) == 0, "cold snapshot has no tracks");
    check ((int) ops.snapshot().getProperty ("schemaVersion", 0) == 1, "snapshot schemaVersion == 1");

    // 2. create_track
    auto r = cmd (ops, "create_track", args1 ("name", "Drums"));
    check (ok (r), "create_track ok");
    check (tracks (ops) == 1, "snapshot has 1 track after create_track");
    check (firstTrack (ops).getProperty ("name", var()).toString() == "Drums", "track name == Drums");
    check (hadEvent ("snapshot_invalidated"), "create_track emitted snapshot_invalidated");

    // 3. add_test_tone_clip -> wave clip on the track
    auto toneArgs = new DynamicObject();
    toneArgs->setProperty ("seconds", 2.0);
    toneArgs->setProperty ("freq", 220.0);
    auto rt = cmd (ops, "add_test_tone_clip", var (toneArgs));
    check (ok (rt), "add_test_tone_clip ok");
    auto t0 = firstTrack (ops);
    check (trackClips (t0) == 1, "track has 1 clip");
    auto clip0 = t0["clips"][0];
    check (clip0.getProperty ("type", var()).toString() == "wave", "clip type == wave");
    check (std::abs ((double) clip0.getProperty ("length", 0.0) - 2.0) < 0.05, "clip length ~= 2.0s");
    const auto clipId = clip0.getProperty ("id", var()).toString();
    check (File (clip0.getProperty ("sourceFile", var()).toString()).existsAsFile(), "clip source WAV exists on disk");

    // 4. transport: play -> playing; stop; seek
    auto rp = cmd (ops, "set_transport", args1 ("action", "play"));
    check (ok (rp), "set_transport play ok");
    if (eng.hasAudio())
    {
        check ((bool) rp["data"].getProperty ("playing", false), "transport reports playing after play");
        check (eng.edit().getTransport().getCurrentPlaybackContext() != nullptr, "playback context allocated (audio attached)");
    }
    else
        std::cerr << "  ..   (no-audio headless run — live-playback checks done via the GUI)\n";
    cmd (ops, "set_transport", args1 ("action", "stop"));
    auto seekArgs = new DynamicObject(); seekArgs->setProperty ("position", 1.0);
    cmd (ops, "set_transport", var (seekArgs));
    check (std::abs ((double) ops.snapshot()["transport"].getProperty ("position", 0.0) - 1.0) < 0.05, "seek to 1.0s reflected in snapshot");
    check (hadEvent ("transport"), "set_transport emitted a transport event");

    // 5. add_render_layer on the clip (RenderLayer model, 01 §4)
    auto rl = cmd (ops, "add_render_layer", args1 ("clipId", clipId));
    check (ok (rl), "add_render_layer ok");
    check ((bool) firstTrack (ops)["clips"][0].getProperty ("hasRenderLayer", false), "clip now hasRenderLayer");

    // 6. undo / redo through MoshOps (one command = one undo step)
    cmd (ops, "undo");   // undo add_render_layer
    check (! (bool) firstTrack (ops)["clips"][0].getProperty ("hasRenderLayer", true), "undo removed the render layer");
    cmd (ops, "undo");   // undo import_clip
    check (trackClips (firstTrack (ops)) == 0, "undo removed the clip");
    cmd (ops, "undo");   // undo create_track
    check (tracks (ops) == 0, "undo removed the track");
    cmd (ops, "redo");   // redo create_track
    check (tracks (ops) == 1, "redo restored the track");
    cmd (ops, "redo");   // redo import_clip
    check (trackClips (firstTrack (ops)) == 1, "redo restored the clip");

    // 7. save -> reload restores state (incl. MOSH_RENDERLAYER survives once redone)
    cmd (ops, "redo");   // redo add_render_layer so it's part of saved state
    check ((bool) firstTrack (ops)["clips"][0].getProperty ("hasRenderLayer", false), "render layer restored by redo");
    check (ok (cmd (ops, "save")), "save ok");
    check (ok (cmd (ops, "reload")), "reload ok");
    check (tracks (ops) == 1, "reload restored 1 track");
    auto reclip = firstTrack (ops)["clips"][0];
    check (trackClips (firstTrack (ops)) == 1, "reload restored 1 clip");
    check ((bool) reclip.getProperty ("hasRenderLayer", false), "reload restored MOSH_RENDERLAYER node");

    // 8. JSONL log records the semantic commands
    auto log = eng.sessionDir().getChildFile ("mosh-log.jsonl");
    check (log.existsAsFile(), "JSONL log file exists");
    auto logText = log.loadFileAsString();
    auto logsCommand = [&] (const String& c) { return logText.contains ("\"command\"") && logText.contains (c); };
    check (logsCommand ("create_track"), "JSONL records create_track");
    check (logsCommand ("import_clip"),  "JSONL records import_clip");
    check (logsCommand ("set_transport"),"JSONL records set_transport");
    check (logsCommand ("undo"),         "JSONL records undo");

    // ─── Stage 2: arrangement editing + mixer stub ───
    std::cerr << "--- Stage 2: arrangement + mixer ---\n";
    const auto cid = firstTrack (ops)["clips"][0].getProperty ("id", var()).toString();
    const auto tid = firstTrack (ops).getProperty ("id", var()).toString();

    // move_clip -> start 2.0s
    { auto* a = new DynamicObject(); a->setProperty ("clipId", cid); a->setProperty ("start", 2.0);
      check (ok (cmd (ops, "move_clip", var (a))), "move_clip ok"); }
    check (std::abs ((double) firstTrack (ops)["clips"][0].getProperty ("start", 0.0) - 2.0) < 0.05, "clip moved to 2.0s");

    // trim_clip -> length 1.0s
    { auto* a = new DynamicObject(); a->setProperty ("clipId", cid); a->setProperty ("length", 1.0);
      check (ok (cmd (ops, "trim_clip", var (a))), "trim_clip ok"); }
    check (std::abs ((double) firstTrack (ops)["clips"][0].getProperty ("length", 0.0) - 1.0) < 0.05, "clip trimmed to 1.0s");

    // split_clip -> 2 clips
    { auto* a = new DynamicObject(); a->setProperty ("clipId", cid); a->setProperty ("time", 2.5);
      check (ok (cmd (ops, "split_clip", var (a))), "split_clip ok"); }
    check (trackClips (firstTrack (ops)) == 2, "split produced 2 clips");

    // mixer: volume / pan / mute / solo
    { auto* a = new DynamicObject(); a->setProperty ("trackId", tid); a->setProperty ("db", -6.0);
      check (ok (cmd (ops, "set_track_volume", var (a))), "set_track_volume ok"); }
    check (std::abs ((double) firstTrack (ops).getProperty ("volumeDb", 0.0) + 6.0) < 0.5, "track volume ~= -6 dB");
    { auto* a = new DynamicObject(); a->setProperty ("trackId", tid); a->setProperty ("pan", 0.5);
      cmd (ops, "set_track_pan", var (a)); }
    check (std::abs ((double) firstTrack (ops).getProperty ("pan", 0.0) - 0.5) < 0.05, "track pan ~= 0.5");
    { auto* a = new DynamicObject(); a->setProperty ("trackId", tid); a->setProperty ("mute", true);
      cmd (ops, "set_track_mute", var (a)); }
    check ((bool) firstTrack (ops).getProperty ("mute", false), "track muted");
    { auto* a = new DynamicObject(); a->setProperty ("trackId", tid); a->setProperty ("solo", true);
      cmd (ops, "set_track_solo", var (a)); }
    check ((bool) firstTrack (ops).getProperty ("solo", false), "track soloed");

    // get_clip_peaks -> non-empty peak array (waveform from backend)
    { auto* a = new DynamicObject(); a->setProperty ("clipId", firstTrack (ops)["clips"][0].getProperty ("id", var()));
      a->setProperty ("buckets", 200);
      auto pk = cmd (ops, "get_clip_peaks", var (a));
      check (ok (pk), "get_clip_peaks ok");
      check ((int) pk["data"].getProperty ("buckets", 0) > 0, "peaks array non-empty"); }

    // ─── Stage 3: VST3 hosting + MIDI ───
    std::cerr << "--- Stage 3: VST3 hosting + MIDI ---\n";
    auto trackById = [&] (const String& id) -> var {
        auto snap = ops.snapshot();                 // keep the temporary alive (no dangling array)
        if (auto* arr = snap["tracks"].getArray())
            for (auto& tr : *arr)
                if (tr.getProperty ("id", var()).toString() == id) return tr;
        return {};
    };
    auto externalPluginIndex = [&] (const var& track) -> int {
        if (auto* arr = track.getProperty ("plugins", var()).getArray())
            for (auto& p : *arr)
                if ((bool) p.getProperty ("external", false)) return (int) p.getProperty ("index", -1);
        return -1;
    };

    auto lp = cmd (ops, "list_plugins");
    check (ok (lp), "list_plugins ok");
    const int nPlugins = lp["data"].getProperty ("plugins", var()).size();
    std::cerr << "  ..    " << nPlugins << " VST3 plugin(s) scanned\n";

    String fxId, instId;
    if (auto* arr = lp["data"].getProperty ("plugins", var()).getArray())
        for (auto& p : *arr)
        {
            const bool inst = (bool) p.getProperty ("isInstrument", false);
            if (inst && instId.isEmpty()) instId = p.getProperty ("id", var()).toString();
            if (! inst && fxId.isEmpty()) fxId = p.getProperty ("id", var()).toString();
        }

    if (nPlugins == 0)
    {
        std::cerr << "  (no VST3s available — skipping host checks; commands compiled+dispatch ok)\n";
    }
    else
    {
        // Effect on the existing wave track (tid).
        if (fxId.isNotEmpty())
        {
            { auto* a = new DynamicObject(); a->setProperty ("trackId", tid); a->setProperty ("pluginId", fxId);
              check (ok (cmd (ops, "load_plugin", var (a))), "load_plugin (effect) on wave track ok"); }
            int idx = externalPluginIndex (trackById (tid));
            check (idx >= 0, "effect appears in the plugin chain");
            if (idx >= 0)
            {
                { auto* a = new DynamicObject(); a->setProperty ("trackId", tid); a->setProperty ("index", idx);
                  a->setProperty ("paramIndex", 0); a->setProperty ("value", 0.5);
                  check (ok (cmd (ops, "set_plugin_param", var (a))), "set_plugin_param ok"); }
                { auto* a = new DynamicObject(); a->setProperty ("trackId", tid); a->setProperty ("index", idx);
                  a->setProperty ("bypassed", true);
                  cmd (ops, "bypass_plugin", var (a)); }
                // enabled==false reflected
                bool bypassed = false;
                { auto trk = trackById (tid);   // bind to a local (no dangling temporary)
                  if (auto* arr = trk.getProperty ("plugins", var()).getArray())
                    for (auto& p : *arr) if ((int) p.getProperty ("index", -1) == idx) bypassed = ! (bool) p.getProperty ("enabled", true); }
                check (bypassed, "bypass_plugin disabled the plugin");
                // persists across save/reload
                cmd (ops, "save"); cmd (ops, "reload");
                check (externalPluginIndex (trackById (tid)) >= 0, "hosted plugin persists across save/reload");
                { auto* a = new DynamicObject(); a->setProperty ("trackId", tid);
                  a->setProperty ("index", externalPluginIndex (trackById (tid)));
                  check (ok (cmd (ops, "remove_plugin", var (a))), "remove_plugin ok"); }
                check (externalPluginIndex (trackById (tid)) < 0, "plugin removed from chain");
            }
        }

        // MIDI synth: new track + MIDI clip + instrument.
        auto ct = cmd (ops, "create_track", args1 ("name", "Synth"));
        const auto synthTid = ct["data"].getProperty ("trackId", var()).toString();
        { auto* a = new DynamicObject(); a->setProperty ("trackId", synthTid);
          check (ok (cmd (ops, "add_midi_clip", var (a))), "add_midi_clip ok"); }
        check (trackClips (trackById (synthTid)) == 1, "MIDI clip on synth track");
        auto synthClips = trackById (synthTid).getProperty ("clips", var());
        check (synthClips.size() > 0 && synthClips[0].getProperty ("type", var()).toString() == "midi", "clip type == midi");
        if (instId.isNotEmpty())
        {
            { auto* a = new DynamicObject(); a->setProperty ("trackId", synthTid); a->setProperty ("pluginId", instId);
              check (ok (cmd (ops, "load_plugin", var (a))), "load_plugin (instrument) on MIDI track ok"); }
            bool hasInst = false;
            { auto trk = trackById (synthTid);   // bind to a local (no dangling temporary)
              if (auto* arr = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *arr) if ((bool) p.getProperty ("isInstrument", false)) hasInst = true; }
            check (hasInst, "instrument appears in the synth track chain");
        }
    }

    // ─── Wave 2: tempo / time-signature / metronome / record / navigation ───
    std::cerr << "--- Wave 2: tempo / meter / metronome / nav ---\n";
    {
        auto sess = [&] { return ops.snapshot().getProperty ("session", var()); };

        // Tempo control.
        check (ok (cmd (ops, "set_tempo", args1 ("bpm", 140.0))), "set_tempo ok");
        check (std::abs ((double) sess().getProperty ("tempo", 0.0) - 140.0) < 0.5, "snapshot tempo reflects set_tempo");
        cmd (ops, "set_tempo", args1 ("bpm", 99999.0));
        check ((double) sess().getProperty ("tempo", 0.0) <= 999.0, "set_tempo clamps absurd BPM to <= 999");

        // Time signature.
        check (ok (cmd (ops, "set_time_signature", objN ({{ "numerator", 3 }, { "denominator", 4 }}))), "set_time_signature ok");
        check ((int) sess().getProperty ("timeSigNumerator", 0) == 3, "snapshot numerator == 3");
        check ((int) sess().getProperty ("timeSigDenominator", 0) == 4, "snapshot denominator == 4");
        check (! ok (cmd (ops, "set_time_signature", objN ({{ "numerator", 4 }, { "denominator", 5 }}))), "set_time_signature rejects non-power-of-two denominator");

        // Metronome toggle.
        cmd (ops, "set_metronome", args1 ("enabled", true));
        check ((bool) sess().getProperty ("metronome", false), "metronome enabled in snapshot");
        cmd (ops, "set_metronome", args1 ("enabled", false));
        check (! (bool) sess().getProperty ("metronome", true), "metronome disabled in snapshot");

        // Navigation: go-to-end / go-to-start.
        const double len = (double) sess().getProperty ("length", 0.0);
        cmd (ops, "set_transport", args1 ("action", "to_end"));
        const double endPos = (double) ops.snapshot()["transport"].getProperty ("position", -1.0);
        check (len > 0.0 && std::abs (endPos - len) < 0.05, "to_end moves the playhead to the edit length");
        cmd (ops, "set_transport", args1 ("action", "to_start"));
        check ((double) ops.snapshot()["transport"].getProperty ("position", -1.0) < 0.01, "to_start returns the playhead to 0");

        // Leave a clean musical default for later stages.
        cmd (ops, "set_tempo", args1 ("bpm", 120.0));
        cmd (ops, "set_time_signature", objN ({{ "numerator", 4 }, { "denominator", 4 }}));
    }

    // ─── Wave 5: mixer — master bus + pan ───
    std::cerr << "--- Wave 5: mixer / master / pan ---\n";
    {
        auto master = [&] { return ops.snapshot().getProperty ("master", var()); };
        check (master().isObject(), "snapshot exposes a master bus");

        check (ok (cmd (ops, "set_master_volume", args1 ("db", -6.0))), "set_master_volume ok");
        check (std::abs ((double) master().getProperty ("volumeDb", 0.0) - (-6.0)) < 0.5, "master volume reflects in snapshot");
        check (ok (cmd (ops, "set_master_pan", args1 ("pan", -0.5))), "set_master_pan ok");
        check (std::abs ((double) master().getProperty ("pan", 0.0) - (-0.5)) < 0.02, "master pan reflects in snapshot");

        // Per-track pan (set_track_pan existed but was never covered).
        check (ok (cmd (ops, "set_track_pan", objN ({{ "trackId", tid }, { "pan", 0.4 }}))), "set_track_pan ok");
        check (std::abs ((double) trackById (tid).getProperty ("pan", 0.0) - 0.4) < 0.02, "track pan reflects in snapshot");

        cmd (ops, "set_master_volume", args1 ("db", -3.0));   // restore a sane default
    }

    // ─── Wave 6: clip editing (delete / rename / mute / gain / duplicate) ───
    std::cerr << "--- Wave 6: clip editing ---\n";
    {
        auto clipById = [&] (const String& cid) -> var {
            auto snap = ops.snapshot();
            if (auto* tracks = snap["tracks"].getArray())
                for (auto& tr : *tracks)
                    if (auto* clips = tr.getProperty ("clips", var()).getArray())
                        for (auto& c : *clips)
                            if (c.getProperty ("id", var()).toString() == cid) return c;
            return {};
        };

        auto et = cmd (ops, "create_track", args1 ("name", "Edit"))["data"].getProperty ("trackId", var()).toString();
        auto cid = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", et }, { "seconds", 1.0 }, { "freq", 330.0 }}))["data"].getProperty ("clipId", var()).toString();
        check (cid.isNotEmpty(), "tone clip created for editing");

        check (ok (cmd (ops, "rename_clip", objN ({{ "clipId", cid }, { "name", "Renamed" }}))), "rename_clip ok");
        check (clipById (cid).getProperty ("name", var()).toString() == "Renamed", "clip name reflects rename");

        check (ok (cmd (ops, "set_clip_mute", objN ({{ "clipId", cid }, { "mute", true }}))), "set_clip_mute ok");
        check ((bool) clipById (cid).getProperty ("mute", false), "clip mute reflects in snapshot");

        check (ok (cmd (ops, "set_clip_gain", objN ({{ "clipId", cid }, { "gainDb", 6.0 }}))), "set_clip_gain ok");
        check (std::abs ((double) clipById (cid).getProperty ("gainDb", 0.0) - 6.0) < 0.5, "clip gain reflects in snapshot");

        const int before = trackById (et).getProperty ("clips", var()).size();
        auto dup = cmd (ops, "duplicate_clip", args1 ("clipId", cid));
        check (ok (dup), "duplicate_clip ok");
        check (trackById (et).getProperty ("clips", var()).size() == before + 1, "duplicate adds a clip to the track");
        const auto newId = dup["data"].getProperty ("newClipId", var()).toString();
        check ((double) clipById (newId).getProperty ("start", 0.0) > 0.5, "duplicate lands after the original");

        check (ok (cmd (ops, "remove_clip", args1 ("clipId", cid))), "remove_clip ok");
        check (! clipById (cid).isObject(), "remove_clip deletes the clip");
    }

    // ─── Wave 7: parameter automation ───
    std::cerr << "--- Wave 7: parameter automation ---\n";
    {
        auto paramVar = [&] (const String& trkId, int plugIdx, int paramIdx) -> var {
            auto trk = trackById (trkId);
            if (auto* plugins = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *plugins)
                    if ((int) p.getProperty ("index", -1) == plugIdx)
                        if (auto* params = p.getProperty ("params", var()).getArray())
                            for (auto& pr : *params)
                                if ((int) pr.getProperty ("index", -1) == paramIdx) return pr;
            return {};
        };

        auto at = cmd (ops, "create_track", args1 ("name", "Auto"))["data"].getProperty ("trackId", var()).toString();
        cmd (ops, "load_builtin", objN ({{ "trackId", at }, { "type", "compressor" }}));
        int pidx = -1;
        { auto trk = trackById (at);
          if (auto* plugins = trk.getProperty ("plugins", var()).getArray())
            for (auto& p : *plugins) if (p.getProperty ("type", var()).toString() == "compressor") pidx = (int) p.getProperty ("index", -1); }
        check (pidx >= 0, "compressor loaded for automation");

        check (ok (cmd (ops, "add_automation_point", objN ({{ "trackId", at }, { "pluginIndex", pidx }, { "paramIndex", 0 }, { "time", 0.0 }, { "value", 0.2 }}))), "add_automation_point ok");
        check (ok (cmd (ops, "add_automation_point", objN ({{ "trackId", at }, { "pluginIndex", pidx }, { "paramIndex", 0 }, { "time", 2.0 }, { "value", 0.8 }}))), "second automation point ok");
        check (paramVar (at, pidx, 0).getProperty ("points", var()).size() == 2, "snapshot serialises 2 automation points");
        check ((bool) paramVar (at, pidx, 0).getProperty ("automated", false), "param flagged automated");
        { auto pts = paramVar (at, pidx, 0).getProperty ("points", var());
          check (pts.size() == 2 && std::abs ((double) pts[0].getProperty ("v", 0.0) - 0.2) < 0.03
                 && std::abs ((double) pts[1].getProperty ("v", 0.0) - 0.8) < 0.03, "automation point values round-trip 0..1"); }

        check (ok (cmd (ops, "set_automation_point", objN ({{ "trackId", at }, { "pluginIndex", pidx }, { "paramIndex", 0 }, { "pointIndex", 0 }, { "time", 0.5 }, { "value", 0.5 }}))), "set_automation_point ok");
        check (ok (cmd (ops, "remove_automation_point", objN ({{ "trackId", at }, { "pluginIndex", pidx }, { "paramIndex", 0 }, { "pointIndex", 0 }}))), "remove_automation_point ok");
        check (paramVar (at, pidx, 0).getProperty ("points", var()).size() == 1, "remove drops an automation point");

        check (ok (cmd (ops, "clear_automation", objN ({{ "trackId", at }, { "pluginIndex", pidx }, { "paramIndex", 0 }}))), "clear_automation ok");
        check (! (bool) paramVar (at, pidx, 0).getProperty ("automated", true), "clear_automation removes all points");
    }

    // ─── Wave 1: engine built-in plugin palette (effects + instruments) ───
    std::cerr << "--- Wave 1: built-in plugin palette ---\n";
    {
        auto builtinIndex = [&] (const var& track, const char* type) -> int {
            if (auto* arr = track.getProperty ("plugins", var()).getArray())
                for (auto& p : *arr)
                    if (p.getProperty ("type", var()).toString() == type) return (int) p.getProperty ("index", -1);
            return -1;
        };

        auto lb = cmd (ops, "list_builtins");
        check (ok (lb), "list_builtins ok");
        const int nB = lb["data"].getProperty ("plugins", var()).size();
        check (nB >= 10, "built-in palette has the full catalog");
        bool sawComp = false, sawSynth = false;
        if (auto* arr = lb["data"].getProperty ("plugins", var()).getArray())
            for (auto& p : *arr)
            {
                if (p.getProperty ("type", var()).toString() == "compressor") sawComp = true;
                if (p.getProperty ("type", var()).toString() == "4osc"
                    && (bool) p.getProperty ("isInstrument", false)) sawSynth = true;
            }
        check (sawComp, "catalog includes compressor (effect)");
        check (sawSynth, "catalog includes 4osc (instrument)");

        auto bt = cmd (ops, "create_track", args1 ("name", "Built-ins"))["data"].getProperty ("trackId", var()).toString();

        // Effect: a built-in compressor lands in the chain, flagged + categorised.
        check (ok (cmd (ops, "load_builtin", objN ({{ "trackId", bt }, { "type", "compressor" }}))), "load_builtin (compressor) ok");
        int cidx = builtinIndex (trackById (bt), "compressor");
        check (cidx >= 0, "compressor appears in the chain");
        bool compFlagged = false, compCategorised = false;
        { auto trk = trackById (bt);
          if (auto* arr = trk.getProperty ("plugins", var()).getArray())
            for (auto& p : *arr) if ((int) p.getProperty ("index", -1) == cidx)
            { compFlagged = (bool) p.getProperty ("builtin", false);
              compCategorised = p.getProperty ("category", var()).toString() == "Dynamics"; } }
        check (compFlagged, "built-in plugin flagged builtin=true in snapshot");
        check (compCategorised, "built-in plugin carries its category");
        if (cidx >= 0)
            check (ok (cmd (ops, "set_plugin_param", objN ({{ "trackId", bt }, { "index", cidx }, { "paramIndex", 0 }, { "value", 0.5 }}))),
                   "set_plugin_param on a built-in ok");

        // Instrument: a built-in synth on the same track is flagged isInstrument.
        check (ok (cmd (ops, "load_builtin", objN ({{ "trackId", bt }, { "type", "4osc" }}))), "load_builtin (4osc synth) ok");
        bool hasBuiltinInst = false;
        { auto trk = trackById (bt);
          if (auto* arr = trk.getProperty ("plugins", var()).getArray())
            for (auto& p : *arr) if (p.getProperty ("type", var()).toString() == "4osc")
                hasBuiltinInst = (bool) p.getProperty ("isInstrument", false); }
        check (hasBuiltinInst, "built-in 4osc flagged as an instrument");

        // Persistence + validation.
        cmd (ops, "save"); cmd (ops, "reload");
        check (builtinIndex (trackById (bt), "compressor") >= 0, "built-in plugin persists across save/reload");
        check (! ok (cmd (ops, "load_builtin", objN ({{ "trackId", bt }, { "type", "no_such_plugin" }}))), "load_builtin rejects unknown type");
        // The scratch "Built-ins" track is left in place: the only later count
        // check in this run is relative (tracksBefore+1), and absolute-count
        // checks live in the separate runUndoSelfTest with its own fresh engine.
    }

    // ─── Stage 4: Tier-A real-time neural insert ───
    std::cerr << "--- Stage 4: Tier-A neural insert (RT-safe / PDC / ASTD) ---\n";
    {
        auto nt = cmd (ops, "create_track", args1 ("name", "Neural"))["data"].getProperty ("trackId", var()).toString();
        auto ar = cmd (ops, "add_neural_insert", objN ({{ "trackId", nt }, { "modelId", "nam" }}));
        check (ok (ar), "add_neural_insert ok");
        const int nidx = (int) ar["data"].getProperty ("index", -1);

        NeuralInsertPlugin* n = nullptr;
        if (auto* t = te::findAudioTrackForID (eng.edit(), te::EditItemID::fromString (nt)))
            for (auto* p : t->pluginList.getPlugins())
                if (auto* nn = dynamic_cast<NeuralInsertPlugin*> (p)) n = nn;
        check (n != nullptr, "neural insert is in the track chain (built-in type registered)");

        if (n != nullptr)
        {
            n->initialise ({ {}, 44100.0, 512 });   // alloc delay line + warm up

            auto process = [&] (float amp, int len) {
                AudioBuffer<float> buf (2, len); buf.clear();
                buf.setSample (0, 0, amp); buf.setSample (1, 0, amp);
                te::MidiMessageArray midi;
                te::PluginRenderContext ctx (&buf, AudioChannelSet::stereo(), 0, len, &midi, 0.0,
                                             tracktion::TimeRange(), true, false, false, false);
                n->applyToBuffer (ctx);
                return buf;
            };

            cmd (ops, "set_neural_param", objN ({{ "trackId", nt }, { "index", nidx }, { "paramId", "drive" }, { "value", 100.0 }}));
            cmd (ops, "set_neural_param", objN ({{ "trackId", nt }, { "index", nidx }, { "paramId", "mix" }, { "value", 100.0 }}));
            {
                auto out = process (0.5f, 64);
                check (std::abs (out.getSample (0, 0) - 0.5f) > 0.1f, "neural model alters the driven signal (real inference)");
                check (std::abs (out.getSample (0, 10)) < 1e-4f, "silence stays silent (no DC injected by the net)");
            }

            // Bypass: the known inverted-logic bug (04 §2.4): bypassed -> passthrough.
            cmd (ops, "bypass_plugin", objN ({{ "trackId", nt }, { "index", nidx }, { "bypassed", true }}));
            {
                auto out = process (0.5f, 64);
                check (std::abs (out.getSample (0, 0) - 0.5f) < 1e-5f, "bypass passes audio through unchanged");
            }
            cmd (ops, "bypass_plugin", objN ({{ "trackId", nt }, { "index", nidx }, { "bypassed", false }}));

            // ASTD clamp + Lab unlock (read raw via the param's normalised value).
            cmd (ops, "set_neural_param", objN ({{ "trackId", nt }, { "index", nidx }, { "paramId", "drive" }, { "value", 100.0 }}));
            const float normClamped = n->getAutomatableParameter (0)->getCurrentNormalisedValue();
            check (std::abs (normClamped - (12.0f - 1.0f) / (25.0f - 1.0f)) < 0.02f, "ASTD clamps drive UI=100 below quality-collapse (not raw max)");
            cmd (ops, "set_neural_lab_mode", objN ({{ "trackId", nt }, { "index", nidx }, { "on", true }}));
            cmd (ops, "set_neural_param", objN ({{ "trackId", nt }, { "index", nidx }, { "paramId", "drive" }, { "value", 100.0 }}));
            const float normLab = n->getAutomatableParameter (0)->getCurrentNormalisedValue();
            check (normLab > normClamped + 0.1f, "Lab mode unlocks drive beyond the clamp");
            check (std::abs (normLab - 1.0f) < 0.02f, "Lab UI=100 reaches the full raw range");

            // PDC: true latency + delay-line correctness (no drift vs dry).
            n->resetModel();
            cmd (ops, "set_neural_latency", objN ({{ "trackId", nt }, { "index", nidx }, { "samples", 128 }}));
            check (std::abs (n->getLatencySeconds() - 128.0 / 44100.0) < 1e-9, "getLatencySeconds() reports the TRUE delay (PDC)");
            cmd (ops, "set_neural_param", objN ({{ "trackId", nt }, { "index", nidx }, { "paramId", "drive" }, { "value", 50.0 }}));
            {
                auto out = process (0.5f, 256);
                check (std::abs (out.getSample (0, 0)) < 1e-4f && std::abs (out.getSample (0, 64)) < 1e-4f, "no output before the reported latency");
                check (std::abs (out.getSample (0, 128)) > 0.05f, "impulse emerges at exactly the reported latency (delay == reported, no drift)");
            }
        }
    }

    // ─── Stage 5: Tier-B generative layer (FakeAdapter) ───
    std::cerr << "--- Stage 5: generative layer (FakeAdapter, full loop) ---\n";
    {
        // Fresh track + source clip for the generative flow.
        auto gt = cmd (ops, "create_track", args1 ("name", "Gen"))["data"].getProperty ("trackId", var()).toString();
        auto tone = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", gt }, { "seconds", 1.5 }, { "freq", 196.0 }}));
        const auto gcid = tone["data"].getProperty ("clipId", var()).toString();

        auto crl = cmd (ops, "create_render_layer", objN ({{ "clipId", gcid }, { "adapter", "fake" }}));
        check (ok (crl), "create_render_layer ok");

        Array<var> colors; { auto* c = new DynamicObject(); c->setProperty ("name", "grit"); c->setProperty ("value", 60); colors.add (var (c)); }
        cmd (ops, "set_render_param", objN ({{ "clipId", gcid }, { "seed", 1 }, { "nl", 0.4 }, { "colors", colors }}));

        // Render (wait inline — spawns the Python service via the job manager).
        auto r1 = cmd (ops, "render_layer", objN ({{ "clipId", gcid }, { "wait", true }}));
        check (ok (r1), "render_layer ok (service spawned, job ran)");
        check (r1["data"].getProperty ("cache", var()).toString() == "miss", "first render is a cache MISS");
        check (r1["data"].getProperty ("status", var()).toString() == "ready", "render completed -> status ready");
        // snapshot reflects the rendered layer
        bool hasArtifact = false;
        { auto trk = trackById (gt);
          if (auto* arr = trk.getProperty ("clips", var()).getArray())
            for (auto& c : *arr) if (c.getProperty ("id", var()).toString() == gcid)
                hasArtifact = (bool) c.getProperty ("renderLayer", var()).getProperty ("hasArtifact", false); }
        check (hasArtifact, "render produced a cached artifact (output.wav)");

        // Re-render with identical fingerprint -> cache HIT.
        auto r2 = cmd (ops, "render_layer", objN ({{ "clipId", gcid }, { "wait", true }}));
        check (r2["data"].getProperty ("cache", var()).toString() == "hit", "identical re-render is a cache HIT (full fingerprint)");

        // Change a param -> fingerprint changes -> cache MISS (re-render).
        cmd (ops, "set_render_param", objN ({{ "clipId", gcid }, { "seed", 2 }}));
        auto r3 = cmd (ops, "render_layer", objN ({{ "clipId", gcid }, { "wait", true }}));
        check (r3["data"].getProperty ("cache", var()).toString() == "miss", "param change -> dirty -> re-render (cache MISS)");

        // Accept -> lands as a new clip on the "Neural Renders" lane.
        const int tracksBefore = tracks (ops);
        check (ok (cmd (ops, "accept_render", args1 ("clipId", gcid))), "accept_render ok");
        check (tracks (ops) == tracksBefore + 1, "accept landed a new clip on a neural lane");
        bool laneHasClip = false;
        { auto snap = ops.snapshot();
          if (auto* arr = snap["tracks"].getArray())
            for (auto& t : *arr) if (t.getProperty ("name", var()).toString() == "Neural Renders")
                laneHasClip = trackClips (t) >= 1; }
        check (laneHasClip, "neural lane carries the accepted render");

        // JSONL records accept/reject as TASTE LABELS (05 §9).
        auto renderLogText = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        check (renderLogText.contains ("accept_render"), "JSONL records accept_render (taste label)");
        cmd (ops, "reject_render", args1 ("clipId", gcid));
        renderLogText = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        check (renderLogText.contains ("reject_render"), "JSONL records reject_render (taste label)");
    }

    // --- Stage 6: full producer loop -> export, undo/redo correct throughout ---
    std::cerr << "--- Stage 6: full producer loop + export ---\n";
    {
        // import/record -> arrange
        auto mt = cmd (ops, "create_track", args1 ("name", "Mix"))["data"].getProperty ("trackId", var()).toString();
        auto mtone = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", mt }, { "seconds", 1.0 }, { "freq", 165.0 }}));
        auto mcid = mtone["data"].getProperty ("clipId", var()).toString();
        cmd (ops, "move_clip", objN ({{ "clipId", mcid }, { "start", 0.5 }}));
        cmd (ops, "trim_clip", objN ({{ "clipId", mcid }, { "length", 0.8 }}));

        // host VST3 (if any scanned)
        String fxId2;
        { auto lp2 = cmd (ops, "list_plugins");
          if (auto* arr = lp2["data"].getProperty ("plugins", var()).getArray())
            for (auto& p : *arr) if (! (bool) p.getProperty ("isInstrument", false) && fxId2.isEmpty())
                fxId2 = p.getProperty ("id", var()).toString(); }
        if (fxId2.isNotEmpty())
            check (ok (cmd (ops, "load_plugin", objN ({{ "trackId", mt }, { "pluginId", fxId2 }}))), "host VST3 effect on the mix track");

        // Tier-A neural insert
        auto an = cmd (ops, "add_neural_insert", objN ({{ "trackId", mt }, { "modelId", "nam" }}));
        const int ni = (int) an["data"].getProperty ("index", -1);
        cmd (ops, "set_neural_param", objN ({{ "trackId", mt }, { "index", ni }, { "paramId", "drive" }, { "value", 55.0 }}));

        // generative transform (Tier B)
        cmd (ops, "create_render_layer", objN ({{ "clipId", mcid }, { "adapter", "fake" }}));
        cmd (ops, "set_render_param", objN ({{ "clipId", mcid }, { "seed", 7 }}));
        auto rr = cmd (ops, "render_layer", objN ({{ "clipId", mcid }, { "wait", true }}));
        check (ok (rr), "generative transform rendered");
        cmd (ops, "accept_render", args1 ("clipId", mcid));

        // mix
        cmd (ops, "set_track_volume", objN ({{ "trackId", mt }, { "db", -4.0 }}));

        // export
        auto exp = cmd (ops, "export_audio", objN ({{ "file", "" }}));
        check (ok (exp), "export_audio ok");
        const auto exportFile = exp["data"].getProperty ("file", var()).toString();
        check (File (exportFile).existsAsFile() && (juce::int64) exp["data"].getProperty ("bytes", 0) > 1000,
               "export produced a non-empty WAV (full producer loop)");

        check (std::abs ((double) trackById (mt).getProperty ("volumeDb", 0.0) + 4.0) < 0.5, "mix volume applied (-4 dB)");

        // undo/redo correct throughout (a clean undoable op after the full loop)
        cmd (ops, "rename_track", objN ({{ "trackId", mt }, { "name", "Master Bus" }}));
        check (trackById (mt).getProperty ("name", var()).toString() == "Master Bus", "rename applied");
        cmd (ops, "undo");
        check (trackById (mt).getProperty ("name", var()).toString() == "Mix", "undo reverted the rename");
        cmd (ops, "redo");
        check (trackById (mt).getProperty ("name", var()).toString() == "Master Bus", "redo restored the rename");
    }

    std::cerr << "--- Serum render compatibility (optional local plugin gate) ---\n";
    if (File ("/Library/Audio/Plug-Ins/VST3/Serum2.vst3").exists())
    {
        String serumId;
        {
            auto lpSerum = cmd (ops, "list_plugins");
            if (auto* arr = lpSerum["data"].getProperty ("plugins", var()).getArray())
                for (auto& p : *arr)
                    if (p.getProperty ("name", var()).toString() == "Serum 2"
                        && p.getProperty ("manufacturer", var()).toString() == "Xfer Records"
                        && (bool) p.getProperty ("isInstrument", false))
                    {
                        serumId = p.getProperty ("id", var()).toString();
                        break;
                    }
        }
        check (serumId.isNotEmpty(), "Serum 2 VST3 is discoverable by exact name/manufacturer");

        if (serumId.isNotEmpty())
        {
            auto serumTrack = cmd (ops, "create_track", args1 ("name", "Serum Probe"))["data"].getProperty ("trackId", var()).toString();
            check (ok (cmd (ops, "add_midi_clip", objN ({{ "trackId", serumTrack }, { "length", 1.0 }}))), "Serum probe MIDI clip added");
            auto loadSerum = cmd (ops, "load_plugin", objN ({{ "trackId", serumTrack }, { "pluginId", serumId }}));
            check (ok (loadSerum), "Serum 2 loaded by exact plugin id");
            const int serumIndex = (int) loadSerum["data"].getProperty ("index", -1);

            bool hasMetadata = false;
            {
                auto trk = trackById (serumTrack);
                if (auto* arr = trk.getProperty ("plugins", var()).getArray())
                    for (auto& p : *arr)
                        if ((int) p.getProperty ("index", -1) == serumIndex)
                        {
                            hasMetadata = p.hasProperty ("manufacturer")
                                          && p.hasProperty ("file")
                                          && p.hasProperty ("identifier")
                                          && p.hasProperty ("numInputs")
                                          && p.hasProperty ("numOutputs")
                                          && p.hasProperty ("isNonRealtime")
                                          && p.getProperty ("manufacturer", var()).toString() == "Xfer Records"
                                          && p.getProperty ("file", var()).toString().contains ("Serum2.vst3");
                        }
            }
            check (hasMetadata, "snapshot exposes hosted Serum metadata and realtime diagnostics");

            auto autoFile = eng.sessionDir().getChildFile ("exports").getChildFile ("serum-auto.wav");
            auto fastFile = eng.sessionDir().getChildFile ("exports").getChildFile ("serum-fast.wav");
            auto autoExport = cmd (ops, "export_audio", objN ({{ "file", autoFile.getFullPathName() }, { "renderMode", "auto" }}));
            check (ok (autoExport), "Serum auto export ok");
            check (autoExport["data"].getProperty ("renderMode", var()).toString() == "realtime",
                   "Serum auto export selects realtime render mode");
            check (autoExport["data"].getProperty ("renderModeReason", var()).toString().contains ("Serum"),
                   "Serum auto export reports the compatibility reason");

            auto fastExport = cmd (ops, "export_audio", objN ({{ "file", fastFile.getFullPathName() }, { "renderMode", "fast" }}));
            check (ok (fastExport), "explicit fast export remains available with Serum");
            check (fastExport["data"].getProperty ("renderMode", var()).toString() == "fast",
                   "explicit fast export reports fast render mode");
        }
    }
    else
    {
        std::cerr << "  ..   (Serum2.vst3 not installed — skipping Serum-specific local gate)\n";
    }

    // --- Stage 5 (SA3): the real StableAudio3Adapter - GATED on MOSH_SELFTEST_SA3 ---
    // (separate from MOSH_ENABLE_SA3, which now defaults on: real model + judge QA is
    //  ~30s, too heavy for the default --selftest. Opt in explicitly to exercise it.)
    if (SystemStats::getEnvironmentVariable ("MOSH_SELFTEST_SA3", "0") == "1")
    {
        std::cerr << "--- Stage 5 (SA3): real Stable Audio 3 backend ---\n";
        // /colors handshake
        auto lc = cmd (ops, "list_colors");
        const int nColors = lc["data"].getProperty ("colors", var()).size();
        check (ok (lc) && nColors > 0, "list_colors returns the SA3 colour rack");

        auto st = cmd (ops, "create_track", args1 ("name", "SA3"))["data"].getProperty ("trackId", var()).toString();
        auto tn = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", st }, { "seconds", 2.0 }, { "freq", 110.0 }}));
        const auto scid = tn["data"].getProperty ("clipId", var()).toString();

        auto crl = cmd (ops, "create_render_layer", objN ({{ "clipId", scid },
            { "adapter", "stable_audio3" }, { "mode", "reimagine" }, { "modelVariant", "sa3-medium" }}));
        const auto layerId = crl["data"].getProperty ("layerId", var()).toString();
        check (ok (crl), "create_render_layer (stable_audio3) ok");

        Array<var> gcolors; { auto* c = new DynamicObject(); c->setProperty ("name", "grit"); c->setProperty ("value", 70); gcolors.add (var (c)); }
        cmd (ops, "set_render_param", objN ({{ "clipId", scid }, { "seed", 5 }, { "nl", 0.45 }, { "colors", gcolors }}));

        std::cerr << "  ..   rendering with SA3 (model load + inference; ~10s first time)...\n";
        auto r1 = cmd (ops, "render_layer", objN ({{ "clipId", scid }, { "wait", true }}));
        check (ok (r1) && r1["data"].getProperty ("cache", var()).toString() == "miss", "SA3 render ran (cache MISS)");
        check (r1["data"].getProperty ("status", var()).toString() == "ready", "SA3 render completed -> ready");

        // The real artifact + its manifest.
        auto manifestFile = eng.sessionDir().getChildFile ("renders").getChildFile (layerId).getChildFile ("output_manifest.json");
        var mf = manifestFile.existsAsFile() ? JSON::parse (manifestFile.loadFileAsString()) : var();
        check (mf.getProperty ("adapter", var()).toString() == "stable_audio3", "manifest from the real SA3 adapter");
        check (mf.getProperty ("mode", var()).toString() == "audio_to_audio", "SA3 ran the re-imagine path");
        check (mf.getProperty ("steers", var()).size() > 0, "grit colour applied as a steering vector");

        // Cache HIT on identical re-render (full fingerprint incl. SA3 service build).
        auto r2 = cmd (ops, "render_layer", objN ({{ "clipId", scid }, { "wait", true }}));
        check (r2["data"].getProperty ("cache", var()).toString() == "hit", "identical SA3 re-render is a cache HIT");

        check (ok (cmd (ops, "accept_render", args1 ("clipId", scid))), "accept SA3 render -> lands on the neural lane");
    }
    else
        std::cerr << "  ..   (SA3 self-test skipped — set MOSH_SELFTEST_SA3=1 to exercise the real model)\n";

    // ─── Wave 4: MIDI note editing (piano-roll command surface) ───
    std::cerr << "--- Wave 4: MIDI note editing ---\n";
    {
        auto clipNotes = [&] (const String& cid) -> var {
            auto snap = ops.snapshot();
            if (auto* tracks = snap["tracks"].getArray())
                for (auto& tr : *tracks)
                    if (auto* clips = tr.getProperty ("clips", var()).getArray())
                        for (auto& c : *clips)
                            if (c.getProperty ("id", var()).toString() == cid)
                                return c.getProperty ("notes", var());
            return {};
        };

        auto mt = cmd (ops, "create_track", args1 ("name", "Notes"))["data"].getProperty ("trackId", var()).toString();
        Array<var> seed;
        for (int k = 0; k < 3; ++k)
        {
            auto* n = new DynamicObject();
            n->setProperty ("pitch", 60 + k); n->setProperty ("start", (double) k);
            n->setProperty ("length", 1.0); n->setProperty ("velocity", 90);
            seed.add (var (n));
        }
        auto* ca = new DynamicObject(); ca->setProperty ("trackId", mt); ca->setProperty ("notes", var (seed));
        const auto mClip = cmd (ops, "add_midi_clip", var (ca))["data"].getProperty ("clipId", var()).toString();
        check (clipNotes (mClip).size() == 3, "MIDI clip serialises its 3 notes into the snapshot");

        check (ok (cmd (ops, "add_note", objN ({{ "clipId", mClip }, { "pitch", 72 }, { "start", 1.4 }, { "length", 1.0 }, { "velocity", 100 }}))), "add_note ok");
        check (clipNotes (mClip).size() == 4, "add_note adds a note");

        check (ok (cmd (ops, "set_note", objN ({{ "clipId", mClip }, { "noteIndex", 0 }, { "pitch", 48 }, { "velocity", 127 }}))), "set_note ok");
        { auto ns = clipNotes (mClip);
          check (ns.size() > 0 && (int) ns[0].getProperty ("pitch", -1) == 48 && (int) ns[0].getProperty ("velocity", -1) == 127, "set_note edits pitch + velocity"); }

        check (ok (cmd (ops, "quantize_notes", objN ({{ "clipId", mClip }, { "division", 1.0 }}))), "quantize_notes ok");
        { auto ns = clipNotes (mClip); bool allOnGrid = ns.size() > 0;
          if (auto* arr = ns.getArray()) for (auto& n : *arr) {
              const double s = (double) n.getProperty ("start", 0.0);
              if (std::abs (s - std::round (s)) > 0.02) allOnGrid = false; }
          check (allOnGrid, "quantize_notes snaps every note onto the beat grid"); }

        const int before = clipNotes (mClip).size();
        check (ok (cmd (ops, "remove_note", objN ({{ "clipId", mClip }, { "noteIndex", 0 }}))), "remove_note ok");
        check (clipNotes (mClip).size() == before - 1, "remove_note removes a note");

        cmd (ops, "save"); cmd (ops, "reload");
        check (clipNotes (mClip).size() == before - 1, "notes persist across save/reload");
        check (! ok (cmd (ops, "set_note", objN ({{ "clipId", mClip }, { "noteIndex", 999 }}))), "set_note rejects an out-of-range noteIndex");
    }

    // ─── Wave 8: sends / returns / aux buses ───
    std::cerr << "--- Wave 8: sends / returns / aux buses ---\n";
    {
        auto buses  = [&] { return ops.snapshot().getProperty ("buses", var()); };
        auto sendsOf = [&] (const String& tid) -> var { return trackById (tid).getProperty ("sends", var()); };

        const int busesBefore = buses().size();
        auto cb = cmd (ops, "create_bus", args1 ("name", "Reverb"));
        check (ok (cb), "create_bus ok");
        const int bus0 = (int) cb["data"].getProperty ("busNumber", -1);
        const auto rtid = cb["data"].getProperty ("trackId", var()).toString();
        check (buses().size() == busesBefore + 1, "snapshot lists the new bus");
        check ((bool) trackById (rtid).getProperty ("isReturn", false), "return track flagged isReturn");
        check ((int) trackById (rtid).getProperty ("returnBus", -1) == bus0, "return track carries the bus number");
        { bool hasReturn = false;
          auto rt = trackById (rtid);                          // bind to a local (no dangling temporary)
          auto pv = rt.getProperty ("plugins", var());
          if (auto* plugins = pv.getArray())
            for (auto& p : *plugins) if (p.getProperty ("type", var()).toString() == "auxreturn") hasReturn = true;
          check (hasReturn, "return track carries an auxreturn plugin"); }

        auto cb2 = cmd (ops, "create_bus", args1 ("name", "Delay"));
        check ((int) cb2["data"].getProperty ("busNumber", -1) == bus0 + 1, "second bus gets the next number");

        auto gt = cmd (ops, "create_track", args1 ("name", "Gtr"))["data"].getProperty ("trackId", var()).toString();
        check (ok (cmd (ops, "add_send", objN ({{ "trackId", gt }, { "bus", bus0 }, { "db", -6.0 }}))), "add_send ok");
        { auto s = sendsOf (gt);
          check (s.size() == 1 && (int) s[0].getProperty ("bus", -1) == bus0
                 && std::abs ((double) s[0].getProperty ("db", 0.0) - (-6.0)) < 0.6, "send appears with the right bus + dB"); }
        check (! ok (cmd (ops, "add_send", objN ({{ "trackId", gt }, { "bus", bus0 }}))), "duplicate send to a bus rejected");
        check (! ok (cmd (ops, "add_send", objN ({{ "trackId", gt }, { "bus", 99 }}))), "send to a nonexistent bus rejected");

        check (ok (cmd (ops, "set_send_level", objN ({{ "trackId", gt }, { "bus", bus0 }, { "db", -3.0 }}))), "set_send_level ok");
        check (std::abs ((double) sendsOf (gt)[0].getProperty ("db", 0.0) - (-3.0)) < 0.6, "send level reflects the new dB");
        cmd (ops, "set_send_level", objN ({{ "trackId", gt }, { "bus", bus0 }, { "db", -100.0 }}));
        check ((bool) sendsOf (gt)[0].getProperty ("mute", false), "send mutes at -100 dB");
        cmd (ops, "set_send_level", objN ({{ "trackId", gt }, { "bus", bus0 }, { "db", -6.0 }}));

        cmd (ops, "save"); cmd (ops, "reload");
        { bool found = false; auto bv = buses();              // bind to a local (no dangling temporary)
          if (auto* arr = bv.getArray()) for (auto& b : *arr) if (b.getProperty ("name", var()).toString() == "Reverb") found = true;
          check (found, "bus name persists across save/reload"); }
        check (sendsOf (gt).size() == 1, "send persists across save/reload");

        const int busesNow = buses().size();
        check (ok (cmd (ops, "remove_bus", args1 ("bus", bus0))), "remove_bus ok");
        check (buses().size() == busesNow - 1, "remove_bus drops the bus");
        check (sendsOf (gt).size() == 0, "remove_bus sweeps orphan sends");
    }

    std::cerr << "===== " << (checks - failures) << "/" << checks
              << " checks passed, " << failures << " failed =====\n\n";
    return failures;
}

int runUndoSelfTest (MoshEngine&, MoshOps& ops)
{
    using namespace juce;
    failures = 0;
    checks = 0;

    std::cerr << "\n===== Mosh focused undo harness =====\n";

    auto r = cmd (ops, "create_track", args1 ("name", "Undo Probe"));
    check (ok (r), "create_track ok");
    check (tracks (ops) == 1, "track exists after create_track");

    auto toneArgs = new DynamicObject();
    toneArgs->setProperty ("seconds", 0.25);
    toneArgs->setProperty ("freq", 220.0);
    auto rt = cmd (ops, "add_test_tone_clip", var (toneArgs));
    check (ok (rt), "add_test_tone_clip ok");
    check (trackClips (firstTrack (ops)) == 1, "clip exists after add_test_tone_clip");

    const auto clipId = firstTrack (ops)["clips"][0].getProperty ("id", var()).toString();
    check (ok (cmd (ops, "add_render_layer", args1 ("clipId", clipId))), "add_render_layer ok");
    check ((bool) firstTrack (ops)["clips"][0].getProperty ("hasRenderLayer", false), "render layer exists");

    check (ok (cmd (ops, "undo")), "undo render layer command ok");
    check (! (bool) firstTrack (ops)["clips"][0].getProperty ("hasRenderLayer", true), "undo removed render layer");
    check (ok (cmd (ops, "undo")), "undo clip command ok");
    check (trackClips (firstTrack (ops)) == 0, "undo removed clip");
    check (ok (cmd (ops, "undo")), "undo track command ok");
    check (tracks (ops) == 0, "undo removed track");

    check (ok (cmd (ops, "redo")), "redo track command ok");
    check (tracks (ops) == 1, "redo restored track");
    check (ok (cmd (ops, "redo")), "redo clip command ok");
    check (trackClips (firstTrack (ops)) == 1, "redo restored clip");
    check (ok (cmd (ops, "redo")), "redo render layer command ok");
    check ((bool) firstTrack (ops)["clips"][0].getProperty ("hasRenderLayer", false), "redo restored render layer");

    std::cerr << "===== " << checks - failures << "/" << checks
              << " focused undo checks passed, " << failures << " failed =====\n";
    return failures;
}

int runLiveAudioSmoke (MoshEngine& eng, MoshOps& ops)
{
    using namespace juce;
    failures = 0;
    checks = 0;

    std::cerr << "\n===== Mosh live-audio smoke =====\n";

    auto& deviceManager = eng.engine().getDeviceManager().deviceManager;
    auto* device = deviceManager.getCurrentAudioDevice();
    check (eng.hasAudio(), "audio mode is enabled");
    check (eng.audioDeviceError().isEmpty(), "requested audio device opened");
    check (device != nullptr, "JUCE audio device is open");

    const auto requested = SystemStats::getEnvironmentVariable ("MOSH_AUDIO_OUTPUT_DEVICE", {}).trim();
    const auto requestedInput = SystemStats::getEnvironmentVariable ("MOSH_AUDIO_INPUT_DEVICE", {}).trim();
    if (device != nullptr)
    {
        std::cerr << "  ..   device=" << device->getName()
                  << " type=" << device->getTypeName()
                  << " rate=" << device->getCurrentSampleRate()
                  << " block=" << device->getCurrentBufferSizeSamples() << "\n";

        if (requested.isNotEmpty())
            check (device->getName().equalsIgnoreCase (requested), "current output matches MOSH_AUDIO_OUTPUT_DEVICE");
    }

    auto track = cmd (ops, "create_track", args1 ("name", "Live Smoke"));
    check (ok (track), "create_track ok");
    const auto trackId = track["data"].getProperty ("trackId", var()).toString();

    check (ok (cmd (ops, "add_test_tone_clip",
                   objN ({{ "trackId", trackId }, { "seconds", 2.0 }, { "freq", 440.0 }}))),
           "add_test_tone_clip ok");

    check (ok (cmd (ops, "set_transport", args1 ("position", 0.0))), "transport seek ok");
    check (ok (cmd (ops, "set_transport", args1 ("action", "play"))), "transport play ok");
    check (eng.edit().getTransport().getCurrentPlaybackContext() != nullptr, "playback context allocated");

    LiveAudioProbe probe;
    deviceManager.addAudioCallback (&probe);

    auto* mm = MessageManager::getInstanceWithoutCreating();
    auto smokeMs = SystemStats::getEnvironmentVariable ("MOSH_LIVE_AUDIO_SMOKE_MS", "3500").getIntValue();
    smokeMs = jlimit (500, 15000, smokeMs);
    const auto end = Time::getMillisecondCounter() + (uint32) smokeMs;
    while (Time::getMillisecondCounter() < end)
    {
        if (mm != nullptr) mm->runDispatchLoopUntil (50);
        else Thread::sleep (50);
    }

    deviceManager.removeAudioCallback (&probe);
    check (probe.getCallbackCount() > 0, "live-audio probe callback ran");
    check (probe.getSampleCount() > 0, "live-audio probe observed audio frames");
    check (probe.getWrittenSampleCount() > 0, "live-audio probe had writable output channels");
    if (requestedInput.isNotEmpty())
    {
        check (probe.getInputSampleCount() > 0, "live-audio probe observed input frames");
        check (probe.getInputNonSilentSampleCount() > 0, "live-audio probe captured loopback input");
    }
    check (ok (cmd (ops, "set_transport", args1 ("action", "stop"))), "transport stop ok");

    std::cerr << "===== " << checks - failures << "/" << checks
              << " live-audio checks passed, " << failures << " failed =====\n";
    return failures;
}

void runPluginDemo (MoshOps& ops)
{
    using namespace juce;
    auto cmd = [&] (const String& n, var a = var()) {
        auto* c = new DynamicObject(); c->setProperty ("command", n);
        if (! a.isVoid()) c->setProperty ("args", a);
        return ops.execute (var (c));
    };
    auto obj = [] (std::initializer_list<std::pair<const char*, var>> kv) {
        auto* o = new DynamicObject();
        for (auto& p : kv) o->setProperty (p.first, p.second);
        return var (o);
    };

    // Find an effect + an instrument from the scan. Prefer Serum 2 for demo3
    // when present because the UI gate verifies its native editor specifically.
    String fxId, instId, fallbackInstId;
    auto lp = cmd ("list_plugins");
    if (auto* arr = lp["data"].getProperty ("plugins", var()).getArray())
        for (auto& p : *arr)
        {
            const bool isInstrument = (bool) p.getProperty ("isInstrument", false);
            const auto id = p.getProperty ("id", var()).toString();
            if (isInstrument)
            {
                if (fallbackInstId.isEmpty())
                    fallbackInstId = id;

                if (p.getProperty ("name", var()).toString() == "Serum 2"
                    && p.getProperty ("manufacturer", var()).toString() == "Xfer Records")
                    instId = id;
            }
            else if (fxId.isEmpty())
            {
                fxId = id;
            }
        }
    if (instId.isEmpty())
        instId = fallbackInstId;

    // Wave track + tone + effect.
    auto t1 = cmd ("create_track", obj ({{ "name", "Drums" }}))["data"].getProperty ("trackId", var()).toString();
    cmd ("add_test_tone_clip", obj ({{ "trackId", t1 }, { "seconds", 2.0 }, { "freq", 110.0 }}));
    if (fxId.isNotEmpty())
        cmd ("load_plugin", obj ({{ "trackId", t1 }, { "pluginId", fxId }}));

    // Synth track + MIDI + instrument, then open its native editor.
    auto t2 = cmd ("create_track", obj ({{ "name", "Synth" }}))["data"].getProperty ("trackId", var()).toString();
    cmd ("add_midi_clip", obj ({{ "trackId", t2 }}));
    if (instId.isNotEmpty())
    {
        auto r = cmd ("load_plugin", obj ({{ "trackId", t2 }, { "pluginId", instId }}));
        const int idx = (int) r["data"].getProperty ("index", -1);
        if (idx >= 0)
            cmd ("open_plugin_editor", obj ({{ "trackId", t2 }, { "index", idx }}));
    }
}

void runNeuralDemo (MoshOps& ops)
{
    using namespace juce;
    auto cmd = [&] (const String& n, var a = var()) {
        auto* c = new DynamicObject(); c->setProperty ("command", n);
        if (! a.isVoid()) c->setProperty ("args", a);
        return ops.execute (var (c));
    };
    auto obj = [] (std::initializer_list<std::pair<const char*, var>> kv) {
        auto* o = new DynamicObject();
        for (auto& p : kv) o->setProperty (p.first, p.second);
        return var (o);
    };

    auto t = cmd ("create_track", obj ({{ "name", "Guitar" }}))["data"].getProperty ("trackId", var()).toString();
    cmd ("add_test_tone_clip", obj ({{ "trackId", t }, { "seconds", 3.0 }, { "freq", 110.0 }}));
    auto r = cmd ("add_neural_insert", obj ({{ "trackId", t }, { "modelId", "nam" }}));
    const int idx = (int) r["data"].getProperty ("index", -1);
    if (idx >= 0)
    {
        cmd ("set_neural_param", obj ({{ "trackId", t }, { "index", idx }, { "paramId", "drive" }, { "value", 72.0 }}));
        cmd ("set_neural_param", obj ({{ "trackId", t }, { "index", idx }, { "paramId", "mix" }, { "value", 85.0 }}));
    }
}

void runGenerativeDemo (MoshOps& ops)
{
    using namespace juce;
    auto cmd = [&] (const String& n, var a = var()) {
        auto* c = new DynamicObject(); c->setProperty ("command", n);
        if (! a.isVoid()) c->setProperty ("args", a);
        return ops.execute (var (c));
    };
    auto obj = [] (std::initializer_list<std::pair<const char*, var>> kv) {
        auto* o = new DynamicObject();
        for (auto& p : kv) o->setProperty (p.first, p.second);
        return var (o);
    };

    auto t = cmd ("create_track", obj ({{ "name", "Vox" }}))["data"].getProperty ("trackId", var()).toString();
    auto tone = cmd ("add_test_tone_clip", obj ({{ "trackId", t }, { "seconds", 2.0 }, { "freq", 147.0 }}));
    auto cid = tone["data"].getProperty ("clipId", var()).toString();
    // SA3 render layer with a 2-colour rack (falls back to the fake render if SA3 is off).
    const bool sa3 = juce::SystemStats::getEnvironmentVariable ("MOSH_ENABLE_SA3", "0") == "1";
    cmd ("create_render_layer", obj ({{ "clipId", cid },
        { "adapter", sa3 ? "stable_audio3" : "fake" }, { "mode", "reimagine" },
        { "modelVariant", sa3 ? "sa3-medium" : "" }}));
    Array<var> colors;
    { auto* c = new DynamicObject(); c->setProperty ("name", "grit"); c->setProperty ("value", 68); colors.add (var (c)); }
    { auto* c = new DynamicObject(); c->setProperty ("name", "air");  c->setProperty ("value", 60); colors.add (var (c)); }
    cmd ("set_render_param", obj ({{ "clipId", cid }, { "seed", 1 }, { "nl", 0.42 }, { "colors", colors }}));
    // NB: the actual render_layer (which spawns the service) is left to the user
    // button - running it here would block the message thread on a TCC/service
    // prompt before the WebView paints. The full render loop is proven headless.
}

void runConsolidationDemo (MoshOps& ops)
{
    using namespace juce;
    auto cmd = [&] (const String& n, var a = var()) {
        auto* c = new DynamicObject(); c->setProperty ("command", n);
        if (! a.isVoid()) c->setProperty ("args", a);
        return ops.execute (var (c));
    };
    auto obj = [] (std::initializer_list<std::pair<const char*, var>> kv) {
        auto* o = new DynamicObject();
        for (auto& p : kv) o->setProperty (p.first, p.second);
        return var (o);
    };

    // A "Gtr" track with BOTH tiers on it: a Tier-A neural insert + a Tier-B
    // generative RenderLayer on its clip.
    auto t = cmd ("create_track", obj ({{ "name", "Gtr" }}))["data"].getProperty ("trackId", var()).toString();
    auto tone = cmd ("add_test_tone_clip", obj ({{ "trackId", t }, { "seconds", 2.5 }, { "freq", 131.0 }}));
    auto cid = tone["data"].getProperty ("clipId", var()).toString();

    auto an = cmd ("add_neural_insert", obj ({{ "trackId", t }, { "modelId", "nam" }}));
    const int idx = (int) an["data"].getProperty ("index", -1);
    if (idx >= 0)
        cmd ("set_neural_param", obj ({{ "trackId", t }, { "index", idx }, { "paramId", "drive" }, { "value", 68.0 }}));

    cmd ("create_render_layer", obj ({{ "clipId", cid }, { "adapter", "fake" }}));
    Array<var> colors; { auto* c = new DynamicObject(); c->setProperty ("name", "grit"); c->setProperty ("value", 62); colors.add (var (c)); }
    cmd ("set_render_param", obj ({{ "clipId", cid }, { "seed", 3 }, { "nl", 0.4 }, { "colors", colors }}));

    // A second track so the arrangement looks like a session.
    auto t2 = cmd ("create_track", obj ({{ "name", "Pad" }}))["data"].getProperty ("trackId", var()).toString();
    cmd ("add_test_tone_clip", obj ({{ "trackId", t2 }, { "seconds", 4.0 }, { "freq", 196.0 }}));
}

} // namespace mosh
