#include <catch2/catch_test_macros.hpp>
#include "MoshEngine.h"
#include "EngineHandlers.h"
#include "GenerativeEngine.h"
#include "EngineSnapshot.h"
#include "DslExecutor.h"
#include "JsonlLog.h"
#include "GenerativeJobManager.h"
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_gui_basics/juce_gui_basics.h>

// ──────────────────────────────────────────────────────────────────────────────
// Stage 5 (Fake) END-TO-END on REAL Tracktion + the real service, no WebView:
// import a source clip, attach a RenderLayer, render via the job service, and
// accept_render → the result lands NON-DESTRUCTIVELY as a new clip on a Neural lane
// (source clip untouched); undo reverts the landing. The audition/A-B UI is the only
// Stage-5-Fake piece not exercised here (that's Stage 2 WebView).
// ──────────────────────────────────────────────────────────────────────────────
using namespace mosh;

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

    juce::File makeTempWav (double seconds = 0.25, double sr = 44100.0)
    {
        auto f = juce::File::createTempFile ("wav");
        juce::WavAudioFormat fmt;
        if (auto os = f.createOutputStream())
        {
            std::unique_ptr<juce::AudioFormatWriter> w (fmt.createWriterFor (os.release(), sr, 1, 16, {}, 0));
            if (w != nullptr)
            {
                const int n = (int) (seconds * sr);
                juce::AudioBuffer<float> buf (1, n);
                buf.clear();
                w->writeFromAudioSampleBuffer (buf, 0, n);
            }
        }
        return f;
    }

    int trackCount (const juce::var& s) { return s["tracks"].size(); }

    int clipsOnTrackNamed (const juce::var& s, const juce::String& name)
    {
        auto tracks = s["tracks"];
        for (int i = 0; i < tracks.size(); ++i)
            if (tracks[i]["name"].toString() == name)
                return tracks[i]["clips"].size();
        return -1;   // not found
    }

    int clipsOnTrackId (const juce::var& s, const juce::String& ref)
    {
        auto tracks = s["tracks"];
        for (int i = 0; i < tracks.size(); ++i)
            if (tracks[i]["id"].toString() == ref)
                return tracks[i]["clips"].size();
        return -1;
    }
}

TEST_CASE ("generative engine: render via service + accept lands a new clip non-destructively", "[gengine]")
{
    juce::File serviceDir { juce::String (MOSH_SERVICE_DIR) };
    if (! serviceDir.getChildFile ("server.py").existsAsFile())
    {
        WARN ("service/server.py not found — skipping");
        return;
    }

    juce::ScopedJuceInitialiser_GUI juceInit;
    MoshEngine engine;
    JsonlLog log ([] { return juce::String ("t"); });
    DslExecutor exec (engine.getUndoManager(), &log);
    EngineSnapshotSource snap (engine);
    exec.setSnapshotSource (&snap);
    registerEngineHandlers (exec, engine);

    GenerativeJobManager jobs (serviceDir, 8795);
    RenderCache cache;
    registerGenerativeEngineCommands (exec, engine, jobs, cache);

    // Source track + clip.
    auto wav = makeTempWav();
    auto t = exec.execute ("create_track", argObj ({ { "name", "Gtr" } }));
    REQUIRE (t.ok);
    const auto trackRef = t.data["id"].toString();
    auto c = exec.execute ("import_clip", argObj ({ { "track", trackRef }, { "path", wav.getFullPathName() }, { "start", 0.0 } }));
    REQUIRE (c.ok);
    const auto clipRef = c.data["id"].toString();
    REQUIRE (clipsOnTrackId (exec.getSnapshot(), trackRef) == 1);

    const int tracksBefore = trackCount (exec.getSnapshot());

    // Attach a render layer to the SOURCE clip, render through the service.
    auto rl = exec.execute ("create_render_layer", argObj ({ { "clip", clipRef }, { "prompt", "grit" }, { "seed", 7 } }));
    REQUIRE (rl.ok);
    const auto layerRef = rl.data["id"].toString();

    auto r = exec.execute ("render_layer", argObj ({ { "layer", layerRef } }));
    REQUIRE (r.ok);

    // accept_render → new clip on the Neural lane; SOURCE clip untouched.
    auto a = exec.execute ("accept_render", argObj ({ { "layer", layerRef } }));
    REQUIRE (a.ok);
    {
        auto s = exec.getSnapshot();
        REQUIRE (trackCount (s) == tracksBefore + 1);          // Neural lane added
        REQUIRE (clipsOnTrackNamed (s, "Neural") == 1);        // landed render
        REQUIRE (clipsOnTrackId (s, trackRef) == 1);           // SOURCE untouched (non-destructive)
    }

    // undo the accept → the landed clip (and the Neural lane created in the same txn) revert.
    exec.execute ("undo");
    REQUIRE (trackCount (exec.getSnapshot()) == tracksBefore);

    // The JSONL log captured the accept as a taste label.
    bool hasAccept = false;
    for (const auto& line : log.lines())
        if (juce::JSON::parse (line)["cmd"].toString() == "accept_render")
            hasAccept = true;
    REQUIRE (hasAccept);

    jobs.shutdown();
    wav.deleteFile();
}
