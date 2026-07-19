// M1 — the native agent-memory store (Phase-B memory lane; see the approved plan in
// agent memory + docs/agent-bench/). Pure, engine-free path / JSONL / cap / eviction
// helpers — juce_core + juce_data_structures ONLY (no tracktion_engine) — so
// tests/test_agent_memory.cpp can exercise the whole contract hermetically, without a
// Tracktion engine. MoshOps::cmdAgentMemoryRead/cmdAgentMemoryWrite (MoshOps.cpp) are
// thin orchestration wrappers around these: they add the engine-specific bits (the
// current edit file for the project sidecar path, logLine on writes, arg validation)
// and stay out of the pure logic below.
//
// Two scopes:
//   * global  — MOSH_AGENT_DIR env override, else ~/Library/Mosh/agent/:
//                 preferences.jsonl · patterns/drums.jsonl · patterns/lyrics.jsonl ·
//                 meta.json ({v:1}, stamped on first global write, otherwise untouched)
//   * project — a sidecar JSON next to the edit file: <edit>.mosh-memory.json,
//                 { v:1, notes:[ {ts,kind,explicit,item}, ... ] }. cmdSaveAs copies the
//                 sidecar to the new location, mirroring RenderArtifacts.h's Save-As
//                 artifact-consolidation posture (a Tier-B cacheArtifact is a different
//                 kind of sidecar, but the "copy alongside the engine's own
//                 consolidation" shape is the same).
//
// Every store file (a global kind file, or the project sidecar's `notes` array) is
// capped at kMaxItemsPerStore. Eviction policy (decideEviction, pure):
//   * plenty of room               -> no eviction, just append
//   * at cap, ANY new item         -> evict the OLDEST NON-explicit item, if one exists
//   * at cap, store is ALL explicit, new item is NON-explicit -> REJECTED (explicit
//     items are never evicted to make room for derived/non-explicit ones)
//   * at cap, store is ALL explicit, new item IS explicit     -> evict the oldest
//     explicit item (index 0 — the only case where an explicit item is ever evicted)
//
// Ordering: every array here is OLDEST-FIRST (JSONL append order / sidecar array
// order), so "oldest" is always index 0 after any prior eviction — no timestamp
// comparison needed for eviction, and reading a SINGLE store newest-first is simply
// its reverse (selectForRead) — no timestamp comparison needed there either.
//
// The exception is the unfiltered global read (kind omitted): it interleaves THREE
// separate store files, which have no shared position to reverse, so it falls back to
// sorting by the recorded `ts`. Plain wall-clock milliseconds are NOT safe for this:
// two writes issued back-to-back (exactly what a scripted caller / --selftest does)
// routinely land in the same millisecond, and a naive ts-descending stable sort then
// preserves insertion order on the tie — i.e. OLDEST first, the opposite of the
// contract. (Reproduced: --selftest's AGT-MEM section failed "agent_memory_read is
// newest-first" on the very first run, entirely within ONE store, before this fix.)
// nextTs() below fixes this at the source: a hybrid logical clock (wall-clock ms,
// nudged forward just enough to stay strictly ahead of the previous value), so no two
// records from one process run ever compare equal — and, unlike an earlier bit-packed
// version, the result stays within JS's safe-integer range when it round-trips
// through the WebView bridge as JSON (see nextTs()'s own comment for the story).

#pragma once

#include <juce_core/juce_core.h>
#include <juce_data_structures/juce_data_structures.h>
#include <algorithm>
#include <atomic>
#include <vector>

namespace mosh
{

struct AgentMemoryStore
{
    static constexpr int kMaxItemsPerStore = 500;

    // ------------------------------------------------------------------ paths ----

    /** Raw MOSH_AGENT_DIR (trimmed; empty if unset/blank). Split out from
        resolveGlobalRoot() so pure unit tests can drive the override WITHOUT mutating
        the process environment. */
    static juce::String envOverride()
    {
        return juce::SystemStats::getEnvironmentVariable ("MOSH_AGENT_DIR", {}).trim();
    }

    /** Pure: the global root for a given override string (empty ⇒ the real default,
        ~/Library/Mosh/agent — the same userApplicationDataDirectory/"Mosh" base
        MoshEngine's session dir and GenerativeJobManager's service-state dir use). */
    static juce::File resolveGlobalRoot (const juce::String& overrideDir)
    {
        if (overrideDir.isNotEmpty())
            return juce::File (overrideDir);
        return juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
                   .getChildFile ("Mosh").getChildFile ("agent");
    }

