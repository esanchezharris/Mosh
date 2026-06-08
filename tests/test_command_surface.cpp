#include <catch2/catch_test_macros.hpp>
#include "DslExecutor.h"
#include "Ids.h"
#include <vector>

// ──────────────────────────────────────────────────────────────────────────────
// The command-surface harness (06 §4 — "the key test"). Drive MoshOps with a
// scripted command sequence over a FAKE model (a plain ValueTree + a standalone
// juce::UndoManager standing in for Tracktion's) and assert results, emitted
// events, JSONL log lines, snapshot state, and undo/redo. Because the UI is just
// a client of this surface, this exercises the spine end-to-end with no Tracktion,
// no audio, no UI. The app later swaps the fake handlers for Tracktion-bound ones.
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

    int countType (const std::vector<MoshEvent>& evs, const juce::String& t)
    {
        int n = 0;
        for (auto& e : evs)
            if (e.type == t)
                ++n;
        return n;
    }

    // A minimal fake session model + the Tracktion-bound handlers' stand-ins.
    struct Harness : MoshEventListener
    {
        juce::UndoManager um;                                   // == Tracktion's, in the app
        JsonlLog log { [] { return juce::String ("1970-01-01T00:00:00.000Z"); } }; // fixed clock
        DslExecutor exec { um, &log };
        juce::ValueTree edit { "EDIT" };
        juce::ValueTree tracks { "TRACKS" };
        std::vector<MoshEvent> events;
        int trackSeq = 0, clipSeq = 0;

        struct Snap : SnapshotSource
        {
            Harness& h;
            explicit Snap (Harness& hh) : h (hh) {}
            juce::var getSnapshot() override { return h.buildSnapshot(); }
        };
        std::unique_ptr<Snap> snap;

        Harness()
        {
            edit.appendChild (tracks, nullptr);
            snap = std::make_unique<Snap> (*this);
            exec.setSnapshotSource (snap.get());
            exec.addListener (this);
            registerHandlers();
        }

        void onMoshEvent (const MoshEvent& e) override { events.push_back (e); }

        juce::var buildSnapshot()
        {
            auto* root = new juce::DynamicObject();
            juce::Array<juce::var> trackArr;
            for (auto t : tracks)
            {
                auto* to = new juce::DynamicObject();
                to->setProperty ("id", ids::trackRef (t["id"].toString()));
                to->setProperty ("name", t["name"]);
                to->setProperty ("gain", t["gain"]);
                juce::Array<juce::var> clipArr;
                for (auto c : t)
                {
                    auto* co = new juce::DynamicObject();
                    co->setProperty ("id", ids::clipRef (c["id"].toString()));
                    juce::Array<juce::var> range { (double) c["start"], (double) c["end"] };
                    co->setProperty ("range", range);
                    clipArr.add (juce::var (co));
                }
                to->setProperty ("clips", clipArr);
                to->setProperty ("plugins", juce::Array<juce::var>());
                to->setProperty ("renderLayers", juce::Array<juce::var>());
                trackArr.add (juce::var (to));
            }
            root->setProperty ("tracks", trackArr);

            auto* tr = new juce::DynamicObject();
            tr->setProperty ("position", 0.0);
            tr->setProperty ("playing", false);
            tr->setProperty ("loop", juce::var());
            root->setProperty ("transport", juce::var (tr));

            auto* te = new juce::DynamicObject();
            te->setProperty ("bpm", 120.0);
            te->setProperty ("sig", "4/4");
            root->setProperty ("tempo", juce::var (te));
            return juce::var (root);
        }

        void registerHandlers()
        {
            exec.registerCommand ("create_track", [this] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
            {
                const auto name = cmd.argString ("name", "Track");
                const auto id = juce::String (++trackSeq);
                juce::ValueTree track ("TRACK");
                track.setProperty ("id", id, nullptr);
                track.setProperty ("name", name, nullptr);
                track.setProperty ("gain", 0.8, nullptr);
                tracks.appendChild (track, &ctx.undoManager());   // single undoable op

                auto* to = new juce::DynamicObject();
                to->setProperty ("id", ids::trackRef (id));
                to->setProperty ("name", name);
                to->setProperty ("gain", 0.8);
                to->setProperty ("clips", juce::Array<juce::var>());
                to->setProperty ("plugins", juce::Array<juce::var>());
                to->setProperty ("renderLayers", juce::Array<juce::var>());
                ctx.emit (events::trackAdded (juce::var (to)));

                juce::StringArray changed; changed.add (ids::trackRef (id));
                auto* data = new juce::DynamicObject(); data->setProperty ("id", ids::trackRef (id));
                return MoshResult::success ("Created " + name, changed, juce::var (data));
            });

            exec.registerCommand ("import_clip", [this] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
            {
                // Validation first — reject before any mutation (02 §6).
                const auto raw = cmd.argString ("track");
                juce::String type, tid;
                if (! ids::parseRef (raw, type, tid))
                    tid = raw;

                juce::ValueTree found;
                for (auto t : tracks)
                    if (t["id"].toString() == tid) { found = t; break; }
                if (! found.isValid())
                    return MoshResult::failure (error::noSuchTrack, "No such track: " + raw);

                if (cmd.argString ("path").isEmpty())
                    return MoshResult::failure (error::invalidArgs, "path required");

                const auto start = cmd.argDouble ("start", 0.0);
                const auto length = cmd.argDouble ("length", 4.0);
                if (length <= 0.0)
                    return MoshResult::failure (error::invalidRange, "length must be > 0");

                const auto cid = juce::String (++clipSeq);
                juce::ValueTree clip ("CLIP");
                clip.setProperty ("id", cid, nullptr);
                clip.setProperty ("start", start, nullptr);
                clip.setProperty ("end", start + length, nullptr);
                found.appendChild (clip, &ctx.undoManager());

                auto* co = new juce::DynamicObject();
                co->setProperty ("id", ids::clipRef (cid));
                juce::Array<juce::var> range { start, start + length };
                co->setProperty ("range", range);
                ctx.emit (events::clipAdded (ids::trackRef (tid), juce::var (co)));

                juce::StringArray changed; changed.add (ids::clipRef (cid));
                auto* data = new juce::DynamicObject(); data->setProperty ("clipId", ids::clipRef (cid));
                return MoshResult::success ("Imported clip", changed, juce::var (data));
            });

            // A deliberately buggy handler: mutates, THEN fails — proves the
            // executor abandons the partial mutation (undoCurrentTransactionOnly).
            exec.registerCommand ("buggy_mutate_then_fail", [this] (const MoshCommand&, DslExecutor::Context& ctx) -> MoshResult
            {
                juce::ValueTree t ("TRACK");
                t.setProperty ("id", "buggy", nullptr);
                tracks.appendChild (t, &ctx.undoManager());
                return MoshResult::failure (error::internalError, "deliberate failure after mutation");
            });
        }
    };
}

