#include <catch2/catch_test_macros.hpp>
#include "MoshEngine.h"
#include "EngineSnapshot.h"
#include "EngineHandlers.h"
#include "DslExecutor.h"
#include "JsonlLog.h"
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_gui_basics/juce_gui_basics.h>   // ScopedJuceInitialiser_GUI (MessageManager)
#include <vector>

// ──────────────────────────────────────────────────────────────────────────────
// Stage 1 integration smoke test — the REAL command path over Tracktion (no
// WebView). Construct the engine, drive MoshOps, and assert the snapshot, events,
// undo/redo, and save round-trip. This is the Tracktion-linked counterpart of the
// (fake-model) command-surface harness. Built only with MOSH_BUILD_APP (links
// mosh_engine → Tracktion). Counts are asserted RELATIVE to the cold snapshot,
// since createEmptyEdit may seed a default track.
// ──────────────────────────────────────────────────────────────────────────────
using namespace mosh;

namespace
{
    juce::var argObj (std::initializer_list<std::pair<const char*, juce::var>> kv)
    {
        auto* o = new juce::DynamicObject();
        for (auto& p : kv)
            o->setProperty (juce::Identifier (p.first), p.second);
        return juce::var (o);
    }

    juce::File makeTempWav (double seconds = 0.25, double sr = 44100.0)
    {
        auto f = juce::File::createTempFile ("wav");
        juce::WavAudioFormat fmt;
        if (auto os = f.createOutputStream())
        {
            std::unique_ptr<juce::AudioFormatWriter> w (
                fmt.createWriterFor (os.release(), sr, 1, 16, {}, 0));
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

    int trackCount (const juce::var& snap) { return snap["tracks"].size(); }

    juce::var findTrack (const juce::var& snap, const juce::String& ref)
    {
        auto tracks = snap["tracks"];
        for (int i = 0; i < tracks.size(); ++i)
            if (tracks[i]["id"].toString() == ref)
                return tracks[i];
        return {};
    }

    struct Collector : MoshEventListener
    {
        std::vector<MoshEvent> evs;
        void onMoshEvent (const MoshEvent& e) override { evs.push_back (e); }
        int count (const juce::String& t) const
        {
            int n = 0; for (auto& e : evs) if (e.type == t) ++n; return n;
        }
    };
}

TEST_CASE ("engine smoke: create_track + import_clip + undo/redo + save via MoshOps", "[engine]")
{
    juce::ScopedJuceInitialiser_GUI juceInit;   // MessageManager for the Engine
    MoshEngine engine;
    JsonlLog log ([] { return juce::String ("t"); });
    DslExecutor exec (engine.getUndoManager(), &log);
    EngineSnapshotSource snap (engine);
    exec.setSnapshotSource (&snap);
    registerEngineHandlers (exec, engine);
    Collector col; exec.addListener (&col);

    const int n0 = trackCount (exec.getSnapshot());

    // create_track
    auto r1 = exec.execute ("create_track", argObj ({ { "name", "Vocal" } }));
    REQUIRE (r1.ok);
    const auto trackRef = r1.data["id"].toString();
    REQUIRE (trackRef.startsWith ("track:"));
    REQUIRE (col.count ("track_added") == 1);
    REQUIRE (trackCount (exec.getSnapshot()) == n0 + 1);
    REQUIRE (findTrack (exec.getSnapshot(), trackRef)["name"].toString() == "Vocal");

    // import_clip onto that track
    auto wav = makeTempWav();
    REQUIRE (wav.existsAsFile());
    auto r2 = exec.execute ("import_clip",
        argObj ({ { "track", trackRef }, { "path", wav.getFullPathName() }, { "start", 1.0 } }));
    REQUIRE (r2.ok);
    REQUIRE (col.count ("clip_added") == 1);
    {
        auto t = findTrack (exec.getSnapshot(), trackRef);
        REQUIRE (t["clips"].size() == 1);
        REQUIRE ((double) t["clips"][0]["range"][0] >= 1.0 - 1e-6);   // starts at 1.0s
    }

    // undo removes the clip; undo again removes the track (one txn each).
    exec.execute ("undo");
    REQUIRE (findTrack (exec.getSnapshot(), trackRef)["clips"].size() == 0);
    exec.execute ("undo");
    REQUIRE (trackCount (exec.getSnapshot()) == n0);
    exec.execute ("redo");
    REQUIRE (trackCount (exec.getSnapshot()) == n0 + 1);

    // save round-trips to a .tracktionedit file.
    REQUIRE (engine.save());
    REQUIRE (engine.getEditFile().existsAsFile());

    // JSONL recorded the semantic commands.
    REQUIRE (log.size() >= 5);

    wav.deleteFile();
}

TEST_CASE ("engine smoke: transport + tempo via MoshOps", "[engine]")
{
    juce::ScopedJuceInitialiser_GUI juceInit;   // MessageManager for the Engine
    MoshEngine engine;
    DslExecutor exec (engine.getUndoManager());
    EngineSnapshotSource snap (engine);
    exec.setSnapshotSource (&snap);
    registerEngineHandlers (exec, engine);

    REQUIRE (exec.execute ("set_tempo", argObj ({ { "bpm", 140.0 } })).ok);
    REQUIRE ((double) exec.getSnapshot()["tempo"]["bpm"] == 140.0);

    REQUIRE (exec.execute ("set_transport", argObj ({ { "position", 4.0 } })).ok);
    REQUIRE ((double) exec.getSnapshot()["transport"]["position"] >= 4.0 - 1e-6);

    REQUIRE (exec.execute ("set_transport",
        argObj ({ { "loopStart", 0.0 }, { "loopEnd", 8.0 }, { "looping", true } })).ok);
    auto loop = exec.getSnapshot()["transport"]["loop"];
    REQUIRE (loop.isArray());
    REQUIRE ((double) loop[1] == 8.0);
}