    /** The live global root. Reads MOSH_AGENT_DIR fresh on every call (never cached) so
        a harness's per-process pin always wins, matching the SLF-CONC-001 posture
        elsewhere in the engine (SessionPaths.h). */
    static juce::File globalRoot() { return resolveGlobalRoot (envOverride()); }

    /** kind -> relative filename under the global root, or empty for an unrecognized
        kind (the global-scope kind vocabulary is closed; project-scope kinds are not). */
    static juce::String globalKindFile (const juce::String& kind)
    {
        if (kind == "preference")      return "preferences.jsonl";
        if (kind == "drum_pattern")    return "patterns/drums.jsonl";
        if (kind == "lyric_framework") return "patterns/lyrics.jsonl";
        return {};
    }

    static bool isValidGlobalKind (const juce::String& kind) { return globalKindFile (kind).isNotEmpty(); }

    /** Every known global kind, fixed order — drives an unfiltered (all-kinds) read. */
    static juce::StringArray allGlobalKinds() { return { "preference", "drum_pattern", "lyric_framework" }; }

    static juce::File globalStoreFile (const juce::File& root, const juce::String& kind)
    {
        const auto rel = globalKindFile (kind);
        return rel.isEmpty() ? juce::File() : root.getChildFile (rel);
    }

    /** The per-project sidecar: <edit file>.mosh-memory.json, a SIBLING of the edit
        file (not a node inside it), so save/reload of the .tracktionedit itself never
        touches it. */
    static juce::File sidecarFileFor (const juce::File& editFile)
    {
        return editFile.getParentDirectory().getChildFile (editFile.getFileName() + ".mosh-memory.json");
    }

    // --------------------------------------------------------------- JSONL I/O ----

    /** Parses JSONL text into an ordered array (oldest first == file order). Blank
        lines are skipped; a malformed line is dropped rather than aborting the whole
        read — a hand-edited or partially-written file degrades, it doesn't brick the
        store. */
    static juce::Array<juce::var> parseJsonl (const juce::String& text)
    {
        juce::Array<juce::var> items;
        for (const auto& line : juce::StringArray::fromLines (text))
        {
            if (line.trim().isEmpty()) continue;
            auto v = juce::JSON::fromString (line);
            if (v.isObject()) items.add (v);
        }
        return items;
    }

    static juce::String toJsonl (const juce::Array<juce::var>& items)
    {
        juce::String out;
        for (auto& it : items) out << juce::JSON::toString (it, true) << "\n";
        return out;
    }

    /** A missing file is an empty store — not an error; that's the common case before
        the first write. */
    static juce::Array<juce::var> readJsonlFile (const juce::File& f)
    {
        if (! f.existsAsFile()) return {};
        return parseJsonl (f.loadFileAsString());
    }

    /** Rewrites the whole file. The store is capped at kMaxItemsPerStore, so a full
        rewrite on every write is cheap — no append-only fast path needed. */
    static bool writeJsonlFile (const juce::File& f, const juce::Array<juce::var>& items)
    {
        auto dir = f.getParentDirectory();
        if (! dir.isDirectory() && ! dir.createDirectory().wasOk())
            return false;
        return f.replaceWithText (toJsonl (items));
    }

    // ------------------------------------------------------------ sidecar (project) ----

    /** Reads the project sidecar's `notes` array. Missing file / malformed JSON / wrong
        shape all degrade to an empty store, same posture as readJsonlFile. */
    static juce::Array<juce::var> readSidecarNotes (const juce::File& sidecar)
    {
        if (! sidecar.existsAsFile()) return {};
        auto v = juce::JSON::fromString (sidecar.loadFileAsString());
        if (! v.isObject()) return {};
        juce::Array<juce::var> out;
        if (auto* arr = v.getProperty ("notes", juce::var()).getArray())
            for (auto& n : *arr)
                if (n.isObject()) out.add (n);
        return out;
    }

    static bool writeSidecarNotes (const juce::File& sidecar, const juce::Array<juce::var>& notes)
    {
        auto dir = sidecar.getParentDirectory();
        if (! dir.isDirectory() && ! dir.createDirectory().wasOk())
            return false;
        auto* o = new juce::DynamicObject();
        o->setProperty ("v", 1);
        o->setProperty ("notes", notes);
        return sidecar.replaceWithText (juce::JSON::toString (juce::var (o), true));
    }