TEST_CASE ("command surface: scripted create_track + import_clip drives results/events/log/snapshot", "[surface]")
{
    Harness h;
    REQUIRE (h.exec.getSnapshot()["tracks"].size() == 0);

    auto r1 = h.exec.execute ("create_track", argObj ({ { "name", "Vocal" } }));
    REQUIRE (r1.ok);
    REQUIRE (r1.changedEntities.contains ("track:1"));
    REQUIRE (r1.data["id"].toString() == "track:1");
    REQUIRE (countType (h.events, "track_added") == 1);
    REQUIRE (h.log.size() == 1);

    auto s1 = h.exec.getSnapshot();
    REQUIRE (s1["tracks"].size() == 1);
    REQUIRE (s1["tracks"][0]["name"].toString() == "Vocal");
    REQUIRE (s1["tracks"][0]["id"].toString() == "track:1");

    auto r2 = h.exec.execute ("import_clip",
        argObj ({ { "track", "track:1" }, { "path", "x.wav" }, { "start", 12.0 }, { "length", 4.0 } }));
    REQUIRE (r2.ok);
    REQUIRE (countType (h.events, "clip_added") == 1);
    REQUIRE (h.log.size() == 2);

    auto s2 = h.exec.getSnapshot();
    REQUIRE (s2["tracks"][0]["clips"].size() == 1);
    REQUIRE ((double) s2["tracks"][0]["clips"][0]["range"][0] == 12.0);
    REQUIRE ((double) s2["tracks"][0]["clips"][0]["range"][1] == 16.0);

    // The JSONL log is a clean semantic trail: exactly the two commands, in order.
    auto line0 = juce::JSON::parse (h.log.lines()[0]);
    REQUIRE (line0["cmd"].toString() == "create_track");
    REQUIRE ((bool) line0["ok"] == true);
    auto line1 = juce::JSON::parse (h.log.lines()[1]);
    REQUIRE (line1["cmd"].toString() == "import_clip");
}

