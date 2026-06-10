#include "SelfTest.h"
#include "engine/MoshEngine.h"
#include "moshops/MoshOps.h"
#include "moshir/MoshIR.h"
#include "plugins/neural/NeuralInsertPlugin.h"
#include <atomic>
#include <cstdlib>
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

    // --- Stage 7: MoshIR — schema vocabulary, lowering, the §3.5 worked example,
    //     gap ledger, stochastic-seed rejection, sends/sidechain/automation ---
    {
        std::cerr << "--- Stage 7: MoshIR lowering + engine gaps ---\n";

        // Native musical-context commands first.
        check (ok (cmd (ops, "set_tempo", args1 ("bpm", 142.0))), "set_tempo 142 ok");
        check (std::abs ((double) ops.snapshot()["session"].getProperty ("tempo", 0.0) - 142.0) < 0.01,
               "snapshot tempo == 142");
        check (ok (cmd (ops, "set_time_sig", objN ({{ "numerator", 4 }, { "denominator", 4 }}))), "set_time_sig 4/4 ok");
        check (ok (cmd (ops, "set_key", objN ({{ "root", "F" }, { "scale", "minor" }}))), "set_key F minor ok");
        check (ops.snapshot()["session"].getProperty ("keyRoot", var()).toString() == "F", "snapshot keyRoot == F");

        // A tiny deterministic sample library for the resolver (asset.resolve local).
        auto libDir = eng.sessionDir().getChildFile ("selftest-library");
        libDir.createDirectory();
        auto tone = eng.generateTestTone (1.0, 55.0, "lib-808-src");
        tone.copyFileTo (libDir.getChildFile ("808-distorted-long.wav"));
        setenv ("MOSH_SAMPLE_LIBRARY", libDir.getFullPathName().toRawUTF8(), 1);

        // The spec §3.5 worked example, verbatim ops, through execute_ir.
        const auto workedExample = JSON::parse (R"json({
          "ops": [
            {"kind": "asset.resolve", "params": {"descriptor": {"text": "long distorted 808",
              "tags": ["808", "distorted", "long"]},
              "strategy": ["local", "splice", "latent_gen"]}, "out": "asset_3f9c"},
            {"kind": "track.create", "params": {"track_id": "t808", "kind": "midi", "role": "808"}},
            {"kind": "device.add", "params": {"device_id": "d808", "track_id": "t808",
              "role": "synth", "prefer": ["builtin.sampler"]}},
            {"kind": "clip.create", "params": {"clip_id": "c808a", "track_id": "t808",
              "start_bar": 1, "length_beats": 16, "kind": "midi"}},
            {"kind": "notes.add", "params": {"clip_id": "c808a", "notes": [
              {"pitch": "C1",  "start_beats": 0,  "dur_beats": 3, "vel": 110},
              {"pitch": "Eb1", "start_beats": 4,  "dur_beats": 2, "vel": 105},
              {"pitch": "C1",  "start_beats": 8,  "dur_beats": 3, "vel": 110},
              {"pitch": "F1",  "start_beats": 14, "dur_beats": 2, "vel": 115}]}},
            {"kind": "device.add", "params": {"device_id": "dsat", "track_id": "t808",
              "role": "saturator", "prefer": ["builtin.sat"]}},
            {"kind": "device.set_param", "params": {"device_id": "dsat",
              "param": "drive", "value_norm": 0.65}}
          ]
        })json");

        auto ir = cmd (ops, "execute_ir", workedExample);
        check (ok (ir), "worked example (spec 3.5): execute_ir ok");
        auto counts = ir["data"]["counts"];
        check ((int) counts.getProperty ("executed", 0) == 7, "worked example: all 7 ops executed");
        check ((int) counts.getProperty ("unsupported", -1) == 0, "worked example: 0 unsupported");
        check ((int) counts.getProperty ("failed", -1) == 0, "worked example: 0 failed");

        auto irResults = ir["data"].getProperty ("results", var());
        const auto t808 = irResults[1]["data"].getProperty ("trackId", var()).toString();
        const auto c808a = irResults[3]["data"].getProperty ("clipId", var()).toString();
        check ((int) irResults[4]["data"].getProperty ("added", 0) == 4, "notes.add placed 4 notes");

        // Engine state really changed: sampler + neural saturator on the track.
        auto t = trackById (t808);
        check (t.isObject(), "t808 bound to a real engine track");
        bool hasSampler = false, hasNeural = false;
        for (auto& pl : *t.getProperty ("plugins", var()).getArray())
        {
            const auto type = pl.getProperty ("type", var()).toString();
            if (type == "sampler") hasSampler = true;
            if (type == "moshNeuralInsert") hasNeural = true;
        }
        check (hasSampler, "device.add synth/builtin.sampler -> sampler plugin on track");
        check (hasNeural, "device.add saturator/builtin.sat -> Tier-A neural insert (the house saturator)");

        // notes.* second wave: transpose / quantize / seeded humanize via IR.
        auto wave2 = JSON::parse (R"json({
          "ops": [
            {"kind": "notes.transpose", "params": {"clip_id": "c808a", "semitones": 2}},
            {"kind": "notes.quantize",  "params": {"clip_id": "c808a", "grid": "1/16", "strength": 1.0}},
            {"kind": "notes.humanize",  "params": {"clip_id": "c808a", "timing_ms": 8, "vel_var": 6, "seed": 1234}}
          ]})json");
        auto ir2 = cmd (ops, "execute_ir", wave2);
        check (ok (ir2) && (int) ir2["data"]["counts"].getProperty ("executed", 0) == 3,
               "notes.transpose/quantize/humanize(seeded) all executed");

        // Stochastic contract: unseeded humanize and unseeded latent are REJECTED
        // (validate failure — not ledgered, not defaulted).
        auto unseeded = JSON::parse (R"json({
          "ops": [
            {"kind": "notes.humanize", "params": {"clip_id": "c808a", "timing_ms": 8, "vel_var": 6}},
            {"kind": "latent.generate", "params": {"prompt": "dark pad", "duration_beats": 8}}
          ]})json");
        auto ir3 = cmd (ops, "execute_ir", unseeded);
        check (! ok (ir3) && (int) ir3["data"]["counts"].getProperty ("failed", 0) == 2,
               "unseeded stochastic ops hard-rejected (no default seed)");

        // Gap ledger: project.set_swing is a documented engine gap -> Unsupported,
        // appended to the ledger, and NOT a hard failure of the batch.
        auto swing = JSON::parse (R"json({"ops": [{"kind": "project.set_swing", "params": {"amount": 0.2}}]})json");
        auto ir4 = cmd (ops, "execute_ir", swing);
        check (ok (ir4) && (int) ir4["data"]["counts"].getProperty ("unsupported", 0) == 1,
               "project.set_swing -> Unsupported (finding, not failure)");
        auto ledgerFile = eng.sessionDir().getChildFile ("gap-ledger.jsonl");
        check (ledgerFile.existsAsFile()
                 && ledgerFile.loadFileAsString().contains ("project.set_swing"),
               "gap ledger received the Unsupported entry");

        // Buses, sends, sidechain, automation, sections — the mixer families.
        auto wave3 = JSON::parse (R"json({
          "ops": [
            {"kind": "track.create", "params": {"track_id": "bverb", "kind": "bus", "role": "fx"}},
            {"kind": "track.create", "params": {"track_id": "tkick", "kind": "audio", "role": "drums"}},
            {"kind": "mixer.send", "params": {"track_id": "t808", "to_bus": "bverb", "db": -12}},
            {"kind": "mixer.sidechain", "params": {"src": "tkick", "dst": "t808", "amount": 0.6,
              "attack_ms": 5, "release_ms": 120, "ratio": 4}},
            {"kind": "automation.write", "params": {
              "target": {"mixer": "gain", "track_id": "t808"},
              "points": [{"pos_beats": 0, "value_norm": 0.8},
                         {"pos_beats": 8, "value_norm": 0.4, "curve": 0.5}]}},
            {"kind": "arrange.create_section", "params": {"name": "drop", "start_bar": 17, "length_bars": 16}},
            {"kind": "arrange.place", "params": {"clip_id": "c808a", "section": "drop"}},
            {"kind": "mixer.set_gain", "params": {"track_id": "t808", "db": -3.0}},
            {"kind": "mixer.set_pan", "params": {"track_id": "t808", "pan": -0.25}}
          ]})json");
        auto ir5 = cmd (ops, "execute_ir", wave3);
        check (ok (ir5) && (int) ir5["data"]["counts"].getProperty ("executed", 0) == 9,
               "bus/send/sidechain/automation/section/place/mixer ops all executed");

        // Verify routing landed: t808 gained auxsend + compressor; bverb has the return.
        t = trackById (t808);
        bool hasSend = false, hasComp = false;
        for (auto& pl : *t.getProperty ("plugins", var()).getArray())
        {
            const auto type = pl.getProperty ("type", var()).toString();
            if (type == "auxsend") hasSend = true;
            if (type == "compressor") hasComp = true;
        }
        check (hasSend, "mixer.send -> auxsend on t808");
        check (hasComp, "mixer.sidechain -> keyed compressor on t808");
        const auto bverbId = ir5["data"]["results"][0]["data"].getProperty ("trackId", var()).toString();
        String busPluginTypes;
        {
            auto bv = trackById (bverbId);
            if (auto* arr = bv.getProperty ("plugins", var()).getArray())
                for (auto& pl : *arr)
                    busPluginTypes += pl.getProperty ("type", var()).toString() + ",";
        }
        check (busPluginTypes.contains ("auxreturn"),
               "mixer.send auto-installed the auxreturn on the bus track [id=" + bverbId
                 + " plugins=" + busPluginTypes + "]");

        // arrange.place moved the clip to bar 17 (64 beats at 142 bpm ≈ 27.04 s).
        bool clipMoved = false;
        for (auto& cl : *t.getProperty ("clips", var()).getArray())
            if (cl.getProperty ("id", var()).toString() == c808a)
                clipMoved = std::abs ((double) cl.getProperty ("start", 0.0) - 64.0 * 60.0 / 142.0) < 0.05;
        check (clipMoved, "arrange.place(section drop) moved c808a to bar 17");
        check (std::abs ((double) t.getProperty ("volumeDb", 0.0) + 3.0) < 0.5, "mixer.set_gain applied (-3 dB)");

        // Sections are in the snapshot (musical context for the agent/extractor).
        check (ops.snapshot()["session"].getProperty ("sections", var()).size() == 1,
               "snapshot exposes the 'drop' section");

        // render.bounce through IR -> deterministic artifact path, asset bound.
        auto bounce = JSON::parse (R"json({"ops": [{"kind": "render.bounce", "params": {}, "out": "render_main"}]})json");
        auto ir6 = cmd (ops, "execute_ir", bounce);
        check (ok (ir6), "render.bounce executed (export_audio)");
        check (eng.sessionDir().getChildFile ("renders").getChildFile ("render_main.wav").existsAsFile(),
               "bounce artifact at the deterministic out-symbol path");

        // Bindings survive save/reload: a FRESH executor (loads bindings from the
        // edit state) must still resolve c808a after save.
        check (ok (cmd (ops, "save")), "save after IR session ok");
        {
            ir::Executor fresh (ops, eng);
            auto* a = new DynamicObject();
            a->setProperty ("ops", JSON::parse (
                R"json([{"kind": "notes.transpose", "params": {"clip_id": "c808a", "semitones": -2}}])json"));
            auto rf = fresh.executeOps (var (a));
            check (ok (rf), "fresh executor resolves persisted bindings (c808a) after save");
        }

        // Undo still flows through the one undo system after IR-driven edits.
        check (ok (cmd (ops, "undo")), "undo after IR ops ok (single undo system intact)");
    }

    // --- Stage 8: canonical state hash + replay primitives ---
    {
        std::cerr << "--- Stage 8: canonical state hash + replay primitives ---\n";

        auto projNow = [&]() {
            return cmd (ops, "get_state_hash", args1 ("projection", true))["data"]
                       .getProperty ("projection", var()).toString(); };
        auto hashNow = [&]() {
            return cmd (ops, "get_state_hash")["data"].getProperty ("hash", var()).toString(); };
        auto dumpOnMismatch = [&] (const String& a, const String& b, const String& tag)
        {
            if (a == b) return;
            eng.sessionDir().getChildFile ("proj-" + tag + "-before.txt").replaceWithText (a);
            eng.sessionDir().getChildFile ("proj-" + tag + "-after.txt").replaceWithText (b);
            std::cerr << "  ..   projection diff dumped: proj-" << tag << "-{before,after}.txt\n";
        };

        const auto h0 = hashNow();
        const auto p0 = projNow();
        check (h0.length() == 64, "state hash is a SHA256 hex digest");
        check (hashNow() == h0, "hash is stable across repeated reads");

        // Undo-restores-hash uses a TREE-state op: parameter moves (faders)
        // follow DAW semantics and are not undo transactions in the engine.
        const auto firstTrackId = ops.snapshot()["tracks"][0].getProperty ("id", var()).toString();
        const auto priorName = ops.snapshot()["tracks"][0].getProperty ("name", var()).toString();
        cmd (ops, "rename_track", objN ({{ "trackId", firstTrackId }, { "name", priorName + " X" }}));
        const auto h1 = hashNow();
        check (h1 != h0, "a mutation changes the hash");
        cmd (ops, "undo");
        dumpOnMismatch (p0, projNow(), "undo");
        check (hashNow() == h0, "undo restores the prior hash (one undo system)");

        check (ok (cmd (ops, "save")), "save before reload-stability check");
        cmd (ops, "reload");
        dumpOnMismatch (p0, projNow(), "reload");
        check (hashNow() == h0, "hash survives save/reload (canonical projection)");

        // Stochastic primitive: generate_asset requires a seed, full stop.
        auto ga = cmd (ops, "generate_asset", objN ({{ "prompt", "x" },
            { "file", eng.sessionDir().getChildFile ("renders/unseeded.wav").getFullPathName() }}));
        check (! ok (ga) && ga.getProperty ("error", var()).toString().contains ("seed"),
               "generate_asset without seed -> hard error (no default seed)");
    }

    // --- Stage 9: op logger / session recorder + tutorial marker ---
    {
        std::cerr << "--- Stage 9: session recorder + trajectory + markers ---\n";

        auto trajFile = eng.sessionDir().getChildFile ("trajectory.jsonl");
        check (trajFile.existsAsFile(), "trajectory.jsonl exists (recorder always on)");

        StringArray lines;
        trajFile.readLines (lines);
        lines.removeEmptyStrings();
        auto header = JSON::parse (lines[0]);
        check (header.getProperty ("type", var()).toString() == "session"
                 && header.getProperty ("ir_version", var()).toString() == "0.1",
               "header line carries session + ir_version");
        check (header.getProperty ("actor", var()).getProperty ("uuid", var()).toString().isNotEmpty(),
               "header carries the actor identity");
        check (! (bool) header.getProperty ("consent", true),
               "consent defaults to FALSE (corpus entry is opt-in)");

        auto lastLine = [&]() {
            StringArray ls; trajFile.readLines (ls); ls.removeEmptyStrings();
            return JSON::parse (ls[ls.size() - 1]); };

        // A native mutation records a step with lifted IR + state hash.
        cmd (ops, "create_track", args1 ("name", "Recorded"));
        auto step = lastLine();
        check (step.getProperty ("type", var()).toString() == "step"
                 && step.getProperty ("command", var()).toString() == "create_track",
               "native mutation recorded as a step");
        check (step.getProperty ("ir", var())[0].getProperty ("kind", var()).toString() == "track.create",
               "step carries the LIFTED IR op (track.create)");
        check (step.getProperty ("state_hash_after", var()).toString().length() == 64,
               "step carries state_hash_after");

        // execute_ir records the IR verbatim, ONCE (no double-record of the
        // lowered sub-commands — depth-0 observation).
        StringArray before; trajFile.readLines (before); before.removeEmptyStrings();
        cmd (ops, "execute_ir", JSON::parse (
            R"json({"ops": [{"kind": "project.set_tempo", "params": {"bpm": 96}}]})json"));
        StringArray after; trajFile.readLines (after); after.removeEmptyStrings();
        check (after.size() == before.size() + 1, "execute_ir = exactly ONE new step (no double-record)");
        auto irStep = JSON::parse (after[after.size() - 1]);
        check (irStep.getProperty ("ir", var())[0].getProperty ("kind", var()).toString() == "project.set_tempo",
               "execute_ir step carries the IR ops verbatim");
        cmd (ops, "set_tempo", args1 ("bpm", 142.0));    // restore stage-7 tempo

        // Tutorial binding + marker + friction note → gap ledger.
        check (ok (cmd (ops, "set_tutorial", args1 ("url", "https://youtu.be/test123"))), "set_tutorial ok");
        check (ok (cmd (ops, "drop_marker", objN ({{ "videoTs", 272.0 },
            { "note", "selftest friction: no half-time device" }}))), "drop_marker ok");
        auto marker = lastLine();
        check (marker.getProperty ("type", var()).toString() == "marker"
                 && (double) marker.getProperty ("video_ts", 0.0) == 272.0
                 && (juce::int64) marker.getProperty ("op_seq", 0) > 0,
               "marker binds (op_seq <-> video_ts)");
        check (eng.sessionDir().getChildFile ("gap-ledger.jsonl").loadFileAsString()
                   .contains ("selftest friction"),
               "friction note appended to the gap ledger");

        // Consent flip is recorded AND persisted to the identity file.
        check (ok (cmd (ops, "set_consent", args1 ("consent", true))), "set_consent ok");
        check ((bool) lastLine().getProperty ("consent", false), "consent change recorded");
        auto idFile = File (SystemStats::getEnvironmentVariable ("MOSH_IDENTITY_FILE", {}));
        check (idFile.existsAsFile()
                 && (bool) JSON::parse (idFile.loadFileAsString()).getProperty ("consent", false),
               "identity file persisted the consent flip (isolated from the user's real one)");
    }

    // --- Stage 11: Monster v0 — agent_propose through the app + service ---
    {
        std::cerr << "--- Stage 11: Monster v0 (mock provider, zero spend) ---\n";

        // Proposal: instruction -> validated MoshIR via /agent/propose.
        auto p = cmd (ops, "agent_propose", objN ({{ "instruction", "8-bar trap drums at 142 with kick and hats" },
                                                   { "provider", "mock" }}));
        check (ok (p), "agent_propose ok (service round-trip)");
        auto agentOps = p["data"].getProperty ("ops", var());
        check (agentOps.isArray() && agentOps.size() >= 3, "proposal carries MoshIR ops");
        check (p["data"].getProperty ("program_version", var()).toString().isNotEmpty(),
               "proposal is program-version-pinned");

        // Execute the proposal through the ONE mutation path, attributed.
        auto* irArgs = new DynamicObject();
        irArgs->setProperty ("ops", agentOps);
        irArgs->setProperty ("actor", "monster");
        auto run = cmd (ops, "execute_ir", var (irArgs));
        check (ok (run), "monster's ops execute via execute_ir");
        check ((int) run["data"]["counts"].getProperty ("executed", 0) >= 3,
               "monster's ops actually executed");

        // The step is in the trajectory with the monster attribution.
        StringArray lines;
        eng.sessionDir().getChildFile ("trajectory.jsonl").readLines (lines);
        lines.removeEmptyStrings();
        bool attributed = false;
        for (int i = lines.size(); --i >= 0 && ! attributed;)
            if (auto rec = JSON::parse (lines[i]);
                rec.getProperty ("command", var()).toString() == "execute_ir")
                attributed = rec.getProperty ("args", var())
                                .getProperty ("actor", var()).toString() == "monster";
        check (attributed, "trajectory step carries createdBy=monster attribution");

        // Failure shape: a missing instruction is a clean error, not a crash.
        check (! ok (cmd (ops, "agent_propose", args1 ("provider", "mock"))),
               "agent_propose without instruction -> clean error");
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

    // --- Stage 14: playable-instrument hardening (snapshot truth + meters) ---
    {
        std::cerr << "--- Stage 14: musical snapshot + meter transparency + drum rack ---\n";
        auto t14 = cmd (ops, "create_track", args1 ("name", "Rack14"));
        const auto t14id = t14["data"].getProperty ("trackId", var()).toString();

        // One sampler, two key-ranged pads (the drum-rack convention).
        auto lb = cmd (ops, "load_builtin_plugin", objN ({{ "trackId", t14id }, { "type", "sampler" }}));
        check (ok (lb), "rack sampler loads");
        const int samplerIdx = (int) lb["data"].getProperty ("index", -1);
        check (samplerIdx == 0, "sampler lands at VISIBLE index 0 (meter tap occupies no index)");
        auto pad = eng.generateTestTone (0.2, 200.0, "pad14");
        check (ok (cmd (ops, "add_sampler_sound", objN ({{ "trackId", t14id }, { "index", samplerIdx },
                        { "file", pad.getFullPathName() }, { "keyNote", 26 }, { "minNote", 26 }, { "maxNote", 26 }}))),
               "pad 1 (key-ranged) loads");
        check (ok (cmd (ops, "add_sampler_sound", objN ({{ "trackId", t14id }, { "index", samplerIdx },
                        { "file", pad.getFullPathName() }, { "keyNote", 28 }, { "minNote", 28 }, { "maxNote", 28 }}))),
               "pad 2 (key-ranged) loads");

        auto mc14 = cmd (ops, "add_midi_clip", objN ({{ "trackId", t14id }, { "name", "pat14" },
                        { "start", 0.0 }, { "length", 2.0 }, { "notes", Array<var>() }}));
        const auto c14 = mc14["data"].getProperty ("clipId", var()).toString();
        Array<var> n14; { auto* n = new DynamicObject(); n->setProperty ("pitch", 26);
            n->setProperty ("startBeats", 0.0); n->setProperty ("durBeats", 0.25); n->setProperty ("vel", 96); n14.add (var (n)); }
        check (ok (cmd (ops, "add_notes", objN ({{ "clipId", c14 }, { "notes", n14 }}))), "step note lands");

        auto snap14 = ops.snapshot();
        check (snap14["session"].hasProperty ("timeSigNumerator"), "snapshot carries time signature");
        check (snap14["session"].hasProperty ("audioOutputDevice"), "snapshot carries the audio output device");
        var rackTrack;
        for (auto& tv : *snap14["tracks"].getArray())
            if (tv.getProperty ("id", var()).toString() == t14id) rackTrack = tv;
        bool meterListed = false;
        var samplerVar;
        for (auto& pv : *rackTrack["plugins"].getArray())
        {
            if (pv.getProperty ("type", var()).toString() == "level") meterListed = true;
            if (pv.getProperty ("sounds", var()).isArray()) samplerVar = pv;
        }
        check (! meterListed, "meter tap is invisible in the snapshot rack");
        check (samplerVar.getProperty ("sounds", var()).size() == 2, "snapshot lists both sampler pads");
        check ((int) samplerVar["sounds"][0].getProperty ("keyNote", 0) == 26, "pad key mapping in snapshot");
        var clipVar = rackTrack["clips"][0];
        check (clipVar.getProperty ("notes", var()).size() == 1, "MIDI clip notes ride the snapshot");
        check ((int) clipVar["notes"][0].getProperty ("pitch", 0) == 26, "note pitch round-trips");

        // The rack's remove-then-add step cycle (what a sequencer click does).
        check (ok (cmd (ops, "remove_notes", objN ({{ "clipId", c14 }, { "pitches", Array<var> (var (26)) },
                        { "rangeStartBeats", -0.001 }, { "rangeLengthBeats", 0.002 }}))), "step toggle removes");
        auto snap15 = ops.snapshot();
        for (auto& tv : *snap15["tracks"].getArray())
            if (tv.getProperty ("id", var()).toString() == t14id) rackTrack = tv;
        check (rackTrack["clips"][0].getProperty ("notes", var()).size() == 0, "step removal lands in the snapshot");

        check (ok (cmd (ops, "remove_track", args1 ("trackId", t14id))), "rack track cleanup");
    }

    // --- Stage 15: real-DAW basics (metronome/master/duplicate/move/choose) ---
    {
        std::cerr << "--- Stage 15: real-DAW basics ---\n";

        // Metronome: flips the engine click flag, never undoable, never recorded.
        check (ok (cmd (ops, "set_metronome", objN ({{ "on", true }, { "gain", 0.8 }}))), "set_metronome on");
        check (eng.edit().clickTrackEnabled.get(), "click track enabled in the engine");
        check (ok (cmd (ops, "set_metronome", args1 ("on", false))), "set_metronome off");
        check (! eng.edit().clickTrackEnabled.get(), "click track disabled");

        // Master volume: round-trips + rides the snapshot.
        check (ok (cmd (ops, "set_master_volume", args1 ("db", -4.5))), "set_master_volume ok");
        auto s15 = ops.snapshot();
        check (std::abs ((double) s15["session"].getProperty ("masterVolumeDb", 0.0) + 4.5) < 0.1,
               "masterVolumeDb in snapshot");
        check (s15["session"].hasProperty ("metronome"), "metronome state in snapshot");
        cmd (ops, "set_master_volume", args1 ("db", 0.0));

        // duplicate_clip: two clips, distinct ids, identical notes; undo removes.
        auto t15 = cmd (ops, "create_track", args1 ("name", "Dup15"));
        const auto t15id = t15["data"].getProperty ("trackId", var()).toString();
        auto mc = cmd (ops, "add_midi_clip", objN ({{ "trackId", t15id }, { "name", "src" },
                       { "start", 0.0 }, { "length", 2.0 }}));   // default 4-note arpeggio
        const auto srcClip = mc["data"].getProperty ("clipId", var()).toString();
        auto dup = cmd (ops, "duplicate_clip", args1 ("clipId", srcClip));
        check (ok (dup), "duplicate_clip ok");
        const auto dupClip = dup["data"].getProperty ("clipId", var()).toString();
        check (dupClip.isNotEmpty() && dupClip != srcClip, "duplicate has a fresh id");
        {
            auto snap = ops.snapshot();
            var trackVar;
            for (auto& tv : *snap["tracks"].getArray())
                if (tv.getProperty ("id", var()).toString() == t15id) trackVar = tv;
            check (trackVar["clips"].size() == 2, "two clips after duplicate");
            check (trackVar["clips"][0].getProperty ("notes", var()).size()
                       == trackVar["clips"][1].getProperty ("notes", var()).size(),
                   "duplicate carries the notes");
            const double srcEnd = (double) trackVar["clips"][0].getProperty ("start", 0.0)
                                + (double) trackVar["clips"][0].getProperty ("length", 0.0);
            check (std::abs ((double) trackVar["clips"][1].getProperty ("start", -1.0) - srcEnd) < 0.01,
                   "duplicate lands at the source end");
        }
        check (ok (cmd (ops, "undo")), "undo duplicate ok");
        {
            auto snap = ops.snapshot();
            var trackVar;
            for (auto& tv : *snap["tracks"].getArray())
                if (tv.getProperty ("id", var()).toString() == t15id) trackVar = tv;
            check (trackVar["clips"].size() == 1, "undo removed the duplicate");
        }

        // IR clip.duplicate lowers through the executor (gap-ledger entry retired).
        {
            Array<var> irOps;
            auto* o1 = new DynamicObject(); o1->setProperty ("kind", "clip.create");
            auto* p1 = new DynamicObject(); p1->setProperty ("clip_id", "cdup");
            p1->setProperty ("track_id", "tdup"); p1->setProperty ("start_bar", 1);
            p1->setProperty ("length_beats", 4); p1->setProperty ("kind", "midi");
            o1->setProperty ("params", var (p1)); irOps.add (var (o1));
            auto* o0 = new DynamicObject(); o0->setProperty ("kind", "track.create");
            auto* p0 = new DynamicObject(); p0->setProperty ("track_id", "tdup");
            p0->setProperty ("kind", "midi");
            o0->setProperty ("params", var (p0));
            irOps.insert (0, var (o0));
            auto* o2 = new DynamicObject(); o2->setProperty ("kind", "clip.duplicate");
            auto* p2 = new DynamicObject(); p2->setProperty ("clip_id", "cdup");
            p2->setProperty ("new_clip_id", "cdup2"); p2->setProperty ("start_bar", 3);
            o2->setProperty ("params", var (p2)); irOps.add (var (o2));
            auto r = cmd (ops, "execute_ir", args1 ("ops", irOps));
            check (ok (r), "execute_ir with clip.duplicate ok");
            auto counts = r["data"].getProperty ("counts", var());
            check ((int) counts.getProperty ("executed", 0) == 3
                       && (int) counts.getProperty ("unsupported", 0) == 0,
                   "clip.duplicate lowers (no longer a ledger gap)");
        }

        // move_track: reorders the snapshot AND changes the canonical hash.
        const auto hashBefore = cmd (ops, "get_state_hash")["data"].getProperty ("hash", var()).toString();
        check (ok (cmd (ops, "move_track", objN ({{ "trackId", t15id }, { "beforeTrackId",
                       ops.snapshot()["tracks"][0].getProperty ("id", var()) }}))), "move_track ok");
        check (ops.snapshot()["tracks"][0].getProperty ("id", var()).toString() == t15id,
               "track moved to the top of the snapshot");
        const auto hashAfter = cmd (ops, "get_state_hash")["data"].getProperty ("hash", var()).toString();
        check (hashBefore != hashAfter, "track order is canonical-hash state");

        // choose_file: env override works headless; excluded from the trajectory.
        setenv ("MOSH_CHOOSE_FILE", "/tmp/fake.wav", 1);
        auto cf = cmd (ops, "choose_file", args1 ("purpose", "test"));
        unsetenv ("MOSH_CHOOSE_FILE");
        check (ok (cf) && cf["data"].getProperty ("path", var()).toString() == "/tmp/fake.wav",
               "choose_file honours the test override");
        {
            StringArray lines;
            eng.sessionDir().getChildFile ("trajectory.jsonl").readLines (lines);
            bool leaked = false;
            for (auto& l : lines)
                if (l.contains ("choose_file") || l.contains ("set_metronome")) leaked = true;
            check (! leaked, "choose_file/set_metronome never enter the trajectory");
        }

        cmd (ops, "remove_track", args1 ("trackId", t15id));
    }

    // --- Stage 16: piano-roll edit primitive (update_notes) ---
    {
        std::cerr << "--- Stage 16: update_notes (piano roll) ---\n";
        auto t16 = cmd (ops, "create_track", args1 ("name", "PR16"));
        const auto t16id = t16["data"].getProperty ("trackId", var()).toString();
        auto mc = cmd (ops, "add_midi_clip", objN ({{ "trackId", t16id }, { "name", "pr" },
                       { "start", 0.0 }, { "length", 2.0 }}));   // arpeggio: 60/64/67/72 at beats 0..3
        const auto cid = mc["data"].getProperty ("clipId", var()).toString();

        // Move + resize + re-pitch + re-velocity the first note in ONE call.
        Array<var> edits;
        {
            auto* e = new DynamicObject();
            auto* m = new DynamicObject(); m->setProperty ("pitch", 60); m->setProperty ("startBeats", 0.0);
            auto* st = new DynamicObject(); st->setProperty ("pitch", 61);
            st->setProperty ("startBeats", 0.75); st->setProperty ("durBeats", 0.5); st->setProperty ("vel", 80);
            e->setProperty ("match", var (m)); e->setProperty ("set", var (st));
            edits.add (var (e));
        }
        auto r = cmd (ops, "update_notes", objN ({{ "clipId", cid }, { "edits", edits }}));
        check (ok (r) && (int) r["data"].getProperty ("updated", 0) == 1, "update_notes updates one note");
        check (r["data"].getProperty ("notes", var()).size() == 1
                   && (int) r["data"]["notes"][0].getProperty ("pitch", 0) == 61,
               "result carries the resolved final note (the lift's source)");

        auto findNote = [&] (int pitch, double start) -> bool
        {
            auto snap = ops.snapshot();
            for (auto& tv : *snap["tracks"].getArray())
                if (tv.getProperty ("id", var()).toString() == t16id)
                    for (auto& nv : *tv["clips"][0].getProperty ("notes", var()).getArray())
                        if ((int) nv.getProperty ("pitch", -1) == pitch
                            && std::abs ((double) nv.getProperty ("startBeats", -1.0) - start) < 0.01)
                            return true;
            return false;
        };
        check (findNote (61, 0.75), "edited note at the new pitch/position");
        check (! findNote (60, 0.0), "old note gone");

        check (ok (cmd (ops, "undo")), "undo update_notes ok");
        check (findNote (60, 0.0) && ! findNote (61, 0.75), "ONE undo step restores the note fully");

        // The lift: the recorded step carries notes.remove + notes.add IR.
        cmd (ops, "update_notes", objN ({{ "clipId", cid }, { "edits", edits }}));
        {
            StringArray lines;
            eng.sessionDir().getChildFile ("trajectory.jsonl").readLines (lines);
            lines.removeEmptyStrings();
            bool liftOk = false;
            for (int i = lines.size(); --i >= 0;)
            {
                auto rec = JSON::parse (lines[i]);
                if (rec.getProperty ("command", var()).toString() != "update_notes") continue;
                auto ir = rec.getProperty ("ir", var());
                liftOk = ir.isArray() && ir.size() == 2
                         && ir[0].getProperty ("kind", var()).toString() == "notes.remove"
                         && ir[1].getProperty ("kind", var()).toString() == "notes.add";
                break;
            }
            check (liftOk, "update_notes lifts to a notes.remove + notes.add pair");
        }

        cmd (ops, "remove_track", args1 ("trackId", t16id));
    }

    // --- Stage 17: mixer surfaces (routing/sends/sidechain in the snapshot) ---
    {
        std::cerr << "--- Stage 17: mixer surfaces ---\n";
        auto src = cmd (ops, "create_track", args1 ("name", "Mx Src"));
        auto bus = cmd (ops, "create_track", args1 ("name", "Mx Bus"));
        const auto srcId = src["data"].getProperty ("trackId", var()).toString();
        const auto busId = bus["data"].getProperty ("trackId", var()).toString();

        check (ok (cmd (ops, "add_return", objN ({{ "trackId", busId }, { "busNumber", 7 }}))), "add_return ok");
        auto sendR = cmd (ops, "add_send", objN ({{ "trackId", srcId }, { "busNumber", 7 }, { "gainDb", -6.0 }}));
        check (ok (sendR), "add_send ok");
        const int sendIdx = (int) sendR["data"].getProperty ("index", -1);
        check (ok (cmd (ops, "set_send_gain", objN ({{ "trackId", srcId }, { "index", sendIdx }, { "gainDb", -12.0 }}))),
               "set_send_gain ok");
        check (ok (cmd (ops, "route_track", objN ({{ "trackId", srcId }, { "destTrackId", busId }}))), "route_track ok");
        check (ok (cmd (ops, "load_builtin_plugin", objN ({{ "trackId", busId }, { "type", "compressor" }}))),
               "compressor on the bus");
        auto comp = cmd (ops, "set_sidechain", objN ({{ "trackId", busId }, { "index", 1 },
                        { "sourceTrackId", srcId }}));
        check (ok (comp), "set_sidechain ok");

        auto snap = ops.snapshot();
        var srcVar, busVar;
        for (auto& tv : *snap["tracks"].getArray())
        {
            if (tv.getProperty ("id", var()).toString() == srcId) srcVar = tv;
            if (tv.getProperty ("id", var()).toString() == busId) busVar = tv;
        }
        check (srcVar.getProperty ("routeTo", var()).toString() == busId, "snapshot carries routeTo");
        var sendVar, retVar, compVar;
        for (auto& pv : *srcVar["plugins"].getArray())
            if (pv.getProperty ("type", var()).toString() == "auxsend") sendVar = pv;
        for (auto& pv : *busVar["plugins"].getArray())
        {
            if (pv.getProperty ("type", var()).toString() == "auxreturn") retVar = pv;
            if (pv.getProperty ("type", var()).toString() == "compressor") compVar = pv;
        }
        check ((int) sendVar.getProperty ("busNumber", -1) == 7, "send busNumber in snapshot");
        check (std::abs ((double) sendVar.getProperty ("gainDb", 0.0) + 12.0) < 0.5, "send gain in snapshot");
        check ((int) retVar.getProperty ("busNumber", -1) == 7, "return busNumber in snapshot");
        check (compVar.getProperty ("sidechainSourceId", var()).toString() == srcId,
               "compressor sidechain source in snapshot");

        cmd (ops, "remove_track", args1 ("trackId", srcId));
        cmd (ops, "remove_track", args1 ("trackId", busId));
    }

    // --- Stage 18: crate browser (list_dir guard + read-only exclusion) ---
    {
        std::cerr << "--- Stage 18: crate browser ---\n";
        // Use the session dir as a controlled crate root.
        auto crate = eng.sessionDir().getChildFile ("crate-test");
        crate.getChildFile ("sub").createDirectory();
        eng.generateTestTone (0.1, 220.0, "crate-tone");
        eng.sessionDir().getChildFile ("audio").getChildFile ("crate-tone.wav")
            .copyFileTo (crate.getChildFile ("sub").getChildFile ("kick_test.wav"));
        setenv ("MOSH_SAMPLE_LIBRARY", crate.getFullPathName().toRawUTF8(), 1);

        auto rootList = cmd (ops, "list_dir");
        check (ok (rootList) && rootList["data"].getProperty ("dirs", var()).size() == 1,
               "list_dir lists the crate root");
        auto subList = cmd (ops, "list_dir", args1 ("path", "sub"));
        check (ok (subList) && subList["data"].getProperty ("files", var()).size() == 1,
               "list_dir lists audio files in a subfolder");
        check (! ok (cmd (ops, "list_dir", args1 ("path", "../../"))),
               "path traversal is rejected");
        auto search = cmd (ops, "list_dir", args1 ("query", "kick"));
        check (ok (search) && search["data"].getProperty ("files", var()).size() == 1,
               "recursive search finds the file");
        // Headless: audition cleanly refuses (no audio session), never crashes.
        check (! ok (cmd (ops, "audition_file", args1 ("path", "sub/kick_test.wav")))
                   == ! eng.hasAudio(),
               "audition matches the audio mode");
        check (ok (cmd (ops, "stop_audition")), "stop_audition ok");
        {
            StringArray lines;
            eng.sessionDir().getChildFile ("trajectory.jsonl").readLines (lines);
            bool leaked = false;
            for (auto& l : lines) if (l.contains ("list_dir") || l.contains ("audition_file")) leaked = true;
            check (! leaked, "crate browsing never enters the trajectory");
        }
        unsetenv ("MOSH_SAMPLE_LIBRARY");
    }

    // --- Stage 19: recording surfaces (headless: structure + clean refusals) ---
    {
        std::cerr << "--- Stage 19: recording surfaces ---\n";
        auto li = cmd (ops, "list_audio_inputs");
        check (ok (li) && li["data"].hasProperty ("devices"), "list_audio_inputs ok");
        auto t19 = cmd (ops, "create_track", args1 ("name", "Rec19"));
        const auto t19id = t19["data"].getProperty ("trackId", var()).toString();
        if (! eng.hasAudio())
        {
            check (! ok (cmd (ops, "arm_track", objN ({{ "trackId", t19id }, { "on", true }}))),
                   "arm_track refuses cleanly without an input device");
            check (! ok (cmd (ops, "set_audio_input", args1 ("device", "Nope"))),
                   "set_audio_input refuses headless");
        }
        auto snap = ops.snapshot();
        check (snap["session"].hasProperty ("audioInputDevice"), "snapshot carries audioInputDevice");
        var tv19;
        for (auto& tv : *snap["tracks"].getArray())
            if (tv.getProperty ("id", var()).toString() == t19id) tv19 = tv;
        check (tv19.hasProperty ("armed") && ! (bool) tv19.getProperty ("armed", true),
               "snapshot carries armed=false by default");
        cmd (ops, "remove_track", args1 ("trackId", t19id));
    }

    // --- Stage 20: the slide chain (pitchshift automation = real 808 glides) ---
    {
        std::cerr << "--- Stage 20: slide chain ---\n";
        auto t20 = cmd (ops, "create_track", args1 ("name", "Slide20"));
        const auto t20id = t20["data"].getProperty ("trackId", var()).toString();
        auto ps = cmd (ops, "load_builtin_plugin", objN ({{ "trackId", t20id }, { "type", "pitchshift" }}));
        check (ok (ps), "pitchshift loads");
        const int psIdx = (int) ps["data"].getProperty ("index", -1);
        Array<var> pts;
        for (auto [b, v] : std::initializer_list<std::pair<double,double>> {
                 { 0.0, 0.5 }, { 2.0, 0.5 }, { 2.5, 0.25 }, { 2.51, 0.5 } })
        {
            auto* p = new DynamicObject();
            p->setProperty ("beats", b); p->setProperty ("value", v);
            pts.add (var (p));
        }
        auto wa = cmd (ops, "write_automation", objN ({{ "trackId", t20id },
                       { "pluginIndex", psIdx }, { "paramName", "semitone" }, { "points", pts }}));
        check (ok (wa), "slide ramp writes to the pitchshift semitones param");
        check (wa["data"].getProperty ("param", var()).toString().containsIgnoreCase ("semitone"),
               "addressed the semitones parameter");

        // --- Stage 22: lanes read back what write_automation wrote ---
        std::cerr << "--- Stage 22: automation lanes ---\n";
        auto ga = cmd (ops, "get_automation", args1 ("trackId", t20id));
        check (ok (ga) && ga["data"].getProperty ("lanes", var()).size() == 1,
               "get_automation lists the written lane");
        auto lane0 = ga["data"]["lanes"][0];
        check (lane0.getProperty ("points", var()).size() == 4, "lane carries all 4 points");
        check (std::abs ((double) lane0["points"][2].getProperty ("value", 0.0) - 0.25) < 0.02,
               "normalized point value round-trips");
        check (std::abs ((double) lane0["points"][2].getProperty ("beats", 0.0) - 2.5) < 0.01,
               "point time round-trips in beats");
        check (ok (cmd (ops, "clear_automation", objN ({{ "trackId", t20id },
                       { "pluginIndex", psIdx }, { "paramName", "semitone" }}))), "clear_automation ok");
        auto ga2 = cmd (ops, "get_automation", args1 ("trackId", t20id));
        check (ga2["data"].getProperty ("lanes", var()).size() == 0, "lane gone after clear");
        check (ok (cmd (ops, "undo")), "undo clear ok");
        auto ga3 = cmd (ops, "get_automation", args1 ("trackId", t20id));
        check (ga3["data"].getProperty ("lanes", var()).size() == 1, "undo restores the lane");

        cmd (ops, "remove_track", args1 ("trackId", t20id));
    }

    // --- Stage 23: arranger sections (create idempotence + remove) ---
    {
        std::cerr << "--- Stage 23: arranger sections ---\n";
        check (ok (cmd (ops, "create_section", objN ({{ "name", "A" }, { "startBar", 1 }, { "lengthBars", 4 }}))),
               "create_section ok");
        check (ok (cmd (ops, "create_section", objN ({{ "name", "A" }, { "startBar", 5 }, { "lengthBars", 8 }}))),
               "re-create moves/resizes (idempotent by name)");
        // Earlier stages create their own sections in this session — assert on
        // OUR section by name, never on the array size.
        auto findA = [&]() -> var
        {
            auto sections = ops.snapshot()["session"].getProperty ("sections", var());
            for (auto& sc : *sections.getArray())
                if (sc.getProperty ("name", var()).toString() == "A") return sc;
            return {};
        };
        auto a = findA();
        check ((int) a.getProperty ("startBar", 0) == 5 && (int) a.getProperty ("lengthBars", 0) == 8,
               "snapshot carries the moved section");
        check (ok (cmd (ops, "remove_section", args1 ("name", "A"))), "remove_section ok");
        check (findA().isVoid(), "section gone");
        check (ok (cmd (ops, "undo")), "undo remove ok");
        check (! findA().isVoid(), "undo restores the section");
        cmd (ops, "remove_section", args1 ("name", "A"));
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

    auto* mm = MessageManager::getInstanceWithoutCreating();

    // Engine-output truth (Stage 14): a LevelMeasurer client on the master tap
    // measures what the GRAPH produces, independent of speakers/device routing.
    // Engine-out signal + silent speakers ⇒ device problem; engine-out silence
    // ⇒ live-graph bug. This is the bisection the rung-1 silence lacked.
    auto masterMeter = [&]() -> te::LevelMeterPlugin*
    {
        return eng.edit().getMasterPluginList().getPluginsOfType<te::LevelMeterPlugin>().getLast();
    };
    check (masterMeter() != nullptr, "master level tap present");

    auto pumpPeakDb = [&] (te::LevelMeasurer::Client& client, int ms) -> float
    {
        float peak = -100.0f;
        const auto until = Time::getMillisecondCounter() + (uint32) ms;
        while (Time::getMillisecondCounter() < until)
        {
            if (mm != nullptr) mm->runDispatchLoopUntil (30);
            else Thread::sleep (30);
            for (int ch = 0; ch < 2; ++ch)
                peak = jmax (peak, client.getAndClearAudioLevel (ch).dB);
        }
        return peak;
    };

    te::LevelMeasurer::Client tapClient;
    if (auto* m0 = masterMeter())
        m0->measurer.addClient (tapClient);

    auto smokeMs = SystemStats::getEnvironmentVariable ("MOSH_LIVE_AUDIO_SMOKE_MS", "3500").getIntValue();
    smokeMs = jlimit (500, 15000, smokeMs);

    // ── Phase A: tone through a wave clip (the only previously-proven path) ──
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
    const auto tonePeak = pumpPeakDb (tapClient, smokeMs);
    deviceManager.removeAudioCallback (&probe);

    std::cerr << "  ..   tone master peak " << tonePeak << " dBFS\n";
    check (tonePeak > -30.0f, "tone audible at the master tap (live wave path)");
    check (probe.getCallbackCount() > 0, "live-audio probe callback ran");
    check (probe.getSampleCount() > 0, "live-audio probe observed audio frames");
    check (probe.getWrittenSampleCount() > 0, "live-audio probe had writable output channels");
    if (requestedInput.isNotEmpty())
    {
        check (probe.getInputSampleCount() > 0, "live-audio probe observed input frames");
        check (probe.getInputNonSilentSampleCount() > 0, "live-audio probe captured loopback input");
    }
    check (ok (cmd (ops, "set_transport", args1 ("action", "stop"))), "transport stop ok");

    // The tone track must not pollute phases B/C — the sampler has to prove
    // itself alone at the master tap.
    check (ok (cmd (ops, "remove_track", args1 ("trackId", trackId))), "tone track removed");

    // ── Phase B: MIDI → builtin sampler, fresh-built (rung 1's silent path) ──
    auto t2 = cmd (ops, "create_track", args1 ("name", "Smoke Sampler"));
    check (ok (t2), "sampler track ok");
    const auto t2id = t2["data"].getProperty ("trackId", var()).toString();
    check (ok (cmd (ops, "load_builtin_plugin", objN ({{ "trackId", t2id }, { "type", "sampler" }}))),
           "load builtin sampler ok");
    auto fixture = eng.generateTestTone (0.4, 330.0, "smoke-pad");
    check (ok (cmd (ops, "add_sampler_sound",
                   objN ({{ "trackId", t2id }, { "index", 0 },
                          { "file", fixture.getFullPathName() },
                          { "keyNote", 60 }, { "openEnded", true }}))),
           "add_sampler_sound ok");
    // Default add_midi_clip seeds a C-major arpeggio at pitch 60+ — exactly
    // what the sampler is keyed to.
    check (ok (cmd (ops, "add_midi_clip",
                   objN ({{ "trackId", t2id }, { "name", "smoke notes" },
                          { "start", 0.0 }, { "length", 2.0 }}))),
           "add_midi_clip ok");
    // Let the SamplerPlugin's AsyncUpdater (sound-list rebuild) and the
    // playback-graph rebuild settle before playing — in the real GUI the
    // message loop always runs between building and pressing play; commands
    // issued back-to-back here would race the updater.
    if (mm != nullptr) mm->runDispatchLoopUntil (300);

    check (ok (cmd (ops, "set_transport", args1 ("position", 0.0))), "sampler seek ok");
    check (ok (cmd (ops, "set_transport", args1 ("action", "play"))), "sampler play ok");

    // The per-track tap must hear it too (it sits at the chain END, post-fader).
    te::LevelMeasurer::Client trackClient;
    auto* samplerTrack = te::findAudioTrackForID (eng.edit(), te::EditItemID::fromString (t2id));
    auto* trackMeter = samplerTrack != nullptr
                           ? samplerTrack->pluginList.getPluginsOfType<te::LevelMeterPlugin>().getLast()
                           : nullptr;
    check (trackMeter != nullptr, "sampler track has a level tap");
    if (trackMeter != nullptr)
        trackMeter->measurer.addClient (trackClient);

    // Poll BOTH taps continuously — a single read at the end only sees the
    // final block (silence, once the 2s clip has passed).
    float samplerPeak = -100.0f, trackPeak = -100.0f;
    const auto untilB = Time::getMillisecondCounter() + 2500u;
    while (Time::getMillisecondCounter() < untilB)
    {
        if (mm != nullptr) mm->runDispatchLoopUntil (30);
        else Thread::sleep (30);
        for (int ch = 0; ch < 2; ++ch)
        {
            samplerPeak = jmax (samplerPeak, tapClient.getAndClearAudioLevel (ch).dB);
            trackPeak   = jmax (trackPeak, trackClient.getAndClearAudioLevel (ch).dB);
        }
    }
    if (trackMeter != nullptr)
        trackMeter->measurer.removeClient (trackClient);

    std::cerr << "  ..   sampler master peak " << samplerPeak
              << " dBFS, track peak " << trackPeak << " dBFS\n";
    if (samplerPeak <= -40.0f)   // diagnose, don't guess: which half is broken?
    {
        auto* sp = samplerTrack != nullptr
                       ? samplerTrack->pluginList.getPluginsOfType<te::SamplerPlugin>().getLast()
                       : nullptr;
        std::cerr << "  !!   diagnose: sounds=" << (sp != nullptr ? sp->getNumSounds() : -1)
                  << " playing=" << (eng.edit().getTransport().isPlaying() ? 1 : 0)
                  << " ctx=" << (eng.edit().getTransport().getCurrentPlaybackContext() != nullptr ? 1 : 0)
                  << " pos=" << eng.edit().getTransport().getPosition().inSeconds() << "\n";
    }
    check (samplerPeak > -40.0f, "LIVE MIDI->sampler audible at the master tap");
    check (trackPeak > -40.0f, "LIVE MIDI->sampler audible at the TRACK tap");
    check (ok (cmd (ops, "set_transport", args1 ("action", "stop"))), "sampler stop ok");

    // ── Phase C: cold reload, then play — exactly the GUI's load path ──
    // (rung 1's GUI silence was on a sampler RESTORED from disk, a path no
    // offline bounce had ever covered).
    if (auto* m0 = masterMeter())
        m0->measurer.removeClient (tapClient);      // old edit is about to die
    check (ok (cmd (ops, "save")), "save ok");
    check (ok (cmd (ops, "reload")), "reload ok");
    if (mm != nullptr) mm->runDispatchLoopUntil (200);   // let the 30 Hz timer re-adopt meters
    check (masterMeter() != nullptr, "master tap present after reload");

    te::LevelMeasurer::Client reloadClient;
    if (auto* m1 = masterMeter())
        m1->measurer.addClient (reloadClient);
    check (ok (cmd (ops, "set_transport", args1 ("position", 0.0))), "post-reload seek ok");
    check (ok (cmd (ops, "set_transport", args1 ("action", "play"))), "post-reload play ok");
    const auto reloadPeak = pumpPeakDb (reloadClient, 2500);
    std::cerr << "  ..   post-reload master peak " << reloadPeak << " dBFS\n";
    check (reloadPeak > -40.0f, "MIDI->sampler audible after cold reload (the GUI path)");
    check (ok (cmd (ops, "set_transport", args1 ("action", "stop"))), "post-reload stop ok");
    if (auto* m1 = masterMeter())
        m1->measurer.removeClient (reloadClient);

    // ── Phase D (gated, MOSH_SMOKE_RECORD=1): REAL recording through the mic ──
    // Needs the TCC microphone permission, so it is not part of the default
    // battery; run manually to prove arm → record → clip-lands end to end.
    if (SystemStats::getEnvironmentVariable ("MOSH_SMOKE_RECORD", "0") == "1")
    {
        std::cerr << "--- Phase D: live recording (mic) ---\n";
        auto inputs = eng.listAudioInputDevices();
        std::cerr << "  ..   inputs: " << inputs.joinIntoString (" | ") << "\n";
        check (! inputs.isEmpty(), "an audio input device exists");
        if (! inputs.isEmpty())
        {
            // Prefer the built-in mic — Continuity devices (iPhone mic) list
            // but deliver nothing unless the phone is active.
            auto pick = inputs[0];
            for (auto& n : inputs)
                if (n.containsIgnoreCase ("MacBook")) { pick = n; break; }
            check (ok (cmd (ops, "set_audio_input", args1 ("device", pick))), "set_audio_input ok");
            auto rt = cmd (ops, "create_track", args1 ("name", "Rec Smoke"));
            const auto rtid = rt["data"].getProperty ("trackId", var()).toString();
            auto arm = cmd (ops, "arm_track", objN ({{ "trackId", rtid }, { "on", true }}));
            check (ok (arm) && (bool) arm["data"].getProperty ("armed", false), "track armed");
            check (ok (cmd (ops, "set_transport", args1 ("position", 0.0))), "rec seek ok");
            check (ok (cmd (ops, "set_transport", args1 ("action", "record"))), "record starts");
            if (mm != nullptr) mm->runDispatchLoopUntil (1500);
            check (ok (cmd (ops, "set_transport", args1 ("action", "stop"))), "record stops");
            if (mm != nullptr) mm->runDispatchLoopUntil (400);   // clip commit is async-ish
            auto snap = ops.snapshot();
            int clips = -1;
            for (auto& tv : *snap["tracks"].getArray())
                if (tv.getProperty ("id", var()).toString() == rtid)
                    clips = tv["clips"].size();
            std::cerr << "  ..   recorded clips on the armed track: " << clips << "\n";
            check (clips >= 1, "recording landed as a clip on the armed track");
        }
    }

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

    // Find an effect + an instrument from the scan.
    String fxId, instId;
    auto lp = cmd ("list_plugins");
    if (auto* arr = lp["data"].getProperty ("plugins", var()).getArray())
        for (auto& p : *arr)
        {
            if ((bool) p.getProperty ("isInstrument", false) && instId.isEmpty()) instId = p.getProperty ("id", var()).toString();
            if (! (bool) p.getProperty ("isInstrument", false) && fxId.isEmpty()) fxId = p.getProperty ("id", var()).toString();
        }

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
