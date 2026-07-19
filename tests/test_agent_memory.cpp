// AGT-MEM (Phase-B memory lane, M1) — the native agent-memory store.
//
// Pure, engine-free units for src/moshops/AgentMemoryStore.h: path resolution, JSONL
// round-trip, the sidecar's `notes` array, meta.json stamping, Save-As sidecar
// copying, and — the load-bearing part — the cap/eviction policy (decideEviction /
// applyWrite) and the newest-first read sort. The end-to-end command surface
// (agent_memory_read/write via MoshOps::execute, including the "at cap over the real
// command path" + undo-non-interference proofs) is covered by the AGT-MEM section of
// `Mosh --selftest` (src/app/SelfTest.cpp).

#include <catch2/catch_test_macros.hpp>
#include <juce_core/juce_core.h>
#include <juce_data_structures/juce_data_structures.h>

#include "moshops/AgentMemoryStore.h"

using namespace mosh;
using juce::var;
using juce::String;
using juce::File;
using juce::DynamicObject;
using juce::Array;

namespace
{
    var obj (std::initializer_list<std::pair<const char*, var>> kv)
    {
        auto* o = new DynamicObject();
        for (auto& p : kv) o->setProperty (p.first, p.second);
        return var (o);
    }

    var record (juce::int64 ts, const String& kind, bool explicitFlag, const var& item)
    {
        auto* o = new DynamicObject();
        o->setProperty ("ts", ts);
        o->setProperty ("kind", kind);
        o->setProperty ("explicit", explicitFlag);
        o->setProperty ("item", item);
        return var (o);
    }

    // A fresh scratch dir under the system temp dir, unique per call — this test file
    // never touches ~/Library/Mosh (it drives AgentMemoryStore's pure functions
    // directly with explicit File args, never through the env-reading globalRoot()).
    File scratchDir (const String& leaf)
    {
        auto d = File::getSpecialLocation (File::tempDirectory)
                    .getChildFile ("mosh-agentmemory-test-" + juce::Uuid().toString().substring (0, 8) + "-" + leaf);
        d.deleteRecursively();
        d.createDirectory();
        return d;
    }
}

// ───────────────────────────── paths ─────────────────────────────

TEST_CASE ("resolveGlobalRoot: an override wins verbatim; empty falls back to the default", "[agentmemory][paths]")
{
    REQUIRE (AgentMemoryStore::resolveGlobalRoot ("/tmp/some-override").getFullPathName() == "/tmp/some-override");

    const auto fallback = AgentMemoryStore::resolveGlobalRoot ("");
    REQUIRE (fallback.getFileName() == "agent");
    REQUIRE (fallback.getParentDirectory().getFileName() == "Mosh");
}

TEST_CASE ("globalKindFile: the three recognized kinds map to distinct files; anything else is invalid", "[agentmemory][paths]")
{
    REQUIRE (AgentMemoryStore::globalKindFile ("preference") == "preferences.jsonl");
    REQUIRE (AgentMemoryStore::globalKindFile ("drum_pattern") == "patterns/drums.jsonl");
    REQUIRE (AgentMemoryStore::globalKindFile ("lyric_framework") == "patterns/lyrics.jsonl");
    REQUIRE (AgentMemoryStore::globalKindFile ("nonsense") == "");

    REQUIRE (AgentMemoryStore::isValidGlobalKind ("preference"));
    REQUIRE (AgentMemoryStore::isValidGlobalKind ("drum_pattern"));
    REQUIRE (AgentMemoryStore::isValidGlobalKind ("lyric_framework"));
    REQUIRE_FALSE (AgentMemoryStore::isValidGlobalKind ("note"));   // "note" is a PROJECT-scope default, not global
    REQUIRE_FALSE (AgentMemoryStore::isValidGlobalKind (""));
}

