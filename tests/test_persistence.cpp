#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>
#include "MoshEngine.h"
#include "EngineHandlers.h"
#include "PluginCommands.h"
#include "NeuralCommands.h"
#include "EngineSnapshot.h"
#include "DslExecutor.h"
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_gui_basics/juce_gui_basics.h>

// Gate requirement (Stage 1 "save/reload restores" + Stage 3 "persists"): the whole
// model — tracks, clips, hosted plugins, and the custom Tier-A NeuralInsertPlugin —
// survives a save → FRESH-session reload, verified via the snapshot. Proves the
// ValueTree serialization round-trip incl. the custom built-in plugin registration.
using namespace mosh;
using Catch::Approx;

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
            if (std::unique_ptr<juce::AudioFormatWriter> w (fmt.createWriterFor (os.release(), sr, 1, 16, {}, 0)); w != nullptr)
            {
                const int n = (int) (seconds * sr);
                juce::AudioBuffer<float> buf (1, n); buf.clear();
                w->writeFromAudioSampleBuffer (buf, 0, n);
            }
        return f;
    }
}

TEST_CASE ("persistence: tracks/clips/plugins/neural survive save -> fresh reload", "[persist]")
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    auto wav = makeTempWav();
    auto editFile = juce::File::createTempFile ("tracktionedit");

    // ── session 1: build a session and save it ───────────────────────────────
    {
        MoshEngine e1;
        DslExecutor ex (e1.getUndoManager());
        EngineSnapshotSource s (e1);
        ex.setSnapshotSource (&s);
        registerEngineHandlers (ex, e1);
        registerPluginCommands (ex, e1);
        registerNeuralCommands (ex, e1);

        auto t = ex.execute ("create_track", argObj ({ { "name", "Vox" } }));
        REQUIRE (t.ok);
        const auto trackRef = t.data["id"].toString();
        REQUIRE (ex.execute ("import_clip", argObj ({ { "track", trackRef }, { "path", wav.getFullPathName() }, { "start", 2.0 } })).ok);
        REQUIRE (ex.execute ("load_plugin", argObj ({ { "track", trackRef }, { "type", "volume" } })).ok);
        REQUIRE (ex.execute ("add_neural_insert", argObj ({ { "track", trackRef }, { "model", "proteus" } })).ok);
        REQUIRE (e1.saveAs (editFile));
    }

    // ── session 2: a FRESH engine reloads the file and must reconstruct it ────
    {
        MoshEngine e2;                       // ctor re-registers the NeuralInsertPlugin built-in
        REQUIRE (e2.load (editFile));
        EngineSnapshotSource s2 (e2);
        auto snap = s2.getSnapshot();

        bool foundVox = false;
        auto tracks = snap["tracks"];
        for (int i = 0; i < tracks.size(); ++i)
        {
            auto tr = tracks[i];
            if (tr["name"].toString() != "Vox")
                continue;
            foundVox = true;

            REQUIRE (tr["clips"].size() == 1);                                   // clip restored
            REQUIRE ((double) tr["clips"][0]["range"][0] == Approx (2.0));        // at its position

            bool hasNeural = false, hasVolume = false;                           // plugins restored
            auto plugins = tr["plugins"];
            for (int j = 0; j < plugins.size(); ++j)
            {
                const auto name = plugins[j]["name"].toString();
                if (name == "Neural Insert") hasNeural = true;
                if (name.containsIgnoreCase ("volume") || plugins[j]["type"].toString() == "builtin") hasVolume = true;
            }
            REQUIRE (hasNeural);   // the custom Tier-A insert survived save/reload
        }
        REQUIRE (foundVox);
    }

    wav.deleteFile();
    editFile.deleteFile();
}
