// ── SelfTest.Ch10_multiplayer.cpp — runSelfTest chapter 10 (RFC 002 A-PR6) ──
// Sections moved VERBATIM from src/app/SelfTest.cpp (pre-split lines 2277-3598), in
// exact pre-split order. The ONLY in-section edits are the identifier adaptations
// forced by promoting compiler-enumerated cross-chapter locals into SelfTestCtx.

#include "app/SelfTest.h"
#include "SelfTestChapters.h"
#include "SelfTestSupport.h"
#include "engine/MoshEngine.h"
#include "engine/SessionPaths.h"
#include "moshops/MoshOps.h"
#include "moshops/AgentMemoryStore.h"
#include "plugins/spectral/MasterSpectralTapPlugin.h"
#include "state/Migrations.h"
#include "multiplayer/MultiplayerClient.h"
#include "multiplayer/MultiplayerSession.h"
#include "brain/BrainProxy.h"
#include "voice/NativeSpeech.h"
#include "util/Env.h"
#include <juce_cryptography/juce_cryptography.h>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <map>
#include <thread>
#include <vector>

namespace mosh
{
namespace
{
    // Thin forwarders keeping the exact pre-split free-function names/signatures,
    // bound to the shared harness state (same instance as SelfTest.cpp's shims).
    selftest::SelfTestCtx& gCtx = selftest::globalCtx();
    [[maybe_unused]] int& failures = gCtx.failures;
    [[maybe_unused]] int& checks   = gCtx.checks;

    [[maybe_unused]] inline void finishSection()                             { selftest::finishSection (gCtx); }
    [[maybe_unused]] inline void resetSections()                             { selftest::resetSections (gCtx); }
    [[maybe_unused]] inline void section (const juce::String& name)          { selftest::section (gCtx, name); }
    [[maybe_unused]] inline void section (const char* name)                  { selftest::section (gCtx, name); }
    [[maybe_unused]] inline void check (bool cond, const juce::String& what) { selftest::check (gCtx, cond, what); }
    [[maybe_unused]] inline void check (bool cond, const char* what)         { selftest::check (gCtx, cond, what); }

    using selftest::cmd;
    using selftest::args1;
    using selftest::objN;
    using selftest::ok;
    using selftest::tracks;
    using selftest::firstTrack;
    using selftest::trackClips;
    using selftest::trackSnapshotByLogicalId;
    using selftest::selftestTempPath;
}

void runChapter10_multiplayer (selftest::SelfTestCtx& ctx)
{
    using namespace juce;
    auto& eng = *ctx.eng;
    auto& ops = *ctx.ops;
    auto& eventTypes = ctx.eventTypes;
    auto& lastEvent = ctx.lastEvent;

    section ("Multiplayer: stable logical track IDs (MP-001)");
    {
        // The load-bearing multiplayer prerequisite: every track carries a stable
        // cross-peer UUID (moshLogicalId) that is distinct, non-empty, and survives
        // a save/reload — Tracktion's own EditItemID is allocator-dependent and so
        // differs per peer, which is why we cannot address tracks across peers by it.
        const int before = tracks (ops);
        check (ok (cmd (ops, "create_track", args1 ("name", "MP One"))), "create_track MP One ok");
        check (ok (cmd (ops, "create_track", args1 ("name", "MP Two"))), "create_track MP Two ok");

        auto idByName = [] (MoshOps& o, const juce::String& name) -> juce::String
        {
            auto snap = o.snapshot();   // keep the temporary alive (no dangling array)
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == name)
                        return tv.getProperty ("logicalId", juce::var()).toString();
            return {};
        };

        check (tracks (ops) >= before + 2, "two MP tracks present in snapshot");
        const auto id1 = idByName (ops, "MP One");
        const auto id2 = idByName (ops, "MP Two");
        check (id1.isNotEmpty(), "track 'MP One' has a non-empty logicalId");
        check (id2.isNotEmpty(), "track 'MP Two' has a non-empty logicalId");
        check (id1 != id2, "the two tracks have distinct logicalIds");
        check (id1.length() >= 32, "logicalId looks like a juce::Uuid string");

        // Identity is stable across a session reload (persisted on the track tree).
        check (ok (cmd (ops, "save")),   "save ok (MP-001)");
        check (ok (cmd (ops, "reload")), "reload ok (MP-001)");
        check (idByName (ops, "MP One") == id1 && id1.isNotEmpty(), "logicalId of 'MP One' survives save/reload");
        check (idByName (ops, "MP Two") == id2 && id2.isNotEmpty(), "logicalId of 'MP Two' survives save/reload");
    }