TEST_CASE ("sidecarFileFor: a sibling of the edit file, name-suffixed", "[agentmemory][paths]")
{
    const File edit ("/Users/x/Music/song.tracktionedit");
    const auto sidecar = AgentMemoryStore::sidecarFileFor (edit);
    REQUIRE (sidecar.getFullPathName() == "/Users/x/Music/song.tracktionedit.mosh-memory.json");
    REQUIRE (sidecar.getParentDirectory() == edit.getParentDirectory());
}

// ───────────────────────────── JSONL round-trip ─────────────────────────────

TEST_CASE ("JSONL round-trip: write then read reproduces the same records in order", "[agentmemory][jsonl]")
{
    auto dir = scratchDir ("jsonl");
    auto file = dir.getChildFile ("store.jsonl");

    Array<var> items;
    items.add (record (1, "preference", false, "likes wide drums"));
    items.add (record (2, "preference", true, obj ({ { "note", "always use slant rhyme" } })));

    REQUIRE (AgentMemoryStore::writeJsonlFile (file, items));
    REQUIRE (file.existsAsFile());

    auto back = AgentMemoryStore::readJsonlFile (file);
    REQUIRE (back.size() == 2);
    REQUIRE (back[0].getProperty ("item", var()).toString() == "likes wide drums");
    REQUIRE ((bool) back[1].getProperty ("explicit", false) == true);
    REQUIRE (back[1].getProperty ("item", var()).getProperty ("note", var()).toString() == "always use slant rhyme");
}

TEST_CASE ("readJsonlFile: a missing file is an empty store, not an error", "[agentmemory][jsonl]")
{
    auto dir = scratchDir ("jsonl-missing");
    auto ghost = dir.getChildFile ("nope.jsonl");
    REQUIRE_FALSE (ghost.existsAsFile());
    REQUIRE (AgentMemoryStore::readJsonlFile (ghost).isEmpty());
}

TEST_CASE ("parseJsonl: blank lines and malformed lines are dropped, not fatal", "[agentmemory][jsonl]")
{
    const String text = "{\"a\":1}\n\n   \nnot json at all\n{\"b\":2}\n";
    auto items = AgentMemoryStore::parseJsonl (text);
    REQUIRE (items.size() == 2);
    REQUIRE ((int) items[0].getProperty ("a", 0) == 1);
    REQUIRE ((int) items[1].getProperty ("b", 0) == 2);
}

// ───────────────────────────── sidecar (project scope) ─────────────────────────────

TEST_CASE ("sidecar notes round-trip through {v:1, notes:[...]}", "[agentmemory][sidecar]")
{
    auto dir = scratchDir ("sidecar");
    auto sidecar = dir.getChildFile ("song.tracktionedit.mosh-memory.json");

    Array<var> notes;
    notes.add (record (10, "note", false, "verse 2 needs a stronger hook"));
    REQUIRE (AgentMemoryStore::writeSidecarNotes (sidecar, notes));

    auto raw = juce::JSON::fromString (sidecar.loadFileAsString());
    REQUIRE ((int) raw.getProperty ("v", 0) == 1);

    auto back = AgentMemoryStore::readSidecarNotes (sidecar);
    REQUIRE (back.size() == 1);
    REQUIRE (back[0].getProperty ("item", var()).toString() == "verse 2 needs a stronger hook");
}

TEST_CASE ("readSidecarNotes degrades gracefully: missing file / malformed JSON / wrong shape", "[agentmemory][sidecar]")
{
    auto dir = scratchDir ("sidecar-bad");

    REQUIRE (AgentMemoryStore::readSidecarNotes (dir.getChildFile ("missing.json")).isEmpty());

    auto garbage = dir.getChildFile ("garbage.json");
    garbage.replaceWithText ("{ not json");
    REQUIRE (AgentMemoryStore::readSidecarNotes (garbage).isEmpty());

    auto wrongShape = dir.getChildFile ("wrongshape.json");
    wrongShape.replaceWithText ("[1,2,3]");   // valid JSON, but not an object
    REQUIRE (AgentMemoryStore::readSidecarNotes (wrongShape).isEmpty());
}