TEST_CASE ("command surface: validation failure abandons the transaction (no partial mutation)", "[surface]")
{
    Harness h;
    h.exec.execute ("create_track", argObj ({ { "name", "T" } }));
    const int before = h.exec.getSnapshot()["tracks"].size();

    auto bad = h.exec.execute ("import_clip", argObj ({ { "track", "track:999" }, { "path", "x.wav" } }));
    REQUIRE_FALSE (bad.ok);
    REQUIRE (bad.errorCode == juce::String (error::noSuchTrack));
    REQUIRE (h.exec.getSnapshot()["tracks"].size() == before);   // unchanged

    // The failed attempt is still logged (semantic audit trail), marked ok:false.
    REQUIRE (h.log.size() == 2);
    auto last = juce::JSON::parse (h.log.lines()[1]);
    REQUIRE ((bool) last["ok"] == false);
    REQUIRE (last["error_code"].toString() == juce::String (error::noSuchTrack));

    // Mutate-then-fail must roll back the partial mutation.
    const int tracksBefore = h.exec.getSnapshot()["tracks"].size();
    auto buggy = h.exec.execute ("buggy_mutate_then_fail");
    REQUIRE_FALSE (buggy.ok);
    REQUIRE (h.exec.getSnapshot()["tracks"].size() == tracksBefore);
}

TEST_CASE ("command surface: undo/redo via MoshOps reverts and restores state", "[surface]")
{
    Harness h;
    h.exec.execute ("create_track", argObj ({ { "name", "A" } }));
    h.exec.execute ("import_clip", argObj ({ { "track", "track:1" }, { "path", "x.wav" }, { "start", 0.0 }, { "length", 2.0 } }));
    REQUIRE (h.exec.getSnapshot()["tracks"][0]["clips"].size() == 1);

    h.events.clear();
    auto u1 = h.exec.execute ("undo");
    REQUIRE (u1.ok);
    REQUIRE (countType (h.events, "snapshot_invalidated") == 1);
    REQUIRE (h.exec.getSnapshot()["tracks"][0]["clips"].size() == 0);   // clip undone

    h.exec.execute ("undo");
    REQUIRE (h.exec.getSnapshot()["tracks"].size() == 0);               // track undone

    h.exec.execute ("redo");
    REQUIRE (h.exec.getSnapshot()["tracks"].size() == 1);               // track restored
    REQUIRE (h.exec.getSnapshot()["tracks"][0]["clips"].size() == 0);
}

TEST_CASE ("command surface: unknown command yields UNKNOWN_COMMAND and is logged", "[surface]")
{
    Harness h;
    auto r = h.exec.execute ("frobnicate", juce::var());
    REQUIRE_FALSE (r.ok);
    REQUIRE (r.errorCode == juce::String (error::unknownCommand));
    REQUIRE (h.log.size() == 1);
    REQUIRE (h.exec.hasCommand ("undo"));   // built-ins are registered
    REQUIRE (h.exec.hasCommand ("redo"));
}