    section ("Multiplayer: track serialize/apply round-trip (P1b)");
    {
        // The core commit/apply mechanism, proven entirely in-process (no network):
        // serialize a track -> mutate it -> apply the blob -> the track is restored
        // byte-faithfully, WITHOUT touching the undo stack and WITHOUT emitting (so
        // a remote apply never echoes back to the relay).

        // Resolve the engine itemID of a track by display name (for command args).
        auto trackIdByName = [] (MoshOps& o, const juce::String& name) -> juce::String
        {
            auto snap = o.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == name)
                        return tv.getProperty ("id", juce::var()).toString();
            return {};
        };
        // Fetch a whole track var by its stable logicalId (to read restored fields).
        auto trackByLogicalId = [] (MoshOps& o, const juce::String& lid) -> juce::var
        {
            auto snap = o.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("logicalId", juce::var()).toString() == lid)
                        return tv;
            return {};
        };

        check (ok (cmd (ops, "create_track", args1 ("name", "RT Src"))), "create RT Src");
        const auto srcId = trackIdByName (ops, "RT Src");
        check (srcId.isNotEmpty(), "RT Src engine id resolved");

        // Give it real content: a wave clip, a MIDI clip with a note, a set volume.
        cmd (ops, "add_test_tone_clip", objN ({ { "trackId", srcId }, { "seconds", 1.0 } }));
        cmd (ops, "set_track_volume",   objN ({ { "trackId", srcId }, { "db", -6.5 } }));
        auto midiRes = cmd (ops, "add_midi_clip", objN ({ { "trackId", srcId } }));
        const auto midiClipId = midiRes.getProperty ("data", juce::var()).getProperty ("clipId", juce::var()).toString();
        check (midiClipId.isNotEmpty(), "RT Src midi clip created");
        cmd (ops, "add_note", objN ({ { "clipId", midiClipId }, { "pitch", 60 },
                                      { "beat", 0.0 }, { "length", 1.0 }, { "velocity", 100 } }));

        // Capture the original shape (clip count) before we serialize.
        auto clipCountOf = [] (const juce::var& tv) -> int
        {
            if (auto* a = tv["clips"].getArray()) return a->size();
            return 0;
        };
        // Resolve the source track's stable logicalId (for restored-state lookups).
        juce::String srcLid;
        {
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == "RT Src")
                        srcLid = tv.getProperty ("logicalId", juce::var()).toString();
        }
        const int origClipCount = clipCountOf (trackByLogicalId (ops, srcLid));
        check (origClipCount == 2, "RT Src has 2 clips (wave + midi) before serialize");
        const double srcVol = (double) trackByLogicalId (ops, srcLid).getProperty ("volumeDb", -99.0);
        check (std::abs (srcVol - (-6.5)) < 0.05, "RT Src volume is -6.5 pre-serialize (got " + juce::String (srcVol, 3) + ")");

        // 1) SERIALIZE
        auto serRes = cmd (ops, "mp_serialize_track", args1 ("trackId", srcId));
        check (ok (serRes), "mp_serialize_track ok");
        const auto blob = serRes.getProperty ("data", juce::var()).getProperty ("blob", juce::var()).toString();
        const auto lid  = serRes.getProperty ("data", juce::var()).getProperty ("logicalId", juce::var()).toString();
        check (blob.isNotEmpty(), "serialize produced a non-empty blob");
        check (lid == srcLid && lid.isNotEmpty(), "serialize reported the track's logicalId");

        // 2) MUTATE the live track away from the serialized state.
        cmd (ops, "rename_track",     objN ({ { "trackId", srcId }, { "name", "MUTATED" } }));
        cmd (ops, "set_track_volume", objN ({ { "trackId", srcId }, { "db", 0.0 } }));
        {   // remove every clip on RT Src
            auto snap = ops.snapshot();
            juce::StringArray clipIds;
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("id", juce::var()).toString() == srcId)
                        if (auto* cs = tv["clips"].getArray())
                            for (auto& cv : *cs)
                                clipIds.add (cv.getProperty ("id", juce::var()).toString());
            for (auto& cid : clipIds)
                cmd (ops, "remove_clip", args1 ("clipId", cid));
        }
        check (clipCountOf (trackByLogicalId (ops, lid)) == 0, "mutate removed all clips");

        // A sentinel: a freshly-created track is the TOP of the undo stack (create_
        // track is proven undoable). If apply does NOT push an undoable action, a
        // single undo after apply reverts THIS create, not the apply.
        cmd (ops, "create_track", args1 ("name", "RT Sentinel"));
        auto sentinelExists = [] (MoshOps& o) -> bool
        {
            auto snap = o.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == "RT Sentinel")
                        return true;
            return false;
        };
        check (sentinelExists (ops), "sentinel track present before apply");

        // 3) APPLY — zero-emit guard: clear captured events, apply, assert silence.
        eventTypes.clear();
        auto appRes = cmd (ops, "apply_remote_track", args1 ("blob", blob));
        check (ok (appRes), "apply_remote_track ok");
        check (appRes.getProperty ("data", juce::var()).getProperty ("mode", juce::var()).toString() == "replaced",
               "apply replaced the existing track (same logicalId)");
        juce::String evDump; for (auto& e : eventTypes) evDump << e << ",";
        bool emittedInvalidate = false;
        for (auto& e : eventTypes) if (e == "snapshot_invalidated") emittedInvalidate = true;
        check (! emittedInvalidate,
               "apply_remote_track does NOT emit snapshot_invalidated (no relay echo) [saw: " + evDump + "]");

        // 4) FIDELITY — the track is restored by logicalId.
        auto restored = trackByLogicalId (ops, lid);
        check (restored.isObject(), "restored track found by logicalId");
        check (restored.getProperty ("name", juce::var()).toString() == "RT Src", "name restored");
        const double rv = (double) restored.getProperty ("volumeDb", -99.0);
        check (std::abs (rv - (-6.5)) < 0.05, "volume restored (got " + juce::String (rv, 3) + ")");
        check (clipCountOf (restored) == origClipCount, "clip count restored (wave + midi)");
        int restoredMidiNotes = 0;
        if (auto* cs = restored["clips"].getArray())
            for (auto& cv : *cs)
                if (cv.getProperty ("type", juce::var()).toString() == "midi")
                    if (auto* notes = cv["notes"].getArray())
                        restoredMidiNotes = notes->size();
        check (restoredMidiNotes >= 1, "deep content survived: the MIDI note round-tripped");

        // 5) UNDO GUARD — apply was not undoable, so undo reverts the CONTROL track
        // (top of the stack), not the applied track; the applied track survives.
        check (ok (cmd (ops, "undo")), "undo ok");
        check (! sentinelExists (ops),
               "undo removed the sentinel track (apply was NOT on the undo stack)");
        check (trackByLogicalId (ops, lid).getProperty ("name", juce::var()).toString() == "RT Src",
               "applied track survives the undo (apply is outside the undo system)");
    }

    section ("Multiplayer: lock guard at the mutation path (MP-001 P3)");
    {
        // The guard sits at the single chokepoint MoshOps::execute(). When a session
        // is active, mutations to a track/clip/structure held by the OTHER peer are
        // rejected; reads always pass; deactivating restores single-player edits.
        cmd (ops, "create_track", args1 ("name", "Lock A"));
        cmd (ops, "create_track", args1 ("name", "Lock B"));
        juce::String aId, aLid, bId;
        {
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                {
                    const auto nm = tv.getProperty ("name", juce::var()).toString();
                    if (nm == "Lock A") { aId = tv.getProperty ("id", juce::var()).toString();
                                          aLid = tv.getProperty ("logicalId", juce::var()).toString(); }
                    if (nm == "Lock B") { bId = tv.getProperty ("id", juce::var()).toString(); }
                }
        }
        check (aLid.isNotEmpty() && bId.isNotEmpty(), "lock-test tracks resolved (logicalId + engine ids)");

        // A clip on Lock A, added BEFORE locking, to exercise clip-scoped guarding.
        auto addc = cmd (ops, "add_test_tone_clip", objN ({ { "trackId", aId }, { "seconds", 1.0 } }));
        const auto aClipId = addc.getProperty ("data", juce::var()).getProperty ("clipId", juce::var()).toString();

        // Activate: the OTHER peer holds Lock A AND the session (structural) lock.
        auto* locks = new juce::DynamicObject();
        locks->setProperty (aLid, "other");
        locks->setProperty (LockManager::sessionKey(), "other");
        check (ok (cmd (ops, "mp_sync_locks",
                        objN ({ { "active", true }, { "selfPeer", "me" }, { "locks", juce::var (locks) } }))),
               "mp_sync_locks activates the guard with peer-held locks");

        check (! ok (cmd (ops, "rename_track", objN ({ { "trackId", aId }, { "name", "HAX" } }))),
               "track mutation on a peer-locked track is BLOCKED");
        check (ok (cmd (ops, "list_plugins")), "reads pass the guard");
        check (ok (cmd (ops, "get_clip_peaks", args1 ("clipId", aClipId))),
               "a clip read on a peer-locked track is allowed");
        check (ok (cmd (ops, "rename_track", objN ({ { "trackId", bId }, { "name", "Lock B2" } }))),
               "track mutation on a FREE track is allowed");
        if (aClipId.isNotEmpty())
            check (! ok (cmd (ops, "set_clip_gain", objN ({ { "clipId", aClipId }, { "gain", 0.5 } }))),
                   "clip mutation on a peer-locked track's clip is BLOCKED (clip->track->logicalId)");
        check (! ok (cmd (ops, "create_track", args1 ("name", "Nope"))),
               "session-global op BLOCKED while the session lock is peer-held");

        check (ok (cmd (ops, "mp_sync_locks", objN ({ { "active", false } }))), "mp_sync_locks deactivates");
        check (ok (cmd (ops, "rename_track", objN ({ { "trackId", aId }, { "name", "Free Again" } }))),
               "deactivating restores unguarded single-player track edits");
        check (ok (cmd (ops, "create_track", args1 ("name", "Free Track"))),
               "structural ops unblocked after deactivate (single-player regression safety)");
    }

    section ("Multiplayer: project bootstrap (P6)");
    {
        // A late-joiner adopts the host's whole project. Proven in-process: build a
        // known project -> serialize the bundle -> wipe -> apply -> it comes back
        // with the same logicalIds + content (the join handshake rides this).
        auto lidByName = [] (MoshOps& o, const juce::String& nm) -> juce::String
        {
            auto snap = o.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == nm)
                        return tv.getProperty ("logicalId", juce::var()).toString();
            return {};
        };

        check (ok (cmd (ops, "new_project", args1 ("name", "mp-boot-src"))), "new_project (bootstrap source) ok");
        check (tracks (ops) == 0, "fresh project is empty");
        cmd (ops, "create_track", args1 ("name", "Boot A"));
        cmd (ops, "create_track", args1 ("name", "Boot B"));
        juce::String aId;
        {
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == "Boot A")
                        aId = tv.getProperty ("id", juce::var()).toString();
        }
        cmd (ops, "add_test_tone_clip", objN ({ { "trackId", aId }, { "seconds", 1.0 } }));
        const auto lidA = lidByName (ops, "Boot A");
        const auto lidB = lidByName (ops, "Boot B");
        // A pre-existing annotation on the host must travel in the bootstrap bundle (it's a
        // top-level Edit child, not inside a track blob) so a late-joiner sees it too.
        cmd (ops, "create_annotation", objN ({ { "annotationId", "boot-ann" }, { "text", "host note" }, { "beat", 12.0 }, { "author", "host" } }));

        auto ser = cmd (ops, "mp_serialize_project");
        check (ok (ser), "mp_serialize_project ok");
        auto bundle = ser.getProperty ("data", juce::var());
        check ((int) bundle.getProperty ("count", 0) == 2, "serialized a 2-track project bundle");
        check (bundle.getProperty ("annotations", juce::var()).toString().isNotEmpty(), "bundle carries the annotations subtree");

        // REGRESSION (bootstrap audio late-join): the bundle must carry per-track by-hash
        // audioRefs so a late-joiner can fetch PRE-EXISTING audio, not just structure/MIDI.
        // Before the fix mp_serialize_project never content-addressed/uploaded → the bundle
        // had no refs and the joiner's clip stayed sourceMissing until a host re-commit.
        juce::var bootAudioRefs;
        if (auto* tarr = bundle.getProperty ("tracks", juce::var()).getArray())
            for (auto& tv : *tarr)
                if (auto rr = tv.getProperty ("audioRefs", juce::var()); rr.isArray() && rr.size() > 0)
                    bootAudioRefs = rr;
        check (bootAudioRefs.isArray() && bootAudioRefs.size() >= 1, "bootstrap bundle carries per-track audioRefs (audio late-join)");
        check (bootAudioRefs.size() > 0 && bootAudioRefs[0].getProperty ("hash", juce::var()).toString().length() == 64,
               "bootstrap audioRef hash is a sha256");
        {
            // The host's Boot A clip was content-addressed + repointed to a by-hash stem at
            // serialize time (the by-hash form, no spurious "../" — inherits the PR #104 helper).
            juce::String hostRef;
            for (auto* tr : te::getAllTracks (eng.edit()))
                if (auto* at = dynamic_cast<te::AudioTrack*> (tr))
                    for (auto* c : at->getClips())
                        if (auto* w = dynamic_cast<te::WaveAudioClip*> (c))
                            hostRef = w->state.getProperty (juce::Identifier ("source")).toString();
            check (hostRef.contains ("by-hash"), "serialize content-addressed the host audio clip to a by-hash stem");
            check (! hostRef.startsWith ("../") && ! hostRef.contains ("/../"),
                   "bootstrap by-hash ref has no spurious '../' (" + hostRef + ")");
        }

        check (ok (cmd (ops, "new_project", args1 ("name", "mp-boot-dst"))), "new_project (joiner wipe) ok");
        check (tracks (ops) == 0, "joiner starts empty before bootstrap");

        auto app = cmd (ops, "mp_apply_bootstrap", objN ({ { "tracks", bundle.getProperty ("tracks", juce::var()) },
                                                           { "annotations", bundle.getProperty ("annotations", juce::var()) } }));
        check (ok (app), "mp_apply_bootstrap ok");
        // The joiner adopts the host's annotation (id + author + text preserved).
        bool joinerHasAnn = false;
        { auto arr = ops.snapshot().getProperty ("annotations", juce::var());
          for (int i = 0; i < arr.size(); ++i)
              if (arr[i].getProperty ("id", juce::var()).toString() == "boot-ann"
                  && arr[i].getProperty ("text", juce::var()).toString() == "host note"
                  && arr[i].getProperty ("author", juce::var()).toString() == "host")
                  joinerHasAnn = true; }
        check (joinerHasAnn, "joiner adopts the host's pre-existing annotation via bootstrap");
        check ((int) app.getProperty ("data", juce::var()).getProperty ("applied", 0) == 2, "bootstrap applied 2 tracks");
        check (tracks (ops) == 2, "joiner now holds the host's 2 tracks");
        check (lidByName (ops, "Boot A") == lidA && lidA.isNotEmpty(), "Boot A logicalId preserved across bootstrap");
        check (lidByName (ops, "Boot B") == lidB && lidB.isNotEmpty(), "Boot B logicalId preserved across bootstrap");
        int aClips = 0;
        {
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == "Boot A")
                        if (auto* cs = tv["clips"].getArray()) aClips = cs->size();
        }
        check (aClips == 1, "Boot A's clip survived the bootstrap (deep content)");
        {
            // The repointed by-hash ref rode the bundle onto the joiner (proves the wire
            // round-trip of the audio ref). The bytes themselves ride the cloud relay's blob
            // store via the download loop that mirrors the proven commit-apply path; the
            // cloud-relay selftest branch exercises that fetch end-to-end.
            juce::String joinRef;
            for (auto* tr : te::getAllTracks (eng.edit()))
                if (auto* at = dynamic_cast<te::AudioTrack*> (tr))
                    for (auto* c : at->getClips())
                        if (auto* w = dynamic_cast<te::WaveAudioClip*> (c))
                            joinRef = w->state.getProperty (juce::Identifier ("source")).toString();
            check (joinRef.contains ("by-hash"), "joiner's bootstrapped clip references the by-hash stem");
        }
    }

    section ("Multiplayer: structural sync (scalar session-global ops)");
    {
        auto tempoNow = [] (MoshOps& o) { return (double) o.snapshot()["session"].getProperty ("tempo", 0.0); };
        cmd (ops, "set_tempo", objN ({ { "bpm", 120.0 } }));
        check (std::abs (tempoNow (ops) - 120.0) < 0.01, "baseline tempo is 120");

        // The peer holds the SESSION (structural) lock.
        auto* locks = new juce::DynamicObject();
        locks->setProperty (LockManager::sessionKey(), "other");
        check (ok (cmd (ops, "mp_sync_locks",
                        objN ({ { "active", true }, { "selfPeer", "me" }, { "locks", juce::var (locks) } }))),
               "session active, peer holds the session lock");

        // A LOCAL structural change is blocked by the guard.
        check (! ok (cmd (ops, "set_tempo", objN ({ { "bpm", 140.0 } }))),
               "local tempo change blocked while the peer holds the session lock");
        check (std::abs (tempoNow (ops) - 120.0) < 0.01, "tempo unchanged after the blocked local change");

        // Applying the PEER's structural op bypasses the guard and lands (echo-free).
        check (ok (cmd (ops, "mp_apply_structural",
                        objN ({ { "command", "set_tempo" }, { "args", objN ({ { "bpm", 145.0 } }) } }))),
               "mp_apply_structural ok");
        check (std::abs (tempoNow (ops) - 145.0) < 0.01, "peer's tempo change applied (guard bypassed)");

        check (ok (cmd (ops, "mp_sync_locks", objN ({ { "active", false } }))), "session deactivated");
    }

    // Regression: export after mp_commit_track. The commit content-addresses a wave clip's
    // audio to <session>/audio/by-hash/<sha>.wav and rewrites the clip to a RELATIVE ref.
    // The ref was previously computed relative to the edit FILE (setToDirectFileReference),
    // which produced a spurious leading "../" — but the filePathResolver resolves relative
    // to the edit file's PARENT dir, so the "../" escaped the session dir to a non-existent
    // path. The offline-render WaveNode could then never open the stem, so isReadyToProcess()
    // stayed false and export_audio spun FOREVER. Guards: the ref has no "../", resolves to an
    // existing file, export COMPLETES (the render loop is also bounded now), and renders
    // NON-SILENT audio. (mpSession_ exists unconditionally, so this needs no relay.)
    //
    // The "../" is only emitted when the edit file is NOT on disk at rewrite time: JUCE's
    // getRelativePathFrom strips to the base's parent only when the base existsAsFile(), else
    // it treats the edit file's own path as a directory and prepends "../". new_project
    // persists the edit, so we remove it here to model the unsaved state (a fresh arrangement
    // before its first save) deterministically — WITHOUT this the rewrite resolves fine and
    // the section passes even on the buggy code, i.e. it would not actually guard the fix.
    {
        section ("Multiplayer: export after commit (by-hash ref resolves — guards the export hang)");

        check (ok (cmd (ops, "new_project", args1 ("name", "mp-export-selftest"))), "new_project (mp export isolation) ok");

        auto mkt = cmd (ops, "create_track", objN ({ { "name", "Stem" } }));
        check (ok (mkt), "create_track (audio) ok");
        const auto st = mkt["data"].getProperty ("trackId", var()).toString();
        check (ok (cmd (ops, "add_test_tone_clip", objN ({ { "trackId", st }, { "seconds", 1.0 } }))),
               "add_test_tone_clip ok");

        // Force the bug's precondition: an edit not yet on disk at the rewrite (see above).
        const auto mpEditFile = eng.editFile();
        mpEditFile.deleteFile();
        check (! mpEditFile.existsAsFile(), "edit file is absent at commit time (the bug's precondition)");

        check (ok (cmd (ops, "mp_commit_track", args1 ("trackId", st))), "mp_commit_track (audio) ok");

        juce::String storedRef;
        bool resolvedExists = false;
        for (auto* tr : te::getAllTracks (eng.edit()))
            if (auto* at = dynamic_cast<te::AudioTrack*> (tr))
                for (auto* c : at->getClips())
                    if (auto* w = dynamic_cast<te::WaveAudioClip*> (c))
                    {
                        storedRef      = w->state.getProperty (juce::Identifier ("source")).toString();
                        resolvedExists = w->getCurrentSourceFile().existsAsFile();
                    }
        check (storedRef.contains ("by-hash"), "committed clip points at the by-hash stem");
        check (! storedRef.startsWith ("../") && ! storedRef.contains ("/../"),
               "by-hash ref has no spurious '../' so it resolves inside the session (" + storedRef + ")");
        check (resolvedExists, "committed clip's resolved source exists on disk");

        auto wavMag = [] (const File& f) -> float
        {
            AudioFormatManager fm; fm.registerBasicFormats();
            if (std::unique_ptr<AudioFormatReader> reader { fm.createReaderFor (f) })
            {
                const int toRead = (int) jmin ((int64) 4'000'000, reader->lengthInSamples);
                if (toRead > 0)
                {
                    AudioBuffer<float> buf ((int) reader->numChannels, toRead);
                    reader->read (&buf, 0, toRead, 0, true, true);
                    float mag = 0.0f;
                    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
                        mag = jmax (mag, buf.getMagnitude (ch, 0, toRead));
                    return mag;
                }
            }
            return -1.0f;
        };

        auto outFile = eng.sessionDir().getChildFile ("exports").getChildFile ("mp-commit-export.wav");
        outFile.deleteFile();
        check (ok (cmd (ops, "export_audio", objN ({ { "file", outFile.getFullPathName() },
                                                     { "format", "wav" }, { "bitDepth", 16 } }))),
               "export_audio after mp_commit_track COMPLETES (no hang)");
        check (wavMag (outFile) > 0.02f,
               "exported MP-committed audio is NON-SILENT (the stem actually rendered)");
        outFile.deleteFile();

        // Restore the on-disk edit we removed above so later sections see a persisted edit.
        check (ok (cmd (ops, "save")), "re-persist the edit after the mp-commit-export probe");
    }

    // Regression: export after relink_clip to a project-LOCAL copy. relink_clip rewrites a
    // wave clip's source via setToDirectFileReference(newFile, /*useRelativePath*/ local).
    // When the new file lives under the project dir (local==true), that computes the path
    // relative to the edit FILE — and if the edit file isn't on disk, JUCE treats the edit
    // file's own path as a directory, yielding a spurious leading "../" (e.g. "../audio/
    // foo.wav"). Mosh's filePathResolver (MoshEngine::wireEditResolvers) resolves relative
    // to the edit file's PARENT dir, so that "../" escapes the session dir to a path that
    // doesn't exist → the offline-render WaveNode can never open the source → export_audio
    // spins forever. This is the exact mechanism PR #104 fixed for mp_commit_track. Guards:
    // the relinked ref has no "../", resolves to an existing file, export COMPLETES (the
    // render loop is bounded too), and renders NON-SILENT.
    {
        section ("Relink: export after relink to a local copy (guards the export hang)");

        check (ok (cmd (ops, "new_project", args1 ("name", "relink-export-selftest"))),
               "new_project (relink export isolation) ok");

        auto mkt = cmd (ops, "create_track", objN ({ { "name", "Aud" } }));
        check (ok (mkt), "create_track (audio) ok");
        const auto tid = mkt["data"].getProperty ("trackId", var()).toString();

        // A clip whose source lives OUTSIDE the project dir (the shared session pool), so
        // relinking to a project-local copy exercises the relative-ref rewrite.
        check (ok (cmd (ops, "add_test_tone_clip", objN ({ { "trackId", tid }, { "seconds", 1.0 }, { "freq", 440 } }))),
               "add_test_tone_clip ok");

        auto firstClipOnTrack = [&] () -> var
        {
            auto trks = ops.snapshot().getProperty ("tracks", var());
            for (int i = 0; i < trks.size(); ++i)
                if (trks[i].getProperty ("id", var()).toString() == tid)
                    return trks[i].getProperty ("clips", var())[0];
            return var();
        };
        const auto clipId = firstClipOnTrack().getProperty ("id", var()).toString();
        check (clipId.isNotEmpty(), "probe clip present");

        const File origSrc (firstClipOnTrack().getProperty ("sourceFile", var()).toString());
        const auto projectDir = eng.editFile().getParentDirectory();
        check (! origSrc.isAChildOf (projectDir), "probe clip's source starts OUTSIDE the project dir");

        // Copy the source to a project-LOCAL path and relink to it (local => relative ref).
        auto localCopy = projectDir.getChildFile ("audio").getChildFile ("relinked.wav");
        localCopy.getParentDirectory().createDirectory();
        localCopy.deleteFile();
        check (origSrc.copyFileTo (localCopy), "copied source to a project-local file");
        check (localCopy.isAChildOf (projectDir), "relink target is under the project dir (=> relative ref)");

        // Force the precondition that actually triggers the bug: an edit not yet on disk.
        // setToDirectFileReference(file, /*relative*/ true) -> findPathFromFile ->
        // file.getRelativePathFrom(editFileRetriever()), and JUCE's getRelativePathFrom uses
        // the base's PARENT only when the base existsAsFile() — otherwise it treats the edit
        // file's own path as a directory and emits the spurious leading "../". A real user
        // hits this when relinking on a fresh arrangement before its first save (the
        // cold-start session edit). new_project persists the edit, so we remove it here to
        // model the unsaved state deterministically. (Without this the relative ref resolves
        // fine and the bug stays hidden — which is exactly why it lay latent.)
        const auto editFile = eng.editFile();
        editFile.deleteFile();
        check (! editFile.existsAsFile(), "edit file is absent at relink time (the bug's precondition)");

        check (ok (cmd (ops, "relink_clip", objN ({ { "clipId", clipId }, { "file", localCopy.getFullPathName() } }))),
               "relink_clip to the local copy ok");

        juce::String storedRef;
        bool resolvedExists = false;
        for (auto* tr : te::getAllTracks (eng.edit()))
            if (auto* at = dynamic_cast<te::AudioTrack*> (tr))
                for (auto* c : at->getClips())
                    if (auto* w = dynamic_cast<te::WaveAudioClip*> (c))
                    {
                        storedRef      = w->state.getProperty (juce::Identifier ("source")).toString();
                        resolvedExists = w->getCurrentSourceFile().existsAsFile();
                    }
        check (! storedRef.startsWith ("../") && ! storedRef.contains ("/../"),
               "relinked ref has no spurious '../' so it resolves inside the session (" + storedRef + ")");
        check (resolvedExists, "relinked clip's resolved source exists on disk");

        auto wavMag = [] (const File& f) -> float
        {
            AudioFormatManager fm; fm.registerBasicFormats();
            if (std::unique_ptr<AudioFormatReader> reader { fm.createReaderFor (f) })
            {
                const int toRead = (int) jmin ((int64) 4'000'000, reader->lengthInSamples);
                if (toRead > 0)
                {
                    AudioBuffer<float> buf ((int) reader->numChannels, toRead);
                    reader->read (&buf, 0, toRead, 0, true, true);
                    float mag = 0.0f;
                    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
                        mag = jmax (mag, buf.getMagnitude (ch, 0, toRead));
                    return mag;
                }
            }
            return -1.0f;
        };

        auto outFile = eng.sessionDir().getChildFile ("exports").getChildFile ("relink-export.wav");
        outFile.deleteFile();
        check (ok (cmd (ops, "export_audio", objN ({ { "file", outFile.getFullPathName() },
                                                     { "format", "wav" }, { "bitDepth", 16 } }))),
               "export_audio after relink_clip COMPLETES (no hang)");
        check (wavMag (outFile) > 0.02f,
               "exported relinked audio is NON-SILENT (the relinked source actually rendered)");
        outFile.deleteFile();

        // Restore the on-disk edit we removed above so later sections see a persisted edit.
        check (ok (cmd (ops, "save")), "re-persist the edit after the relink-export probe");
    }

    // P2 — native↔relay transport, end to end over real HTTP. Gated (spawns a
    // relay + needs MOSH_RELAY_URL) so it stays OUT of the deterministic core run.
    if (std::getenv ("MOSH_SELFTEST_MP") != nullptr)
    {
        section ("Multiplayer: native relay round-trip (P2, gated MOSH_SELFTEST_MP)");

        MultiplayerClient a, b;   // both resolve the relay from MOSH_RELAY_URL
        const auto code = a.createSession ("Ada", "#ff0000");
        check (code.isNotEmpty(), "peer A created a session (got a room code) [" + a.lastError() + "]");
        check (code.length() >= 16, "room code is a high-entropy bearer");
        check (b.joinSession (code, "Bo", "#0000ff"), "peer B joined by code [" + b.lastError() + "]");

        // A serializes a real track and publishes the commit over the wire.
        check (ok (cmd (ops, "create_track", args1 ("name", "Net Src"))), "create Net Src");
        juce::String netId;
        {
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == "Net Src")
                        netId = tv.getProperty ("id", juce::var()).toString();
        }
        cmd (ops, "add_test_tone_clip", objN ({ { "trackId", netId }, { "seconds", 1.0 } }));
        auto ser = cmd (ops, "mp_serialize_track", args1 ("trackId", netId));
        const auto blob = ser.getProperty ("data", juce::var()).getProperty ("blob", juce::var()).toString();
        const auto lid  = ser.getProperty ("data", juce::var()).getProperty ("logicalId", juce::var()).toString();
        check (blob.isNotEmpty(), "serialized Net Src to a commit blob");

        auto* commit = new juce::DynamicObject();
        commit->setProperty ("type", "commit");
        commit->setProperty ("logicalId", lid);
        commit->setProperty ("blob", blob);
        const int seq = a.publish (juce::var (commit));
        // seq is monotonic but its absolute value is backend-specific (a fresh local
        // relay starts at 1; the cloud relay's seq is a global serial), so assert >=1.
        check (seq >= 1, "peer A published the commit (seq " + juce::String (seq) + ") [" + a.lastError() + "]");

        // B receives exactly that commit; A does not get its own back (no echo).
        auto frames = b.poll();
        check (frames.size() == 1, "peer B received exactly one frame [" + b.lastError() + "]");
        juce::String gotBlob, gotLid;
        if (frames.size() > 0)
        {
            gotBlob = frames[0].getProperty ("msg", juce::var()).getProperty ("blob", juce::var()).toString();
            gotLid  = frames[0].getProperty ("msg", juce::var()).getProperty ("logicalId", juce::var()).toString();
        }
        check (gotBlob == blob && gotBlob.isNotEmpty(), "commit blob survived the relay round-trip byte-for-byte");
        check (gotLid == lid, "commit logicalId survived the round-trip");
        check (a.poll().isEmpty(), "peer A does not receive its own commit (no echo)");

        // Apply the wire-delivered commit (after mutating) -> the track is restored.
        cmd (ops, "rename_track", objN ({ { "trackId", netId }, { "name", "NET-MUTATED" } }));
        check (ok (cmd (ops, "apply_remote_track", args1 ("blob", gotBlob))), "apply_remote_track (from wire) ok");
        juce::String restoredName;
        {
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("logicalId", juce::var()).toString() == lid)
                        restoredName = tv.getProperty ("name", juce::var()).toString();
        }
        check (restoredName == "Net Src", "track restored from the relayed commit (end-to-end over HTTP)");

        // Exercise the NATIVE session command path (MultiplayerSession lifecycle:
        // create -> background poll thread starts -> leave -> thread joins).
        auto created = cmd (ops, "mp_create_session", objN ({ { "name", "Cy" }, { "color", "#00ff88" } }));
        check (ok (created), "mp_create_session (native session) ok");
        check (created.getProperty ("data", juce::var()).getProperty ("code", juce::var()).toString().isNotEmpty(),
               "native session returned a room code");
        check (ok (cmd (ops, "mp_leave_session")), "mp_leave_session ok (poll thread joined)");

        // P4 — audio stems. Content-addressing + the by-hash rewrite run on any
        // relay; the upload/peer-download round-trip now runs against WHATEVER
        // relay MOSH_RELAY_URL points at — cloud or local. (Previously gated to
        // the cloud relay only, because the local dev relay had no /mp/blob/*
        // storage; relay/server.py now mirrors that contract for local/CI use —
        // see the mp_fetch_missing_stems self-heal section below.)
        auto sess = cmd (ops, "mp_create_session", objN ({ { "name", "Hz" }, { "color", "#ffff00" } }));
        check (ok (sess), "mp_create_session (audio)");
        const auto sessCode = sess.getProperty ("data", juce::var()).getProperty ("code", juce::var()).toString();
        cmd (ops, "create_track", args1 ("name", "Stem Trk"));
        juce::String stemTrk;
        {
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == "Stem Trk")
                        stemTrk = tv.getProperty ("id", juce::var()).toString();
        }
        cmd (ops, "add_test_tone_clip", objN ({ { "trackId", stemTrk }, { "seconds", 1.0 } }));

        auto commitRes = cmd (ops, "mp_commit_track", args1 ("trackId", stemTrk));
        check (ok (commitRes), "mp_commit_track ok (with audio)");
        // MOSH_MP_SYNC_TRANSFER (the PR-2 kill switch, gated separately below) pins this
        // to "committed" instead; that combination is exercised in its own dedicated
        // section, so this just accepts whichever mode is actually active here.
        const auto commitStatus = commitRes.getProperty ("data", juce::var()).getProperty ("status", juce::var()).toString();
        check (commitStatus == "uploading" || commitStatus == "committed",
               "PR-2: mp_commit_track returns a recognized status (\"" + commitStatus + "\")");
        auto refs = commitRes.getProperty ("data", juce::var()).getProperty ("audioRefs", juce::var());
        check (refs.isArray() && refs.size() >= 1, "commit content-addressed the clip's stem");
        const auto h0 = (refs.isArray() && refs.size() > 0) ? refs[0].getProperty ("hash", juce::var()).toString() : juce::String();
        const auto e0 = (refs.isArray() && refs.size() > 0) ? refs[0].getProperty ("ext", juce::var()).toString() : juce::String();
        check (h0.length() == 64, "stem hash is a sha256");
        const auto stemLogicalId = commitRes.getProperty ("data", juce::var()).getProperty ("logicalId", juce::var()).toString();

        // PR-2: the upload + publish now run on the transfer worker (mp_commit_track
        // returns status:"uploading" immediately) instead of inline — wait for the
        // additive mp_commit_done event before assuming the stem has actually landed
        // on the relay's blob store (a bounded drain, mirroring the async-outbox
        // check below; the shared event sink set at the top of this function
        // captures it into lastEvent).
        {
            auto* mmc = juce::MessageManager::getInstanceWithoutCreating();
            bool committed = false;
            const auto commitDeadline = juce::Time::getMillisecondCounter() + (juce::uint32) 20000;
            while (! committed && juce::Time::getMillisecondCounter() < commitDeadline)
            {
                if (mmc != nullptr) mmc->runDispatchLoopUntil (50);
                else juce::Thread::sleep (50);
                committed = lastEvent.getProperty ("type", juce::var()).toString() == "mp_commit_done"
                            && lastEvent.getProperty ("payload", juce::var()).getProperty ("logicalId", juce::var()).toString() == stemLogicalId;
            }
            check (committed, "mp_commit_track's async transfer completed (mp_commit_done observed)");
            check ((bool) lastEvent.getProperty ("payload", juce::var()).getProperty ("ok", false),
                   "mp_commit_done reports ok:true");
        }

        {
            MultiplayerClient peer;
            check (peer.joinSession (sessCode, "Peer", "#00ffff"), "peer joined the audio session");
            auto tmp = selftestTempPath (eng, "mp-stem-" + h0 + "." + e0);
            tmp.deleteFile();
            check (peer.downloadBlob (h0, e0, tmp), "peer fetched the stem from the relay's blob store [" + peer.lastError() + "]");
            check (tmp.existsAsFile() && tmp.getSize() > 0, "fetched stem is non-empty (" + juce::String (tmp.getSize()) + " bytes)");
            tmp.deleteFile();
            peer.leave();
        }
        cmd (ops, "mp_leave_session");

        // PR-2 — stem transfer off the message thread. Proves global apply ORDER
        // survives two quick successive commits of the SAME track (a fast second
        // commit must never jump ahead of a still-in-flight first one) through a
        // REAL live guest session (mp_join_session, not a direct apply_remote_track
        // command) — exercising the guest's own commit-frame prefetch -> apply path
        // (routeStateMutatingJob) end-to-end, including the received clip's audio
        // resolving via the worker's prefetch stage (the "receive path" case).
        section ("Multiplayer PR-2: stem transfer order + receive path (live session)");
        {
            MoshEngine ordHostEng (false, true, "pr2-order-host");
            MoshOps    ordHostOps (ordHostEng);
            MoshEngine ordGuestEng (false, true, "pr2-order-guest");
            MoshOps    ordGuestOps (ordGuestEng);

            auto ordSess = cmd (ordHostOps, "mp_create_session", objN ({ { "name", "OrdHost" }, { "color", "#101010" } }));
            check (ok (ordSess), "order: host created a session");
            const auto ordCode = ordSess.getProperty ("data", juce::var()).getProperty ("code", juce::var()).toString();

            check (ok (cmd (ordGuestOps, "mp_join_session",
                            objN ({ { "code", ordCode }, { "name", "OrdGuest" }, { "color", "#202020" } }))),
                   "order: guest joined the host's room (a REAL live session, not a direct apply)");
            // Settle joinSession()'s own auto-fired (harmless, 0-track) bootstrap_request
            // before creating real content -- see the identical comment in the self-heal
            // section below for why this matters once a bootstrap answer can carry a
            // (possibly slow, under MOSH_RELAY_BLOB_DELAY_MS) stem upload.
            {
                auto* mmSettle = juce::MessageManager::getInstanceWithoutCreating();
                const auto settleDeadline = juce::Time::getMillisecondCounter() + (juce::uint32) 1000;
                while (juce::Time::getMillisecondCounter() < settleDeadline)
                {
                    if (mmSettle != nullptr) mmSettle->runDispatchLoopUntil (50);
                    else juce::Thread::sleep (50);
                }
            }

            auto ordMk = cmd (ordHostOps, "create_track", args1 ("name", "Order Src"));
            const auto ordTrackId = ordMk.getProperty ("data", juce::var()).getProperty ("trackId", juce::var()).toString();
            check (ok (cmd (ordHostOps, "add_test_tone_clip", objN ({ { "trackId", ordTrackId }, { "seconds", 1.0 } }))),
                   "order: host added a wave clip");

            juce::String ordLid;
            {
                auto snap = ordHostOps.snapshot();
                if (auto* arr = snap["tracks"].getArray())
                    for (auto& tv : *arr)
                        if (tv.getProperty ("name", juce::var()).toString() == "Order Src")
                            ordLid = tv.getProperty ("logicalId", juce::var()).toString();
            }
            check (ordLid.isNotEmpty(), "order: host track logicalId resolved");

            // Commit #1 (original name), then IMMEDIATELY mutate + commit #2 (renamed)
            // — back-to-back, no wait in between, so both are in flight close together.
            auto ordCommit1 = cmd (ordHostOps, "mp_commit_track", args1 ("trackId", ordTrackId));
            check (ok (ordCommit1), "order: commit #1 ok");
            check (ok (cmd (ordHostOps, "rename_track", objN ({ { "trackId", ordTrackId }, { "name", "Order Src RENAMED" } }))),
                   "order: host renamed the track");
            auto ordCommit2 = cmd (ordHostOps, "mp_commit_track", args1 ("trackId", ordTrackId));
            check (ok (ordCommit2), "order: commit #2 ok");

            // Bounded drain: the guest's own live poll loop receives BOTH commit
            // frames, each routed prefetch (download the stem) -> apply
            // (apply_remote_track) through the SAME single-worker FIFO — proving the
            // second (later) commit's apply can never be scheduled ahead of the
            // first's, even though both reference the IDENTICAL stem (so the
            // second's prefetch is a fast already-downloaded no-op, unlike the first).
            auto* ordMm = juce::MessageManager::getInstanceWithoutCreating();
            bool ordSettled = false;
            const auto ordDeadline = juce::Time::getMillisecondCounter() + (juce::uint32) 20000;
            juce::String ordGuestName;
            bool ordGuestClipMissing = true;
            while (! ordSettled && juce::Time::getMillisecondCounter() < ordDeadline)
            {
                if (ordMm != nullptr) ordMm->runDispatchLoopUntil (50);
                else juce::Thread::sleep (50);
                auto t = trackSnapshotByLogicalId (ordGuestOps, ordLid);
                ordGuestName = t.getProperty ("name", juce::var()).toString();
                ordGuestClipMissing = true;
                if (auto* cs = t.getProperty ("clips", juce::var()).getArray())
                    for (auto& c : *cs)
                        if (c.getProperty ("type", juce::var()).toString() == "wave")
                            ordGuestClipMissing = (bool) c.getProperty ("sourceMissing", false);
                ordSettled = (ordGuestName == "Order Src RENAMED") && ! ordGuestClipMissing;
            }
            check (ordSettled, "order+receive: guest settles at the SECOND (later) commit's name with its clip resolved, within the bound");
            check (ordGuestName == "Order Src RENAMED",
                   "order: guest never regresses to (or gets stuck on) the FIRST commit's name -- global apply order preserved");
            check (! ordGuestClipMissing,
                   "receive path: guest's clip is NOT sourceMissing (the worker's prefetch stage downloaded the stem before commit's apply ran)");

            cmd (ordGuestOps, "mp_leave_session");
            cmd (ordHostOps, "mp_leave_session");
        }

        // PR-2 — no-freeze proxy. Gated additionally on MOSH_RELAY_BLOB_DELAY_MS (set
        // for the WHOLE relay process by relay/run-mp-selftest.sh's caller — the local
        // relay has no per-call toggle, so this only runs in a dedicated gate
        // invocation with the delay armed) so the default MOSH_SELFTEST_MP=1 run stays
        // fast. Proves mp_commit_track returns — and a second, unrelated command
        // executes — well before the artificially slow upload could possibly have
        // completed inline, deterministically demonstrating the message thread never
        // blocked on it.
        if (std::getenv ("MOSH_RELAY_BLOB_DELAY_MS") != nullptr)
        {
            section ("Multiplayer PR-2: no-freeze proxy (MOSH_RELAY_BLOB_DELAY_MS)");

            MoshEngine nfEng (false, true, "pr2-nofreeze-host");
            MoshOps    nfOps (nfEng);
            juce::var nfLastEvent;
            nfOps.setEventSink ([&] (const juce::var& e) { nfLastEvent = e; });

            auto nfSess = cmd (nfOps, "mp_create_session", objN ({ { "name", "NF" }, { "color", "#ffffff" } }));
            check (ok (nfSess), "no-freeze: host created a session");

            auto nfMk = cmd (nfOps, "create_track", args1 ("name", "NF Src"));
            const auto nfTrackId = nfMk.getProperty ("data", juce::var()).getProperty ("trackId", juce::var()).toString();
            check (ok (cmd (nfOps, "add_test_tone_clip", objN ({ { "trackId", nfTrackId }, { "seconds", 1.0 } }))),
                   "no-freeze: host added a wave clip");

            const auto nfT0 = juce::Time::getMillisecondCounterHiRes();
            auto nfCommit = cmd (nfOps, "mp_commit_track", args1 ("trackId", nfTrackId));
            const auto nfCommitElapsedMs = juce::Time::getMillisecondCounterHiRes() - nfT0;
            check (ok (nfCommit), "no-freeze: mp_commit_track ok");
            check (nfCommit.getProperty ("data", juce::var()).getProperty ("status", juce::var()).toString() == "uploading",
                   "no-freeze: async branch taken");
            check (nfCommitElapsedMs < 400.0,
                   "no-freeze: mp_commit_track returned near-instantly despite the delayed upload ("
                       + juce::String (nfCommitElapsedMs, 1) + "ms)");

            const auto nfT1 = juce::Time::getMillisecondCounterHiRes();
            check (ok (cmd (nfOps, "create_track", args1 ("name", "NF Trivial"))),
                   "no-freeze: a trivial command executes while the upload is still in flight");
            const auto nfTrivialElapsedMs = juce::Time::getMillisecondCounterHiRes() - nfT1;
            check (nfTrivialElapsedMs < 400.0,
                   "no-freeze: the trivial command was ALSO fast ("
                       + juce::String (nfTrivialElapsedMs, 1) + "ms) — the message thread stayed free");

            auto* nfMm = juce::MessageManager::getInstanceWithoutCreating();
            bool nfCommitted = false;
            const auto nfDeadline = juce::Time::getMillisecondCounter() + (juce::uint32) 20000;
            while (! nfCommitted && juce::Time::getMillisecondCounter() < nfDeadline)
            {
                if (nfMm != nullptr) nfMm->runDispatchLoopUntil (50);
                else juce::Thread::sleep (50);
                nfCommitted = nfLastEvent.getProperty ("type", juce::var()).toString() == "mp_commit_done";
            }
            check (nfCommitted, "no-freeze: the delayed upload eventually completes in the background (mp_commit_done observed)");
            check ((bool) nfLastEvent.getProperty ("payload", juce::var()).getProperty ("ok", false),
                   "no-freeze: the delayed upload succeeded");

            cmd (nfOps, "mp_leave_session");
        }

        // PR-2 — MOSH_MP_SYNC_TRANSFER kill switch. Gated on the env var being set
        // (read once at MultiplayerSession construction, so it can't be toggled
        // mid-process — a dedicated gate invocation, like the no-freeze check above).
        // Proves the switch actually reverts to the original fully synchronous/
        // inline behaviour: mp_commit_track reports status:"committed" (not
        // "uploading") and the stem is ALREADY on the relay by the time it returns
        // — no waiting for mp_commit_done required.
        if (std::getenv ("MOSH_MP_SYNC_TRANSFER") != nullptr)
        {
            section ("Multiplayer PR-2: MOSH_MP_SYNC_TRANSFER kill switch");

            MoshEngine syncEng (false, true, "pr2-syncswitch-host");
            MoshOps    syncOps (syncEng);

            auto syncSess = cmd (syncOps, "mp_create_session", objN ({ { "name", "Sync" }, { "color", "#666666" } }));
            check (ok (syncSess), "sync-switch: host created a session");
            const auto syncCode = syncSess.getProperty ("data", juce::var()).getProperty ("code", juce::var()).toString();

            auto syncMk = cmd (syncOps, "create_track", args1 ("name", "Sync Src"));
            const auto syncTrackId = syncMk.getProperty ("data", juce::var()).getProperty ("trackId", juce::var()).toString();
            check (ok (cmd (syncOps, "add_test_tone_clip", objN ({ { "trackId", syncTrackId }, { "seconds", 1.0 } }))),
                   "sync-switch: host added a wave clip");

            auto syncCommit = cmd (syncOps, "mp_commit_track", args1 ("trackId", syncTrackId));
            check (ok (syncCommit), "sync-switch: mp_commit_track ok");
            check (syncCommit.getProperty ("data", juce::var()).getProperty ("status", juce::var()).toString() == "committed",
                   "sync-switch: status is \"committed\" (synchronous), NOT \"uploading\" — the kill switch reverted the async path");

            auto syncRefs = syncCommit.getProperty ("data", juce::var()).getProperty ("audioRefs", juce::var());
            const auto syncHash = (syncRefs.isArray() && syncRefs.size() > 0) ? syncRefs[0].getProperty ("hash", juce::var()).toString() : juce::String();
            const auto syncExt  = (syncRefs.isArray() && syncRefs.size() > 0) ? syncRefs[0].getProperty ("ext", juce::var()).toString() : juce::String();
            check (syncHash.length() == 64, "sync-switch: stem hash is a sha256");

            // No wait/drain here at all — under the kill switch, mp_commit_track only
            // returns once the upload+publish already completed inline, so a peer can
            // fetch the stem IMMEDIATELY.
            MultiplayerClient syncPeer;
            check (syncPeer.joinSession (syncCode, "SyncPeer", "#777777"), "sync-switch: peer joined the session");
            auto syncTmp = selftestTempPath (eng, "mp-syncswitch-" + syncHash + "." + syncExt);
            syncTmp.deleteFile();
            check (syncPeer.downloadBlob (syncHash, syncExt, syncTmp),
                   "sync-switch: peer fetched the stem immediately, no drain needed [" + syncPeer.lastError() + "]");
            check (syncTmp.existsAsFile() && syncTmp.getSize() > 0, "sync-switch: fetched stem is non-empty");
            syncTmp.deleteFile();
            syncPeer.leave();

            cmd (syncOps, "mp_leave_session");
        }

        // ── PR-2 BLOCKER: a rejected upload must surface as mp_commit_done{ok:false} ──
        // Adversarial review: MultiplayerClient::uploadBlob's raw PUT never checked the
        // HTTP status code (createInputStream() returns non-null for 4xx/5xx on macOS),
        // so a REJECTED upload (quota/auth/a transient 5xx from the relay) was reported
        // back as a false success -- mp_commit_done would fire ok:true for a commit
        // whose stem never actually landed on the relay. Drives MultiplayerSession
        // directly (constructible standalone, no MoshOps/engine needed) with a
        // synthetic audioRef under the reserved ".failtest" ext that relay/server.py's
        // MOSH_RELAY_BLOB_FAIL hook (armed for this whole gate run, like
        // MOSH_RELAY_BLOB_CORRUPT) rejects with a 503 -- proving the failure actually
        // propagates end-to-end through commit() -> uploadBlob() -> emitCommitDone(),
        // the exact chain cmdMpCommitTrack relies on. The adjacent success-path test
        // above already proves ok:true for a real commit, so this closes the other half.
        section ("Multiplayer PR-2 BLOCKER: rejected upload surfaces as mp_commit_done{ok:false}");
        {
            juce::Array<juce::var> failEvents;
            MultiplayerSession failSess (
                [] (const juce::var&) {},                                              // applyCommit (unused)
                [&failEvents] (const juce::String& type, juce::var payload)
                {
                    if (type == "mp_commit_done") failEvents.add (payload);
                },
                [] (bool, const juce::String&, const std::map<juce::String, juce::String>&) {},   // syncLocks
                [] () -> juce::var { return {}; },                                       // provideBootstrap
                [] (const juce::var&) {},                                               // applyBootstrap
                [] (const juce::var&) {});                                              // applyStructural

            const auto failCode = failSess.createSession ("FailHost", "#facade");
            check (failCode.isNotEmpty(), "commit-fail: session created");

            // A synthetic audioRef: the ext is the reserved sentinel the relay's fail
            // hook targets. The uploaded bytes/hash don't need to be a real WAV --
            // uploadBlob is rejected by the relay before any hash/content matters.
            const juce::String failPayload ("bytes-for-the-rejected-commit-upload-check");
            juce::File failSrc = selftestTempPath (eng, "commitfail-src.failtest");
            failSrc.replaceWithText (failPayload);
            juce::FileInputStream failFis (failSrc);
            const auto failHash = juce::SHA256 (failFis).toHexString();

            auto* refObj = new DynamicObject();
            refObj->setProperty ("hash", failHash);
            refObj->setProperty ("ext", "failtest");
            juce::Array<juce::var> failRefs; failRefs.add (var (refObj));
            juce::Array<juce::File> failStemFiles; failStemFiles.add (failSrc);

            const juce::String failLid ("commit-fail-logical-id");
            failSess.commit (failLid, "{\"fake\":\"blob\"}", var (failRefs), failStemFiles);

            // Bounded drain for mp_commit_done (async worker unless MOSH_MP_SYNC_TRANSFER
            // is set, in which case commit() has already returned synchronously and the
            // event was pushed inline -- either way this loop is a correct, cheap wait).
            auto* mmFail = juce::MessageManager::getInstanceWithoutCreating();
            const auto failDeadline = juce::Time::getMillisecondCounter() + (juce::uint32) 20000;
            while (failEvents.isEmpty() && juce::Time::getMillisecondCounter() < failDeadline)
            {
                if (mmFail != nullptr) mmFail->runDispatchLoopUntil (50);
                else juce::Thread::sleep (50);
            }
            check (! failEvents.isEmpty(), "commit-fail: mp_commit_done was emitted");
            if (! failEvents.isEmpty())
            {
                const auto& done = failEvents.getReference (0);
                check (done.getProperty ("logicalId", juce::var()).toString() == failLid,
                       "commit-fail: mp_commit_done carries the right logicalId");
                check (! (bool) done.getProperty ("ok", true),
                       "commit-fail: mp_commit_done reports ok:false (the rejected upload was NOT a false success)");
                check (done.getProperty ("error", juce::var()).toString().isNotEmpty(),
                       "commit-fail: mp_commit_done carries an error string");
            }

            failSrc.deleteFile();
            failSess.leaveSession();
        }

        // Async outbox (anti-jank): a fire-and-forget broadcast does NOT block the
        // message thread on HTTP — it enqueues, and the background poll thread drains
        // + publishes it. Prove the round-trip: a watcher peer eventually receives a
        // selection we broadcast through the live session.
        {
            auto host = cmd (ops, "mp_create_session", objN ({ { "name", "Sel" }, { "color", "#abcdef" } }));
            check (ok (host), "mp_create_session (outbox path) ok");
            const auto hostCode = host.getProperty ("data", juce::var()).getProperty ("code", juce::var()).toString();

            MultiplayerClient watcher;
            check (watcher.joinSession (hostCode, "Watch", "#123456"), "watcher joined the outbox session [" + watcher.lastError() + "]");

            // Returns immediately (enqueue only — no synchronous HTTP on this thread).
            check (ok (cmd (ops, "mp_broadcast_selection", objN ({ { "trackId", "trk-7" }, { "clipId", "clip-9" } }))),
                   "mp_broadcast_selection returns without blocking");

            // Poll the watcher until the poll thread has drained + published it (bounded
            // so a stall fails the gate rather than hanging). Pump the message loop so
            // the session's callAsyncs drain too.
            auto* mm = juce::MessageManager::getInstanceWithoutCreating();
            bool gotSel = false;
            const auto deadline = juce::Time::getMillisecondCounter() + (juce::uint32) 20000;
            while (! gotSel && juce::Time::getMillisecondCounter() < deadline)
            {
                for (auto& f : watcher.poll())
                {
                    auto msg = f.getProperty ("msg", juce::var());
                    if (msg.getProperty ("type", juce::var()).toString() == "selection"
                        && msg.getProperty ("trackId", juce::var()).toString() == "trk-7"
                        && msg.getProperty ("clipId", juce::var()).toString() == "clip-9")
                        gotSel = true;
                }
                if (! gotSel)
                {
                    if (mm != nullptr) mm->runDispatchLoopUntil (100);
                    else juce::Thread::sleep (100);
                }
            }
            check (gotSel, "selection broadcast reached a peer via the async outbox (poll thread published it)");

            cmd (ops, "mp_leave_session");
            watcher.leave();
        }

        // Shared by both sub-sections below: a wave clip's sourceMissing flag / id,
        // read from a track located by logicalId (mirrors trackSnapshotByLogicalId's
        // own scoping, used across both the self-heal regression and the bootstrap
        // end-to-end test).
        auto clipSourceMissing = [] (MoshOps& o, const juce::String& lid) -> bool
        {
            auto t = trackSnapshotByLogicalId (o, lid);
            if (auto* cs = t.getProperty ("clips", juce::var()).getArray())
                for (auto& c : *cs)
                    if (c.getProperty ("type", juce::var()).toString() == "wave")
                        return (bool) c.getProperty ("sourceMissing", false);
            return false;
        };
        auto waveClipIdOf = [] (MoshOps& o, const juce::String& lid) -> juce::String
        {
            auto t = trackSnapshotByLogicalId (o, lid);
            if (auto* cs = t.getProperty ("clips", juce::var()).getArray())
                for (auto& c : *cs)
                    if (c.getProperty ("type", juce::var()).toString() == "wave")
                        return c.getProperty ("id", juce::var()).toString();
            return {};
        };

        // ── mp_fetch_missing_stems — self-healing stem resolution ───────────
        // Fresh, isolated host + guest engines (distinct session dirs, like the
        // AL-010 / "Layer 3" two-engine patterns above) so a stem download is a
        // REAL cross-directory HTTP fetch through relay/server.py's blob store,
        // not a same-directory coincidence.
        section ("Multiplayer P4: self-healing stem fetch (mp_fetch_missing_stems)");
        {
            MoshEngine hostEng (false, true, "mp-selfheal-host");
            MoshOps    hostOps (hostEng);
            MoshEngine guestEng (false, true, "mp-selfheal-guest");
            MoshOps    guestOps (guestEng);

            auto hostSess = cmd (hostOps, "mp_create_session", objN ({ { "name", "SHHost" }, { "color", "#111111" } }));
            check (ok (hostSess), "self-heal: host created a session");
            const auto shCode = hostSess.getProperty ("data", juce::var()).getProperty ("code", juce::var()).toString();
            check (shCode.isNotEmpty(), "self-heal: host got a room code");

            check (ok (cmd (guestOps, "mp_join_session",
                            objN ({ { "code", shCode }, { "name", "SHGuest" }, { "color", "#222222" } }))),
                   "self-heal: guest joined the host's room");
            // joinSession() unconditionally fires its own bootstrap_request (the
            // normal late-join path) the instant it joins -- at this point the host
            // has zero tracks, so the round-trip answer is harmless (0 tracks -> 0
            // tracks) PROVIDED it lands before the host creates real content below.
            // Drain it here (bounded) rather than risk it landing LATE (e.g. because
            // MOSH_RELAY_BLOB_DELAY_MS is slowing down some unrelated stem upload
            // elsewhere) and overwriting the guest's own apply_remote_track state
            // via a now-stale cmdMpApplyBootstrap mid-test.
            {
                auto* mmSettle = juce::MessageManager::getInstanceWithoutCreating();
                const auto settleDeadline = juce::Time::getMillisecondCounter() + (juce::uint32) 1000;
                while (juce::Time::getMillisecondCounter() < settleDeadline)
                {
                    if (mmSettle != nullptr) mmSettle->runDispatchLoopUntil (50);
                    else juce::Thread::sleep (50);
                }
            }

            auto mk = cmd (hostOps, "create_track", args1 ("name", "SH Src"));
            const auto shTrackId = mk.getProperty ("data", juce::var()).getProperty ("trackId", juce::var()).toString();
            check (ok (cmd (hostOps, "add_test_tone_clip", objN ({ { "trackId", shTrackId }, { "seconds", 1.0 } }))),
                   "self-heal: host added a wave clip");

            // mp_serialize_project content-addresses + uploads the stem (the same path
            // a late-joiner's bootstrap uses) and returns the blob directly.
            auto ser = cmd (hostOps, "mp_serialize_project");
            check (ok (ser), "self-heal: host mp_serialize_project ok");
            juce::var shTrackEntry;
            if (auto* tarr = ser.getProperty ("data", juce::var()).getProperty ("tracks", juce::var()).getArray())
                for (auto& tv : *tarr)
                    if (auto rr = tv.getProperty ("audioRefs", juce::var()); rr.isArray() && rr.size() > 0)
                        shTrackEntry = tv;
            check (shTrackEntry.isObject(), "self-heal: host's bundle carries a track with audioRefs");
            const auto shBlob = shTrackEntry.getProperty ("blob", juce::var()).toString();
            check (shBlob.isNotEmpty(), "self-heal: host track blob non-empty");

            // THE REGRESSION: apply the peer's track structure directly (bypassing the
            // download-before-apply step that applyMultiplayerCommitMessage/
            // cmdMpApplyBootstrap normally run) — reproduces a transient upload/download
            // failure, where the ignored uploadBlob/downloadBlob bool result left the
            // guest's clip permanently sourceMissing with no recovery but a host re-commit.
            auto applied = cmd (guestOps, "apply_remote_track", args1 ("blob", shBlob));
            check (ok (applied), "self-heal: guest applied the track structure (no stem download)");
            const auto shLid = applied.getProperty ("data", juce::var()).getProperty ("logicalId", juce::var()).toString();
            check (shLid.isNotEmpty(), "self-heal: applied track logicalId resolved");

            check (clipSourceMissing (guestOps, shLid),
                   "self-heal: guest's clip is sourceMissing before fetch (regression reproduced)");
            const auto shClipId = waveClipIdOf (guestOps, shLid);
            check (shClipId.isNotEmpty(), "self-heal: guest's wave clip id resolved");
            check (! ok (cmd (guestOps, "get_clip_peaks", args1 ("clipId", shClipId))),
                   "self-heal: get_clip_peaks fails before the stem is fetched");

            // THE FIX: the guest self-heals by re-deriving the missing hash/ext from its
            // own clip's by-hash source ref and retrying the download.
            auto fetch = cmd (guestOps, "mp_fetch_missing_stems", args1 ("wait", true));
            check (ok (fetch), "self-heal: mp_fetch_missing_stems ok");
            check ((int) fetch.getProperty ("data", juce::var()).getProperty ("fetched", 0) == 1,
                   "self-heal: fetched exactly 1 missing stem");
            check ((int) fetch.getProperty ("data", juce::var()).getProperty ("failed", 0) == 0,
                   "self-heal: 0 failures");
            check (! clipSourceMissing (guestOps, shLid),
                   "self-heal: guest's clip is no longer sourceMissing after fetch");
            check (ok (cmd (guestOps, "get_clip_peaks", args1 ("clipId", shClipId))),
                   "self-heal: get_clip_peaks succeeds after the fetch");

            // A second fetch with nothing missing is a cheap synchronous no-op.
            auto refetch = cmd (guestOps, "mp_fetch_missing_stems", args1 ("wait", true));
            check (ok (refetch), "self-heal: re-running mp_fetch_missing_stems is a harmless no-op");
            check ((int) refetch.getProperty ("data", juce::var()).getProperty ("fetched", 0) == 0,
                   "self-heal: nothing left to fetch");

            // Adversarial-review finding #2: every check above uses wait:true (the
            // SYNCHRONOUS branch) — the std::thread + callAsync ASYNC branch had ZERO
            // coverage. Force it directly with a second missing-stem clip on the SAME
            // host+guest room (the relay already holds the correct bytes, so this is a
            // deterministic proof the background-thread path lands correctly, not a
            // race against a deliberately-broken transfer).
            auto mk2 = cmd (hostOps, "create_track", args1 ("name", "SH Src 2"));
            const auto shTrackId2 = mk2.getProperty ("data", juce::var()).getProperty ("trackId", juce::var()).toString();
            check (ok (cmd (hostOps, "add_test_tone_clip",
                            objN ({ { "trackId", shTrackId2 }, { "seconds", 1.0 }, { "freq", 440.0 } }))),
                   "self-heal (async): host added a second wave clip");

            auto ser2 = cmd (hostOps, "mp_serialize_project");
            check (ok (ser2), "self-heal (async): host mp_serialize_project ok");
            juce::String shLid2;
            {
                auto snap = hostOps.snapshot();
                if (auto* arr = snap["tracks"].getArray())
                    for (auto& tv : *arr)
                        if (tv.getProperty ("name", juce::var()).toString() == "SH Src 2")
                            shLid2 = tv.getProperty ("logicalId", juce::var()).toString();
            }
            check (shLid2.isNotEmpty(), "self-heal (async): host's second track logicalId resolved");

            juce::var shTrackEntry2;
            if (auto* tarr = ser2.getProperty ("data", juce::var()).getProperty ("tracks", juce::var()).getArray())
                for (auto& tv : *tarr)
                    if (tv.getProperty ("logicalId", juce::var()).toString() == shLid2)
                        shTrackEntry2 = tv;
            check (shTrackEntry2.isObject(), "self-heal (async): host's bundle carries the second track");
            const auto shBlob2 = shTrackEntry2.getProperty ("blob", juce::var()).toString();
            check (shBlob2.isNotEmpty(), "self-heal (async): second track blob non-empty");

            auto applied2 = cmd (guestOps, "apply_remote_track", args1 ("blob", shBlob2));
            check (ok (applied2), "self-heal (async): guest applied the second track structure (no stem download)");
            const auto shLid2Applied = applied2.getProperty ("data", juce::var()).getProperty ("logicalId", juce::var()).toString();
            check (shLid2Applied == shLid2, "self-heal (async): applied logicalId matches the host's second track");
            check (clipSourceMissing (guestOps, shLid2Applied),
                   "self-heal (async): guest's second clip is sourceMissing before fetch");

            // THE ASYNC PATH: no `wait` arg -> cmdMpFetchMissingStems takes the
            // std::thread + callAsync branch (mirrors cmdMpApplyBootstrap's own
            // auto-trigger call, which also omits `wait`).
            auto fetch2 = cmd (guestOps, "mp_fetch_missing_stems");
            check (ok (fetch2), "self-heal (async): mp_fetch_missing_stems (no wait) returns ok immediately");
            check (fetch2.getProperty ("data", juce::var()).getProperty ("status", juce::var()).toString() == "started",
                   "self-heal (async): took the async branch (status:\"started\")");

            // Bounded drain for the background thread's downloadBlob + its callAsync
            // completion (sourceMediaChanged + emitSnapshotInvalidated) to land.
            auto* mm2 = juce::MessageManager::getInstanceWithoutCreating();
            bool resolved2 = false;
            const auto deadline2 = juce::Time::getMillisecondCounter() + (juce::uint32) 20000;
            while (! resolved2 && juce::Time::getMillisecondCounter() < deadline2)
            {
                if (mm2 != nullptr) mm2->runDispatchLoopUntil (50);
                else juce::Thread::sleep (50);
                resolved2 = ! clipSourceMissing (guestOps, shLid2Applied);
            }
            check (resolved2, "self-heal (async): guest's clip resolved via the background thread + callAsync (previously untested code path)");
            const auto shClipId2 = waveClipIdOf (guestOps, shLid2Applied);
            auto peaksRes2 = cmd (guestOps, "get_clip_peaks", args1 ("clipId", shClipId2));
            check (ok (peaksRes2),
                   "self-heal (async): get_clip_peaks succeeds after the async fetch [clipId=" + shClipId2
                       + " err=" + peaksRes2.getProperty ("error", juce::var()).toString() + "]");

            cmd (guestOps, "mp_leave_session");
            cmd (hostOps, "mp_leave_session");
        }

        // ── PR-1 should-fix: downloadBlob rejects a corrupted transfer ───────
        // Nothing previously proved the SHA-256 integrity check in
        // MultiplayerClient::downloadBlob (see its .h doc comment) actually fires —
        // it was "correct by inspection" only. relay/server.py's MOSH_RELAY_BLOB_CORRUPT
        // hook (armed for this whole gate run by run-mp-selftest.sh, ext-scoped so it
        // can be left on without corrupting every OTHER test's real ".wav" stem) flips
        // the bytes of any raw GET whose key ends in ".corrupttest" — a reserved ext
        // used nowhere else in this file. A direct MultiplayerClient-level check (not
        // routed through MoshOps/a clip) isolates the exact mechanism cmdMpFetchMissingStems
        // depends on: its `land` lambda (MoshOps.cpp) only calls sourceMediaChanged() /
        // clears sourceMissing when downloadBlob returns true, and downloadBlob itself
        // never leaves a corrupt/truncated file on disk on a hash mismatch — so proving
        // downloadBlob's rejection here is precisely the guarantee the clip-level
        // self-heal flow (proven working above) relies on to keep a corrupted clip
        // sourceMissing (retryable) rather than falsely landing bad bytes as resolved.
        section ("Multiplayer PR-1 should-fix: downloadBlob rejects a corrupted transfer (MOSH_RELAY_BLOB_CORRUPT)");
        {
            MultiplayerClient corruptHost;
            const auto corruptCode = corruptHost.createSession ("CorruptHost", "#abcabc");
            check (corruptCode.isNotEmpty(), "corrupt: host created a session [" + corruptHost.lastError() + "]");

            MultiplayerClient corruptPeer;
            check (corruptPeer.joinSession (corruptCode, "CorruptPeer", "#cbacba"),
                   "corrupt: peer joined the room [" + corruptPeer.lastError() + "]");

            // Upload a KNOWN payload under the reserved "corrupttest" ext -- the relay's
            // hook targets exactly (and only) this ext for the whole run.
            const juce::String payload ("known-stem-bytes-for-the-corruption-rejection-check");
            juce::File srcTmp = selftestTempPath (eng, "corrupt-src.corrupttest");
            srcTmp.replaceWithText (payload);
            juce::FileInputStream fis (srcTmp);
            const auto hash = juce::SHA256 (fis).toHexString();
            check (corruptHost.uploadBlob (hash, "corrupttest", srcTmp),
                   "corrupt: host uploaded the known payload [" + corruptHost.lastError() + "]");
            srcTmp.deleteFile();

            juce::File dest = selftestTempPath (eng, "corrupt-dest-" + hash + ".corrupttest");
            dest.deleteFile();
            const bool got = corruptPeer.downloadBlob (hash, "corrupttest", dest);
            check (! got, "corrupt: downloadBlob correctly REJECTS the corrupted transfer (returns false)");
            check (! dest.existsAsFile(), "corrupt: the corrupted/truncated download was deleted, not left on disk");
            check (corruptPeer.lastError().contains ("hash mismatch"),
                   "corrupt: the error reports a hash mismatch [" + corruptPeer.lastError() + "]");

            // Retryable: a clean download (a normal ".wav"-scoped ext, untouched by the
            // hook) must still succeed right after -- the rejection above doesn't wedge
            // the client or the relay into a permanently-broken state.
            const juce::String payload2 ("clean-retry-bytes-prove-the-client-recovers");
            juce::File srcTmp2 = selftestTempPath (eng, "corrupt-retry-src.wav");
            srcTmp2.replaceWithText (payload2);
            juce::FileInputStream fis2 (srcTmp2);
            const auto hash2 = juce::SHA256 (fis2).toHexString();
            check (corruptHost.uploadBlob (hash2, "wav", srcTmp2),
                   "corrupt: host uploaded a second (clean-path) payload [" + corruptHost.lastError() + "]");
            srcTmp2.deleteFile();
            juce::File dest2 = selftestTempPath (eng, "corrupt-retry-dest-" + hash2 + ".wav");
            dest2.deleteFile();
            // NOTE: lastError() is sticky (only ever set, never cleared on success) --
            // don't print it here, it would misleadingly show the PRIOR rejection's
            // message even though this call succeeds.
            check (corruptPeer.downloadBlob (hash2, "wav", dest2),
                   "corrupt: a clean (non-corrupted-ext) retry still succeeds -- rejection is retryable, not wedged");
            check (dest2.existsAsFile(), "corrupt: the clean retry landed a real file");
            dest2.deleteFile();

            corruptPeer.leave();
            corruptHost.leave();
        }

        // ── Bootstrap end-to-end on the local/dev relay ──────────────────────
        // The NORMAL (non-regression) path: a fresh late-joiner adopts the host's
        // whole project via mp_apply_bootstrap, and the stem arrives automatically
        // (cmdMpApplyBootstrap's existing download-before-apply loop) — proving the
        // real cross-machine fetch that was previously only exercised against the
        // cloud relay now also works against relay/server.py.
        section ("Multiplayer P4: bootstrap end-to-end on the local relay");
        {
            MoshEngine bootHostEng (false, true, "mp-bootstrap-host");
            MoshOps    bootHostOps (bootHostEng);
            MoshEngine bootGuestEng (false, true, "mp-bootstrap-guest");
            MoshOps    bootGuestOps (bootGuestEng);

            auto bhSess = cmd (bootHostOps, "mp_create_session", objN ({ { "name", "BHost" }, { "color", "#333333" } }));
            check (ok (bhSess), "bootstrap: host created a session");
            const auto bhCode = bhSess.getProperty ("data", juce::var()).getProperty ("code", juce::var()).toString();

            check (ok (cmd (bootGuestOps, "mp_join_session",
                            objN ({ { "code", bhCode }, { "name", "BGuest" }, { "color", "#444444" } }))),
                   "bootstrap: guest joined the host's room");

            auto bmk = cmd (bootHostOps, "create_track", args1 ("name", "Boot Src"));
            const auto bhTrackId = bmk.getProperty ("data", juce::var()).getProperty ("trackId", juce::var()).toString();
            check (ok (cmd (bootHostOps, "add_test_tone_clip", objN ({ { "trackId", bhTrackId }, { "seconds", 1.0 } }))),
                   "bootstrap: host added a wave clip");

            auto bser = cmd (bootHostOps, "mp_serialize_project");
            check (ok (bser), "bootstrap: host mp_serialize_project ok");
            auto bBundle = bser.getProperty ("data", juce::var());
            check ((int) bBundle.getProperty ("count", 0) == 1, "bootstrap: serialized a 1-track bundle");

            auto bApp = cmd (bootGuestOps, "mp_apply_bootstrap",
                             objN ({ { "tracks", bBundle.getProperty ("tracks", juce::var()) },
                                     { "annotations", bBundle.getProperty ("annotations", juce::var()) } }));
            check (ok (bApp), "bootstrap: guest mp_apply_bootstrap ok");
            check ((int) bApp.getProperty ("data", juce::var()).getProperty ("applied", 0) == 1,
                   "bootstrap: guest applied 1 track");

            juce::String bLid;
            {
                auto snap = bootGuestOps.snapshot();
                if (auto* arr = snap["tracks"].getArray())
                    for (auto& tv : *arr)
                        if (tv.getProperty ("name", juce::var()).toString() == "Boot Src")
                            bLid = tv.getProperty ("logicalId", juce::var()).toString();
            }
            check (bLid.isNotEmpty(), "bootstrap: guest's track resolved by name");
            check (! clipSourceMissing (bootGuestOps, bLid),
                   "bootstrap: guest's clip is NOT sourceMissing (stem arrived via real cross-directory HTTP fetch)");

            cmd (bootGuestOps, "mp_leave_session");
            cmd (bootHostOps, "mp_leave_session");
        }

        a.leave();
        b.leave();
    }
}

} // namespace mosh