TEST_CASE ("copySidecarForSaveAs: carries the sidecar to the new edit's location", "[agentmemory][sidecar][saveas]")
{
    auto dir = scratchDir ("saveas");
    File oldEdit = dir.getChildFile ("old").getChildFile ("song.tracktionedit");
    oldEdit.getParentDirectory().createDirectory();
    File newEdit = dir.getChildFile ("new").getChildFile ("song-renamed.tracktionedit");
    newEdit.getParentDirectory().createDirectory();

    Array<var> notes;
    notes.add (record (1, "note", true, "explicit take-note"));
    REQUIRE (AgentMemoryStore::writeSidecarNotes (AgentMemoryStore::sidecarFileFor (oldEdit), notes));

    REQUIRE (AgentMemoryStore::copySidecarForSaveAs (oldEdit, newEdit));

    auto carried = AgentMemoryStore::readSidecarNotes (AgentMemoryStore::sidecarFileFor (newEdit));
    REQUIRE (carried.size() == 1);
    REQUIRE (carried[0].getProperty ("item", var()).toString() == "explicit take-note");
}

TEST_CASE ("copySidecarForSaveAs: no source sidecar is a silent success, not a failure", "[agentmemory][sidecar][saveas]")
{
    auto dir = scratchDir ("saveas-none");
    File oldEdit = dir.getChildFile ("old.tracktionedit");
    File newEdit = dir.getChildFile ("new.tracktionedit");
    REQUIRE (AgentMemoryStore::copySidecarForSaveAs (oldEdit, newEdit));
    REQUIRE_FALSE (AgentMemoryStore::sidecarFileFor (newEdit).existsAsFile());
}

// ───────────────────────────── meta.json ─────────────────────────────

TEST_CASE ("ensureGlobalMeta: stamps {v:1} once, then leaves it alone", "[agentmemory][meta]")
{
    auto root = scratchDir ("meta");
    auto meta = root.getChildFile ("meta.json");
    REQUIRE_FALSE (meta.existsAsFile());

    AgentMemoryStore::ensureGlobalMeta (root);
    REQUIRE (meta.existsAsFile());
    auto v1 = juce::JSON::fromString (meta.loadFileAsString());
    REQUIRE ((int) v1.getProperty ("v", 0) == 1);

    // Tamper with it, then call again: a pre-existing meta.json must NOT be rewritten.
    meta.replaceWithText ("{\"v\":1,\"custom\":\"kept\"}");
    AgentMemoryStore::ensureGlobalMeta (root);
    auto v2 = juce::JSON::fromString (meta.loadFileAsString());
    REQUIRE (v2.getProperty ("custom", var()).toString() == "kept");
}

// ───────────────────────────── cap / eviction (the load-bearing logic) ─────────────────────────────

TEST_CASE ("decideEviction: below cap never evicts", "[agentmemory][evict]")
{
    Array<var> items;
    for (int i = 0; i < 3; ++i) items.add (record (i, "preference", false, String (i)));

    auto d = AgentMemoryStore::decideEviction (items, false, /*cap*/ 5);
    REQUIRE (d.allowed);
    REQUIRE (d.evictIndex == -1);

    auto d2 = AgentMemoryStore::decideEviction (items, true, /*cap*/ 5);
    REQUIRE (d2.allowed);
    REQUIRE (d2.evictIndex == -1);
}

TEST_CASE ("decideEviction: at cap, a non-explicit write evicts the OLDEST non-explicit item", "[agentmemory][evict]")
{
    // oldest-first: index 0 is the oldest.
    Array<var> items;
    items.add (record (0, "k", true,  "explicit-0"));    // explicit — must survive
    items.add (record (1, "k", false, "derived-1"));      // oldest NON-explicit — must be evicted
    items.add (record (2, "k", false, "derived-2"));

    auto d = AgentMemoryStore::decideEviction (items, /*newExplicit*/ false, /*cap*/ 3);
    REQUIRE (d.allowed);
    REQUIRE (d.evictIndex == 1);   // NOT 0 — explicit items are skipped over
}

