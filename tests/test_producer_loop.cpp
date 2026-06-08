#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>
#include "MoshEngine.h"
#include "EngineHandlers.h"
#include "PluginCommands.h"
#include "NeuralCommands.h"
#include "GenerativeEngine.h"
#include "EngineSnapshot.h"
#include "GenerativeJobManager.h"
#include "DslExecutor.h"
#include "JsonlLog.h"
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_gui_basics/juce_gui_basics.h>

// ──────────────────────────────────────────────────────────────────────────────
// THE STAGE 6 PRODUCER LOOP — end-to-end over REAL Tracktion + the REAL service,
// via the exact MoshOps commands the UI emits (browser-verified separately). This
// is the full loop the Stage-6 gate describes — import → arrange → host a plugin →
// add a Tier-A neural insert → run a generative transform → accept it
// non-destructively → mix → with **undo/redo correct throughout** → save/reload —
// minus only the literal WebView render + audio export, which need macOS.
// ──────────────────────────────────────────────────────────────────────────────
using namespace mosh;
using Catch::Approx;

#ifndef MOSH_SERVICE_DIR
 #define MOSH_SERVICE_DIR ""
#endif

namespace
{
    juce::var argObj (std::initializer_list<std::pair<const char*, juce::var>> kv)
    {
        auto* o = new juce::DynamicObject();
        for (auto& p : kv) o->setProperty (juce::Identifier (p.first), p.second);
        return juce::var (o);
    }
    juce::File makeTempWav (double seconds = 0.3, double sr = 44100.0)
    {
        auto f = juce::File::createTempFile ("wav");
        juce::WavAudioFormat fmt;
        if (auto os = f.createOutputStream())
            if (std::unique_ptr<juce::AudioFormatWriter> w (fmt.createWriterFor (os.release(), sr, 1, 16, {}, 0)); w)
            {
                const int n = (int) (seconds * sr);
                juce::AudioBuffer<float> buf (1, n); buf.clear();
                w->writeFromAudioSampleBuffer (buf, 0, n);
            }
        return f;
    }
    int trackCount (const juce::var& s) { return s["tracks"].size(); }
    int clipsNamed (const juce::var& s, const juce::String& name)
    {
        auto t = s["tracks"];
        for (int i = 0; i < t.size(); ++i) if (t[i]["name"].toString() == name) return t[i]["clips"].size();
        return -1;
    }
}