    /** Copies a project sidecar (if any) alongside a Save-As, mirroring
        RenderArtifacts.h's consolidation posture. A missing source sidecar is a
        silent no-op (nothing written yet — not an error). Overwrites any pre-existing
        sidecar at the destination (Save-As always wants the CURRENT session's memory,
        matching how eng.saveProjectAs replaces the destination edit file itself). */
    static bool copySidecarForSaveAs (const juce::File& oldEditFile, const juce::File& newEditFile)
    {
        const auto src = sidecarFileFor (oldEditFile);
        if (! src.existsAsFile()) return true;   // nothing to carry over — not a failure
        const auto dest = sidecarFileFor (newEditFile);
        if (src == dest) return true;
        dest.deleteFile();
        return src.copyFileTo (dest);
    }

    // ---------------------------------------------------------------- meta.json ----

    /** Stamps meta.json {v:1} the first time the global root is ever written to.
        Idempotent — a pre-existing meta.json is left untouched; best-effort (a failure
        here must never block the actual write it's paired with). */
    static void ensureGlobalMeta (const juce::File& root)
    {
        auto meta = root.getChildFile ("meta.json");
        if (meta.existsAsFile()) return;
        if (! root.isDirectory()) root.createDirectory();
        auto* o = new juce::DynamicObject();
        o->setProperty ("v", 1);
        meta.replaceWithText (juce::JSON::toString (juce::var (o), true));
    }

    // ----------------------------------------------------------- cap / eviction ----

    struct EvictDecision
    {
        bool allowed = true;
        int evictIndex = -1;      // -1 == no eviction needed/performed
        juce::String error;       // set only when allowed == false
    };

    /** Pure eviction policy (see file header). @p existing is oldest-first, so "the
        oldest X" is simply the first matching index — no timestamp comparison needed. */
    static EvictDecision decideEviction (const juce::Array<juce::var>& existing,
                                         bool newItemExplicit,
                                         int cap = kMaxItemsPerStore)
    {
        EvictDecision d;
        if (existing.size() < cap) return d;   // room — no eviction needed

        for (int i = 0; i < existing.size(); ++i)
            if (! (bool) existing.getReference (i).getProperty ("explicit", false))
            { d.evictIndex = i; return d; }   // an oldest non-explicit item always yields first

        // Every stored item is explicit.
        if (! newItemExplicit)
        {
            d.allowed = false;
            d.error = "memory full of explicit items -- remove one first";
            return d;
        }
        d.evictIndex = 0;   // the new item IS explicit: evict the oldest explicit one
        return d;
    }

    /** A hybrid logical clock: wall-clock milliseconds, nudged forward by whatever it
        takes to stay strictly ahead of the PREVIOUS value this process returned —
        `max(nowMs, lastTs + 1)`. Guarantees no two records from one process run ever
        compare equal (a `ts`-descending sort never falls back to insertion order on
        a tie — see the file header for why a raw millisecond timestamp alone is NOT
        safe here), while staying numerically equal to real wall-clock ms except
        during an actual same-millisecond burst (where it drifts at most a few units
        ahead, then real time catches back up on the next tick).
        DELIBERATELY NOT bit-packed (an earlier version folded a tie-breaker into the
        low 20 bits of `ms << 20`): that produced values around 1.9e18 — 200x past
        Number.MAX_SAFE_INTEGER (2^53 ≈ 9.007e15) — silently losing precision the
        moment a record's `ts` crosses the WebView bridge as JSON and gets parsed by
        JS as a double. M3's agent_memory_delete round-trips a `ts` value THROUGH
        JS (read it from a prior agent_memory_read, send it back to delete-by-ts), so
        that precision loss would make deletes intermittently fail with "not found."
        A plain incrementing ms-based value stays JS-safe for centuries. */
    static juce::int64 nextTs()
    {
        static std::atomic<juce::int64> lastTs { 0 };
        juce::int64 prev = lastTs.load (std::memory_order_relaxed);
        juce::int64 next;
        for (;;)
        {
            const auto nowMs = juce::Time::getCurrentTime().toMilliseconds();
            next = juce::jmax (nowMs, prev + 1);
            if (lastTs.compare_exchange_weak (prev, next, std::memory_order_relaxed))
                break;
            // compare_exchange_weak refreshed `prev` to the current value on failure
            // (another thread raced us) -- loop retries against that fresh value.
        }
        return next;
    }

    /** Builds the {ts,kind,explicit,item} record written verbatim to a store. */
    static juce::var makeRecord (const juce::String& kind, bool explicitFlag, const juce::var& item)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty ("ts", nextTs());
        o->setProperty ("kind", kind);
        o->setProperty ("explicit", explicitFlag);
        o->setProperty ("item", item);
        return juce::var (o);
    }