TEST_CASE ("decideEviction: at cap, an EXPLICIT write ALSO evicts the oldest non-explicit item first", "[agentmemory][evict]")
{
    Array<var> items;
    items.add (record (0, "k", true,  "explicit-0"));
    items.add (record (1, "k", false, "derived-1"));
    items.add (record (2, "k", false, "derived-2"));

    auto d = AgentMemoryStore::decideEviction (items, /*newExplicit*/ true, /*cap*/ 3);
    REQUIRE (d.allowed);
    REQUIRE (d.evictIndex == 1);   // a non-explicit victim is preferred even for an explicit incoming write
}

TEST_CASE ("decideEviction: all-explicit store REJECTS a non-explicit write", "[agentmemory][evict]")
{
    Array<var> items;
    for (int i = 0; i < 3; ++i) items.add (record (i, "k", true, String (i)));

    auto d = AgentMemoryStore::decideEviction (items, /*newExplicit*/ false, /*cap*/ 3);
    REQUIRE_FALSE (d.allowed);
    REQUIRE (d.evictIndex == -1);
    REQUIRE (d.error.isNotEmpty());
    REQUIRE (d.error.contains ("explicit"));
}

TEST_CASE ("decideEviction: all-explicit store lets an EXPLICIT write evict the oldest explicit item", "[agentmemory][evict]")
{
    Array<var> items;
    items.add (record (0, "k", true, "oldest-explicit"));
    items.add (record (1, "k", true, "mid-explicit"));
    items.add (record (2, "k", true, "newest-explicit"));

    auto d = AgentMemoryStore::decideEviction (items, /*newExplicit*/ true, /*cap*/ 3);
    REQUIRE (d.allowed);
    REQUIRE (d.evictIndex == 0);   // ONLY the oldest explicit item is ever a valid victim here
}

TEST_CASE ("applyWrite: RED-proof — a broken 'always evict index 0' policy fails this", "[agentmemory][evict]")
{
    // This is the RED-prove requested by the task: decideEviction's whole point is
    // that it does NOT just evict index 0 blindly. Simulate what a naive
    // "evict oldest, period" implementation would do and show it disagrees here.
    Array<var> items;
    items.add (record (0, "k", true,  "explicit-must-survive"));
    items.add (record (1, "k", false, "derived-should-go"));

    String error;
    auto working = items;
    REQUIRE (AgentMemoryStore::applyWrite (working, record (2, "k", false, "new"), error, /*cap*/ 2));
    REQUIRE (error.isEmpty());
    // The explicit item survived; the derived one was evicted; the new item appended.
    REQUIRE (working.size() == 2);
    REQUIRE (working[0].getProperty ("item", var()).toString() == "explicit-must-survive");
    REQUIRE (working[1].getProperty ("item", var()).toString() == "new");

    // A naive "evict index 0" policy would have removed the EXPLICIT item instead —
    // assert that is NOT what happened (this is the failing case if decideEviction's
    // explicit-skip loop were ever deleted/short-circuited).
    bool anyExplicitSurvived = false;
    for (auto& it : working) if ((bool) it.getProperty ("explicit", false)) anyExplicitSurvived = true;
    REQUIRE (anyExplicitSurvived);
}

TEST_CASE ("applyWrite: a rejected write leaves the items array COMPLETELY unchanged", "[agentmemory][evict]")
{
    Array<var> items;
    for (int i = 0; i < 2; ++i) items.add (record (i, "k", true, String (i)));
    auto before = items;

    String error;
    const bool wrote = AgentMemoryStore::applyWrite (items, record (99, "k", false, "rejected"), error, /*cap*/ 2);
    REQUIRE_FALSE (wrote);
    REQUIRE (error.isNotEmpty());
    REQUIRE (items.size() == before.size());
    for (int i = 0; i < items.size(); ++i)
        REQUIRE (items[i].getProperty ("item", var()).toString() == before[i].getProperty ("item", var()).toString());
}