TEST_CASE ("STAGE 6 producer loop: import->arrange->plugin->neural->generative->mix, undo/redo throughout", "[producer]")
{
    juce::File serviceDir { juce::String (MOSH_SERVICE_DIR) };
    if (! serviceDir.getChildFile ("server.py").existsAsFile())
    {
        WARN ("service/server.py not found — skipping producer loop");
        return;
    }

    juce::ScopedJuceInitialiser_GUI juceInit;
    MoshEngine engine;
    JsonlLog log ([] { return juce::String ("t"); });
    DslExecutor exec (engine.getUndoManager(), &log);
    EngineSnapshotSource snap (engine);
    exec.setSnapshotSource (&snap);
    registerEngineHandlers (exec, engine);
    registerPluginCommands (exec, engine);
    registerNeuralCommands (exec, engine);
    GenerativeJobManager jobs (serviceDir, 8799);
    RenderCache cache;
    registerGenerativeEngineCommands (exec, engine, jobs, cache);
    REQUIRE (jobs.ensureServiceRunning());

    auto wav = makeTempWav();
    const int t0 = trackCount (exec.getSnapshot());

    // 1. IMPORT — create a track + a source clip.
    auto t = exec.execute ("create_track", argObj ({ { "name", "Gtr" } }));
    REQUIRE (t.ok);
    const auto trackRef = t.data["id"].toString();
    auto c = exec.execute ("import_clip", argObj ({ { "track", trackRef }, { "path", wav.getFullPathName() }, { "start", 0.0 } }));
    REQUIRE (c.ok);
    const auto clipRef = c.data["id"].toString();
    REQUIRE (clipsNamed (exec.getSnapshot(), "Gtr") == 1);

    // 2. ARRANGE — move the clip.
    REQUIRE (exec.execute ("move_clip", argObj ({ { "clip", clipRef }, { "start", 1.0 } })).ok);

    // 3. HOST a plugin (built-in stands in for a VST3 on Windows).
    REQUIRE (exec.execute ("load_plugin", argObj ({ { "track", trackRef }, { "type", "volume" } })).ok);

    // 4. TIER-A NEURAL insert + ASTD-clamped param.
    auto ni = exec.execute ("add_neural_insert", argObj ({ { "track", trackRef }, { "model", "nam" } }));
    REQUIRE (ni.ok);
    const auto niRef = ni.data["id"].toString();
    REQUIRE (exec.execute ("set_neural_param", argObj ({ { "plugin", niRef }, { "param", "amount" }, { "value", 80.0 } })).ok);

    // 5. GENERATIVE transform — render a layer on the clip via the service, accept it.
    auto rl = exec.execute ("create_render_layer", argObj ({ { "clip", clipRef }, { "prompt", "grit" }, { "seed", 5 } }));
    REQUIRE (rl.ok);
    const auto rlRef = rl.data["id"].toString();
    REQUIRE (exec.execute ("render_layer", argObj ({ { "layer", rlRef } })).ok);

    const int beforeAccept = trackCount (exec.getSnapshot());
    auto acc = exec.execute ("accept_render", argObj ({ { "layer", rlRef } }));  // → new clip on a Neural lane
    REQUIRE (acc.ok);
    REQUIRE (trackCount (exec.getSnapshot()) == beforeAccept + 1);   // Neural lane added
    REQUIRE (clipsNamed (exec.getSnapshot(), "Neural") == 1);        // landed render
    REQUIRE (clipsNamed (exec.getSnapshot(), "Gtr") == 1);          // SOURCE untouched (non-destructive)

    // 6. MIX — set the source track's gain.
    REQUIRE (exec.execute ("set_track_gain", argObj ({ { "track", trackRef }, { "gain", 0.6 } })).ok);

    // ── UNDO/REDO CORRECT THROUGHOUT ──────────────────────────────────────────
    // Undo the mix → gain reverts.
    exec.execute ("undo");
    // Undo the accept → the Neural lane + landed clip revert; SOURCE still intact.
    exec.execute ("undo");
    REQUIRE (trackCount (exec.getSnapshot()) == beforeAccept);
    REQUIRE (clipsNamed (exec.getSnapshot(), "Gtr") == 1);
    // Redo the accept → the landing comes back.
    exec.execute ("redo");
    REQUIRE (trackCount (exec.getSnapshot()) == beforeAccept + 1);
    REQUIRE (clipsNamed (exec.getSnapshot(), "Neural") == 1);

    // Unwind the WHOLE loop and confirm it regresses to the start, then rebuild it.
    // (Guarded loops — robust to empty/no-op transactions like a cache-only render.)
    for (int i = 0; i < 40 && trackCount (exec.getSnapshot()) > t0; ++i) exec.execute ("undo");
    REQUIRE (trackCount (exec.getSnapshot()) == t0);                 // back to the initial session
    for (int i = 0; i < 40; ++i) exec.execute ("redo");
    REQUIRE (trackCount (exec.getSnapshot()) >= beforeAccept);       // rebuilt

    // ── EXPORT/PERSIST — save the whole producer session and reload it fresh ──
    auto editFile = juce::File::createTempFile ("tracktionedit");
    REQUIRE (engine.saveAs (editFile));
    {
        MoshEngine e2;
        REQUIRE (e2.load (editFile));
        EngineSnapshotSource s2 (e2);
        auto reloaded = s2.getSnapshot();
        REQUIRE (clipsNamed (reloaded, "Gtr") == 1);                 // session restored
    }

    // The JSONL semantic trail captured the whole loop incl. the accept taste label.
    bool hasAccept = false;
    for (const auto& line : log.lines())
        if (juce::JSON::parse (line)["cmd"].toString() == "accept_render") hasAccept = true;
    REQUIRE (hasAccept);

    jobs.shutdown();
    wav.deleteFile();
    editFile.deleteFile();
}