    /** Applies one write to @p items IN PLACE: evicts per decideEviction() then
        appends @p record. Returns false (items left UNCHANGED) with @p error set when
        the cap rejects the write. */
    static bool applyWrite (juce::Array<juce::var>& items, const juce::var& record,
                            juce::String& error, int cap = kMaxItemsPerStore)
    {
        const bool newExplicit = (bool) record.getProperty ("explicit", false);
        auto decision = decideEviction (items, newExplicit, cap);
        if (! decision.allowed) { error = decision.error; return false; }
        if (decision.evictIndex >= 0) items.remove (decision.evictIndex);
        items.add (record);
        return true;
    }

    // ------------------------------------------------------------------- reads ----

    /** Newest-first for a SINGLE store's contents (already oldest-first / append
        order) — simply the reverse, capped to @p limit (<=0 == no cap). No timestamp
        comparison: within one store, array position already IS chronological order,
        exactly and always (unlike `ts`, which can collide — see the file header). Used
        for a kind-filtered global read and for the project sidecar's notes. */
    static juce::Array<juce::var> selectForRead (const juce::Array<juce::var>& items, int limit)
    {
        juce::Array<juce::var> out;
        for (int i = items.size() - 1; i >= 0; --i)
        {
            out.add (items.getReference (i));
            if (limit > 0 && out.size() >= limit) break;
        }
        return out;
    }

    /** Reads global-scope items, newest-first, capped to @p limit (<=0 == no cap).
        @p kindFilter set ⇒ delegates straight to selectForRead (one store, exact
        order). @p kindFilter empty ⇒ merges all three kind stores — the only place
        that needs a cross-store ordering key, since there is no single array to
        reverse — sorted by the (collision-proofed, see nextTs()) `ts`. (Eviction never
        calls this — writes read/write ONE kind's file directly via globalStoreFile.) */
    static juce::Array<juce::var> readGlobal (const juce::File& root, const juce::String& kindFilter, int limit)
    {
        if (kindFilter.isNotEmpty())
            return selectForRead (readJsonlFile (globalStoreFile (root, kindFilter)), limit);

        juce::Array<juce::var> merged;
        for (auto& kind : allGlobalKinds())
            merged.addArray (readJsonlFile (globalStoreFile (root, kind)));   // oldest-first within each block

        std::vector<int> order (static_cast<size_t> (merged.size()));
        for (int i = 0; i < merged.size(); ++i) order[static_cast<size_t> (i)] = i;
        std::stable_sort (order.begin(), order.end(), [&] (int a, int b)
        {
            return (juce::int64) merged.getReference (a).getProperty ("ts", 0)
                 > (juce::int64) merged.getReference (b).getProperty ("ts", 0);
        });

        juce::Array<juce::var> out;
        for (int idx : order)
        {
            out.add (merged.getReference (idx));
            if (limit > 0 && out.size() >= limit) break;
        }
        return out;
    }

    // ------------------------------------------------------- delete / clear (M3) ----

    /** Deletes the item whose `ts` matches @p ts from @p items IN PLACE (there is at
        most one — nextTs() is unique per process run). @p kindFilter, when non-empty,
        additionally requires that item's `kind` to match — used by the project-scope
        delete path as a safety check (ts alone already locates it uniquely; a
        supplied kind that doesn't match the found item is a caller mistake, not a
        silent success) and is irrelevant to the global-scope path (there, `kind`
        already selected WHICH FILE `items` came from, so pass "" there). Returns
        true iff something was removed. */
    static bool deleteByTsAndKind (juce::Array<juce::var>& items, juce::int64 ts,
                                   const juce::String& kindFilter)
    {
        for (int i = 0; i < items.size(); ++i)
        {
            const auto& it = items.getReference (i);
            if ((juce::int64) it.getProperty ("ts", 0) != ts) continue;
            if (kindFilter.isNotEmpty() && it.getProperty ("kind", juce::var()).toString() != kindFilter)
                continue;
            items.remove (i);
            return true;
        }
        return false;
    }

    /** Removes every item in @p items IN PLACE whose `kind` matches @p kindFilter, or
        EVERY item when @p kindFilter is empty. Returns the number removed. Used by
        the project-scope clear path (global-scope clear instead wipes a whole kind
        FILE — see cmdAgentMemoryClear — since a global kind IS a file, not a
        per-item field to filter on). */
    static int clearMatchingKind (juce::Array<juce::var>& items, const juce::String& kindFilter)
    {
        if (kindFilter.isEmpty())
        {
            const int n = items.size();
            items.clearQuick();
            return n;
        }
        int removed = 0;
        for (int i = items.size() - 1; i >= 0; --i)
            if (items.getReference (i).getProperty ("kind", juce::var()).toString() == kindFilter)
            { items.remove (i); ++removed; }
        return removed;
    }
};

} // namespace mosh
