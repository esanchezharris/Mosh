#include "SelfTest.h"
#include "engine/MoshEngine.h"
#include "moshops/MoshOps.h"
#include "plugins/neural/NeuralInsertPlugin.h"
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

    // 3. add_test_tone_clip → wave clip on the track
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

    // 4. transport: play → playing; stop; seek
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

    // 7. save → reload restores state (incl. MOSH_RENDERLAYER survives once redone)
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

    // move_clip → start 2.0s
    { auto* a = new DynamicObject(); a->setProperty ("clipId", cid); a->setProperty ("start", 2.0);
      check (ok (cmd (ops, "move_clip", var (a))), "move_clip ok"); }
    check (std::abs ((double) firstTrack (ops)["clips"][0].getProperty ("start", 0.0) - 2.0) < 0.05, "clip moved to 2.0s");

    // trim_clip → length 1.0s
    { auto* a = new DynamicObject(); a->setProperty ("clipId", cid); a->setProperty ("length", 1.0);
      check (ok (cmd (ops, "trim_clip", var (a))), "trim_clip ok"); }
    check (std::abs ((double) firstTrack (ops)["clips"][0].getProperty ("length", 0.0) - 1.0) < 0.05, "clip trimmed to 1.0s");

    // split_clip → 2 clips
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

    // get_clip_peaks → non-empty peak array (waveform from backend)
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

            // Bypass — the known inverted-logic bug (04 §2.4): bypassed → passthrough.
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
        check (r1["data"].getProperty ("status", var()).toString() == "ready", "render completed → status ready");
        // snapshot reflects the rendered layer
        bool hasArtifact = false;
        { auto trk = trackById (gt);
          if (auto* arr = trk.getProperty ("clips", var()).getArray())
            for (auto& c : *arr) if (c.getProperty ("id", var()).toString() == gcid)
                hasArtifact = (bool) c.getProperty ("renderLayer", var()).getProperty ("hasArtifact", false); }
        check (hasArtifact, "render produced a cached artifact (output.wav)");

        // Re-render with identical fingerprint → cache HIT.
        auto r2 = cmd (ops, "render_layer", objN ({{ "clipId", gcid }, { "wait", true }}));
        check (r2["data"].getProperty ("cache", var()).toString() == "hit", "identical re-render is a cache HIT (full fingerprint)");

        // Change a param → fingerprint changes → cache MISS (re-render).
        cmd (ops, "set_render_param", objN ({{ "clipId", gcid }, { "seed", 2 }}));
        auto r3 = cmd (ops, "render_layer", objN ({{ "clipId", gcid }, { "wait", true }}));
        check (r3["data"].getProperty ("cache", var()).toString() == "miss", "param change → dirty → re-render (cache MISS)");

        // Accept → lands as a new clip on the "Neural Renders" lane.
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
        auto logText = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        check (logText.contains ("accept_render"), "JSONL records accept_render (taste label)");
        cmd (ops, "reject_render", args1 ("clipId", gcid));
        logText = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        check (logText.contains ("reject_render"), "JSONL records reject_render (taste label)");
    }

    std::cerr << "===== " << (checks - failures) << "/" << checks
              << " checks passed, " << failures << " failed =====\n\n";
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
    cmd ("create_render_layer", obj ({{ "clipId", cid }, { "adapter", "fake" }}));
    Array<var> colors; { auto* c = new DynamicObject(); c->setProperty ("name", "grit"); c->setProperty ("value", 55); colors.add (var (c)); }
    cmd ("set_render_param", obj ({{ "clipId", cid }, { "seed", 1 }, { "nl", 0.35 }, { "colors", colors }}));
    // NB: the actual render_layer (which spawns the service) is left to the user
    // button — running it here would block the message thread on a TCC/service
    // prompt before the WebView paints. The full render loop is proven headless.
}

} // namespace mosh