TEST_CASE ("applyWrite: repeated writes at cap converge to a steady-state size", "[agentmemory][evict]")
{
    Array<var> items;
    for (int i = 0; i < 5; ++i) items.add (record (i, "k", false, String (i)));

    String error;
    for (int i = 5; i < 20; ++i)
    {
        REQUIRE (AgentMemoryStore::applyWrite (items, record (i, "k", false, String (i)), error, /*cap*/ 5));
        REQUIRE (items.size() == 5);
    }
    // Only the most recent 5 writes remain, oldest-first.
    REQUIRE (items[0].getProperty ("item", var()).toString() == "15");
    REQUIRE (items[4].getProperty ("item", var()).toString() == "19");
}

// ───────────────────────────── reads ─────────────────────────────

TEST_CASE ("selectForRead: newest-first is the reverse of oldest-first (no timestamp involved)", "[agentmemory][read]")
{
    // RED-PROOF context: two records sharing the SAME `ts` (a real hazard — see
    // makeRecord/nextTs()) must still come out newest-first, because selectForRead
    // never looks at `ts` at all; it trusts array position, which is exact.
    Array<var> items;
    items.add (record (100, "k", false, "first-written"));
    items.add (record (200, "k", false, "second-written"));
    items.add (record (200, "k", false, "third-written-same-ts"));   // ts TIES with #2 on purpose

    auto out = AgentMemoryStore::selectForRead (items, /*limit*/ 0);
    REQUIRE (out.size() == 3);
    REQUIRE (out[0].getProperty ("item", var()).toString() == "third-written-same-ts");   // written LAST -> first
    REQUIRE (out[1].getProperty ("item", var()).toString() == "second-written");
    REQUIRE (out[2].getProperty ("item", var()).toString() == "first-written");           // written FIRST -> last
}

TEST_CASE ("selectForRead: limit caps the returned count without reordering", "[agentmemory][read]")
{
    Array<var> items;
    for (int i = 0; i < 10; ++i) items.add (record (i, "k", false, String (i)));

    auto out = AgentMemoryStore::selectForRead (items, /*limit*/ 3);
    REQUIRE (out.size() == 3);
    REQUIRE (out[0].getProperty ("item", var()).toString() == "9");
    REQUIRE (out[1].getProperty ("item", var()).toString() == "8");
    REQUIRE (out[2].getProperty ("item", var()).toString() == "7");
}

TEST_CASE ("readGlobal: a kindFilter delegates to one store's exact (position-based) order", "[agentmemory][read]")
{
    auto root = scratchDir ("readglobal-kind");
    AgentMemoryStore::writeJsonlFile (AgentMemoryStore::globalStoreFile (root, "preference"),
        Array<var> { record (1, "preference", false, "older"), record (1, "preference", false, "newer") });

    auto onlyPref = AgentMemoryStore::readGlobal (root, "preference", /*limit*/ 0);
    REQUIRE (onlyPref.size() == 2);
    REQUIRE (onlyPref[0].getProperty ("item", var()).toString() == "newer");   // newest-first despite the tied ts

    auto onlyLyric = AgentMemoryStore::readGlobal (root, "lyric_framework", /*limit*/ 0);   // never written
    REQUIRE (onlyLyric.isEmpty());
}

TEST_CASE ("readGlobal: an empty kindFilter merges all three known kinds, sorted by ts", "[agentmemory][read]")
{
    auto root = scratchDir ("readglobal-merge");
    AgentMemoryStore::writeJsonlFile (AgentMemoryStore::globalStoreFile (root, "preference"),
        Array<var> { record (10, "preference", false, "pref-item") });
    AgentMemoryStore::writeJsonlFile (AgentMemoryStore::globalStoreFile (root, "drum_pattern"),
        Array<var> { record (20, "drum_pattern", false, "drum-item") });

    auto all = AgentMemoryStore::readGlobal (root, "", /*limit*/ 0);
    REQUIRE (all.size() == 2);
    REQUIRE (all[0].getProperty ("item", var()).toString() == "drum-item");   // higher ts -> first
    REQUIRE (all[1].getProperty ("item", var()).toString() == "pref-item");

    auto limited = AgentMemoryStore::readGlobal (root, "", /*limit*/ 1);
    REQUIRE (limited.size() == 1);
    REQUIRE (limited[0].getProperty ("item", var()).toString() == "drum-item");
}

TEST_CASE ("makeRecord/nextTs: back-to-back records never collide, even within one millisecond", "[agentmemory][read]")
{
    // The exact hazard this fixes: --selftest's AGT-MEM section issues two
    // agent_memory_write calls with nothing but C++ function-call overhead between
    // them, which is well under 1ms — a raw juce::Time::getCurrentTime().toMilliseconds()
    // reliably ties. nextTs() must never tie for any two calls in this process.
    juce::int64 prev = -1;
    bool everTied = false;
    for (int i = 0; i < 1000; ++i)
    {
        const auto t = AgentMemoryStore::nextTs();
        if (t == prev) everTied = true;
        REQUIRE (t > prev);   // strictly increasing, not just non-decreasing
        prev = t;
    }
    REQUIRE_FALSE (everTied);
}

// ───────────────────────────── the whole write pipeline, end-to-end at the store level ─────────────────────────────

TEST_CASE ("full write pipeline: read -> applyWrite -> writeJsonlFile round-trips through disk", "[agentmemory][pipeline]")
{
    auto dir = scratchDir ("pipeline");
    auto file = dir.getChildFile ("preferences.jsonl");

    auto writeOne = [&] (bool explicitFlag, const var& item) -> String
    {
        auto items = AgentMemoryStore::readJsonlFile (file);
        String error;
        if (! AgentMemoryStore::applyWrite (items, AgentMemoryStore::makeRecord ("preference", explicitFlag, item), error, /*cap*/ 3))
            return error;
        AgentMemoryStore::writeJsonlFile (file, items);
        return {};
    };

    REQUIRE (writeOne (true,  "likes 808s heavy").isEmpty());
    REQUIRE (writeOne (false, "recent: used slant rhyme").isEmpty());
    REQUIRE (writeOne (false, "recent: 140 bpm").isEmpty());
    // At cap (3) now: one explicit + two derived. A 4th derived write evicts the OLDEST derived.
    REQUIRE (writeOne (false, "recent: added a bridge").isEmpty());

    auto onDisk = AgentMemoryStore::readJsonlFile (file);
    REQUIRE (onDisk.size() == 3);
    juce::StringArray survivors;
    for (auto& r : onDisk) survivors.add (r.getProperty ("item", var()).toString());
    REQUIRE (survivors.contains ("likes 808s heavy"));               // explicit — survived
    REQUIRE_FALSE (survivors.contains ("recent: used slant rhyme")); // oldest derived — evicted
    REQUIRE (survivors.contains ("recent: 140 bpm"));
    REQUIRE (survivors.contains ("recent: added a bridge"));

    // Now fill to all-explicit and prove the reject path over the real disk round-trip.
    auto dir2 = scratchDir ("pipeline-explicit");
    auto file2 = dir2.getChildFile ("preferences.jsonl");
    Array<var> seeded;
    for (int i = 0; i < 3; ++i) seeded.add (AgentMemoryStore::makeRecord ("preference", true, "explicit-" + String (i)));
    AgentMemoryStore::writeJsonlFile (file2, seeded);

    auto items2 = AgentMemoryStore::readJsonlFile (file2);
    String error2;
    REQUIRE_FALSE (AgentMemoryStore::applyWrite (items2, AgentMemoryStore::makeRecord ("preference", false, "should-be-rejected"), error2, 3));
    REQUIRE (error2.isNotEmpty());
    // Nothing was written to disk (the command handler would bail before writeJsonlFile).
    auto stillOnDisk = AgentMemoryStore::readJsonlFile (file2);
    REQUIRE (stillOnDisk.size() == 3);
}
