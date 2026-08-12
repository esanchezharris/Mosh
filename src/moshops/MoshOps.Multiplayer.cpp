// RFC 001 (A-PR3) — MoshOps partial-class split: the multiplayer-domain
// command bodies (MP-001 session create/join/leave, track claim/commit +
// remote-commit apply/serialize helpers, lock sync, selection broadcast +
// signals, structural broadcast + apply, whole-project content addressing /
// bootstrap serialize + apply, and the self-heal missing-stem fetch), moved
// VERBATIM from MoshOps.cpp. Same class, same member functions — only the
// translation unit changed. The dispatch if-chain, lockKeyFor (the AL-011
// lock-scope map) and all transaction/log/result/emit plumbing stay in
// MoshOps.cpp (one mutation path, by construction).

#include "MoshOps.h"
#include "MoshOpsInternal.h"
#include "state/Ids.h"
#include "state/TrackGroup.h"
#include "engine/SourceRef.h"
#include "multiplayer/LogicalId.h"
#include "multiplayer/TrackCommit.h"
#include "multiplayer/AudioRefValidation.h"
#include <juce_cryptography/juce_cryptography.h>
#include <set>
#include <thread>

namespace mosh
{
using namespace juce;

namespace
{
    var redactedMpSessionLogArgs()
    {
        auto* o = new DynamicObject();
        o->setProperty ("session", "[redacted]");
        return var (o);
    }

    var mpTrackLogArgs (const var& args)
    {
        auto* o = new DynamicObject();
        o->setProperty ("trackId", args.getProperty ("trackId", var()).toString());
        return var (o);
    }

    bool isStructuralCommand (const String& name)
    {
        static const StringArray allowed {
            "create_annotation", "edit_annotation", "move_annotation", "remove_annotation",
            "set_tempo", "set_time_signature", "set_metronome",
            "set_master_volume", "set_master_pan",
            "load_master_plugin", "load_master_builtin", "remove_master_plugin",
            "reorder_master_plugin", "bypass_master_plugin", "set_master_plugin_param",
            "set_key", "set_count_in", "set_record_options",
            // MP-003 — buses (create/rename/remove; create self-broadcasts its
            // resolved bus number + mpBusId, see cmdCreateBus) and track groups
            // (create/configure/duplicate/set_members self-broadcast trackIds
            // translated to moshLogicalId, see translateTrackGroupTrackIds; the
            // rest carry only the group's own portable UUID).
            "create_bus", "rename_bus", "remove_bus",
            "create_track_group", "configure_track_group", "duplicate_track_group",
            "set_track_group_members", "set_track_group_enabled", "set_track_groups_suspended",
            "rename_track_group", "remove_track_group",
        };
        return allowed.contains (name);
    }

    String bootstrapAudioRefError (audioref::Error error)
    {
        switch (error)
        {
            case audioref::Error::none: return {};
            case audioref::Error::arrayRequired: return "bootstrap audioRefs must be an array";
            case audioref::Error::objectRequired: return "bootstrap audioRef must be an object";
            case audioref::Error::stringFieldsRequired: return "bootstrap audioRef hash and ext must be strings";
            case audioref::Error::invalidHash: return "bootstrap audioRef hash must be 64 hex characters";
            case audioref::Error::invalidExtension:
            case audioref::Error::destinationOutsideRoot: return "bootstrap audioRef extension is invalid";
        }
        return "bootstrap audioRef is invalid";
    }
}

void MoshOps::applyMultiplayerCommitForSelfTest (const juce::var& msg)
{
    applyMultiplayerCommitMessage (msg);
}

// PR-2: MultiplayerSession's stemBaseDir_ (worker-thread-only, mutex-guarded) must
// be refreshed from the message thread whenever eng.editFile() can change (a fresh
// project, an open, a Save As) or a session starts — the worker must NEVER call
// eng.editFile() itself (same torn-refcount reasoning as MultiplayerClient.h's
// roomCode_/etc: a juce::String is refcounted, so an unsynchronized cross-thread
// read/write is a crash risk, not just staleness).
void MoshOps::refreshMpStemDir()
{
    if (mpSession_ != nullptr)
        mpSession_->setStemBaseDir (eng.editFile().getParentDirectory().getFullPathName());
}

void MoshOps::applyMultiplayerCommitMessage (const juce::var& msg)
{
    // PR-2: the session's transfer worker has ALREADY prefetched every audioRef this
    // commit carries (routeStateMutatingJob's prefetch stage, before this apply stage
    // runs) — no download loop needed here anymore. applyMultiplayerCommitForSelfTest
    // calling this directly (bypassing the session/worker) therefore no longer
    // downloads stems either; a future direct-callback test needs its own prefetch
    // (mirroring what the session does) or should drive the download separately first.
    const auto envelopeLogicalId = msg.getProperty ("logicalId", var());
    if (! envelopeLogicalId.isString())
        return;

    const auto expectedLogicalId = envelopeLogicalId.toString();
    if (expectedLogicalId.isEmpty())
        return;

    auto* applyArgs = new DynamicObject();
    applyArgs->setProperty ("blob", msg.getProperty ("blob", var()));
    applyArgs->setProperty ("expectedLogicalId", expectedLogicalId);
    auto* command = new DynamicObject();
    command->setProperty ("command", "apply_remote_track");
    command->setProperty ("args", var (applyArgs));
    auto applied = execute (var (command));
    if ((bool) applied.getProperty ("ok", false))
        emitSnapshotInvalidated();
}

juce::var MoshOps::cmdMpSerializeTrack (const juce::var& args)
{
    // MP-001 — capture a track's portable blob for a peer commit. Read-only (no
    // undo transaction, no event): flushState() so plugin chunks/state are in the
    // tree, then serialize the whole track subtree.
    const auto id = args.getProperty ("trackId", var()).toString();
    auto* track = findTrack (id);
    if (track == nullptr)
        return errResult ("mp_serialize_track", "no track: " + id);

    eng.edit().flushState();
    const auto blob = trackcommit::serialize (*track);
    if (blob.isEmpty())
        return errResult ("mp_serialize_track", "serialize produced an empty blob");

    auto* o = new DynamicObject();
    o->setProperty ("blob", blob);
    o->setProperty ("logicalId", logicalid::ensureTrack (track->state));
    return okResult ("mp_serialize_track", var (o));
}

juce::var MoshOps::cmdApplyRemoteTrack (const juce::var& args)
{
    // MP-001 — apply a peer's committed track. Mutates via a nullptr UndoManager
    // (never the local user's undo stack) and emits NOTHING (no relay echo); the
    // local repaint is driven separately (P5). Backend-only / peer-origin.
    const auto blob = args.getProperty ("blob", var()).toString();
    if (blob.isEmpty())
        return errResult ("apply_remote_track", "missing blob");

    const auto expectedLogicalId = args.getProperty ("expectedLogicalId", var()).toString();
    auto res = trackcommit::apply (eng.edit(), blob, expectedLogicalId);
    if (! res.ok)
        return errResult ("apply_remote_track", res.error);

    // NB: deliberately NO message-loop drain here. Tracktion's track list updates
    // synchronously on the ValueTree child add/remove, so the snapshot already
    // reflects the replaced track. Draining would (a) tick the 30 Hz metering /
    // (b) advance the UndoManager's open transaction — both of which would leak
    // into a remote apply that must be invisible to telemetry AND the undo stack.
    eng.markDirty();   // the Edit genuinely changed (outside the undo system)

    auto* o = new DynamicObject();
    o->setProperty ("logicalId", res.logicalId);
    o->setProperty ("mode", res.created ? "created" : "replaced");
    return okResult ("apply_remote_track", var (o));
}

juce::var MoshOps::cmdMpSyncLocks (const juce::var& args)
{
    // MP-001 — mirror the relay's session/lock state into the local guard. Driven
    // by the live poll path; backend-only (Unguarded). active:false => single-player.
    if (! (bool) args.getProperty ("active", false))
    {
        lockManager_.deactivate();
        auto* o = new DynamicObject();
        o->setProperty ("active", false);
        return okResult ("mp_sync_locks", var (o));
    }

    lockManager_.activate (args.getProperty ("selfPeer", var()).toString());

    std::map<juce::String, juce::String> locks;
    if (auto* lo = args.getProperty ("locks", var()).getDynamicObject())
        for (auto& kv : lo->getProperties())
            locks[kv.name.toString()] = kv.value.toString();
    lockManager_.setLocks (std::move (locks));

    auto* o = new DynamicObject();
    o->setProperty ("active", true);
    o->setProperty ("selfPeer", lockManager_.selfPeer());
    return okResult ("mp_sync_locks", var (o));
}

juce::var MoshOps::cmdMpCreateSession (const juce::var& args)
{
    const auto logArgs = redactedMpSessionLogArgs();
    const auto code = mpSession_->createSession (args.getProperty ("name", var()).toString(),
                                                 args.getProperty ("color", var()).toString());
    if (code.isEmpty())
    {
        const juce::String error = "could not reach the relay (MOSH_RELAY_URL)";
        logLine ("mp_create_session", logArgs, false, error, false);
        return errResult ("mp_create_session", error);
    }
    refreshMpStemDir();   // PR-2: defensive re-stamp (also done at construction + project-file changes)
    auto* o = new DynamicObject();
    o->setProperty ("code", code);
    o->setProperty ("selfPeer", mpSession_->selfPeer());
    logLine ("mp_create_session", logArgs, true, {}, false);
    return okResult ("mp_create_session", var (o));
}

juce::var MoshOps::cmdMpJoinSession (const juce::var& args)
{
    const auto logArgs = redactedMpSessionLogArgs();
    if (! mpSession_->joinSession (args.getProperty ("code", var()).toString(),
                                   args.getProperty ("name", var()).toString(),
                                   args.getProperty ("color", var()).toString()))
    {
        const juce::String error = "join failed (bad code / relay unreachable)";
        logLine ("mp_join_session", logArgs, false, error, false);
        return errResult ("mp_join_session", error);
    }
    refreshMpStemDir();   // PR-2: defensive re-stamp (also done at construction + project-file changes)
    auto* o = new DynamicObject();
    o->setProperty ("selfPeer", mpSession_->selfPeer());
    logLine ("mp_join_session", logArgs, true, {}, false);
    return okResult ("mp_join_session", var (o));
}

juce::var MoshOps::cmdMpLeaveSession (const juce::var&)
{
    mpSession_->leaveSession();
    logLine ("mp_leave_session", var (new DynamicObject()), true, {}, false);
    return okResult ("mp_leave_session");
}

juce::var MoshOps::cmdMpClaimTrack (const juce::var& args)
{
    const auto logArgs = mpTrackLogArgs (args);
    auto* t = findTrack (args.getProperty ("trackId", var()).toString());
    if (t == nullptr)
    {
        logLine ("mp_claim_track", logArgs, false, "no track", false);
        return errResult ("mp_claim_track", "no track");
    }
    const auto lid = logicalid::ensureTrack (t->state);
    const int epoch = mpSession_->claim (lid);
    auto* o = new DynamicObject();
    o->setProperty ("granted", epoch >= 0);
    o->setProperty ("logicalId", lid);
    logLine ("mp_claim_track", logArgs, true, {}, false);
    return okResult ("mp_claim_track", var (o));
}

juce::var MoshOps::cmdMpCommitTrack (const juce::var& args)
{
    const auto logArgs = mpTrackLogArgs (args);
    auto* t = findTrack (args.getProperty ("trackId", var()).toString());
    if (t == nullptr)
    {
        logLine ("mp_commit_track", logArgs, false, "no track", false);
        return errResult ("mp_commit_track", "no track");
    }

    // P4 — content-address each wave clip's audio into <editDir>/audio/by-hash/ and
    // rewrite the clip to that RELATIVE ref, so the serialized state + the peer
    // resolve the same path once the bytes are fetched.
    auto byHashDir = eng.editFile().getParentDirectory().getChildFile ("audio").getChildFile ("by-hash");
    Array<var> audioRefs;
    juce::Array<juce::File> stemFiles;   // parallel to audioRefs; local paths only, PR-2's worker uploads these
    for (auto* c : t->getClips())
        if (auto* w = dynamic_cast<te::WaveAudioClip*> (c))
        {
            auto src = w->getCurrentSourceFile();
            if (! src.existsAsFile()) continue;
            juce::FileInputStream fis (src);
            if (! fis.openedOk()) continue;
            const auto hash = juce::SHA256 (fis).toHexString();
            const auto ext  = src.getFileExtension().removeCharacters (".");
            auto dest = byHashDir.getChildFile (hash + "." + ext);
            if (! dest.existsAsFile())
            {
                byHashDir.createDirectory();
                src.copyFileTo (dest);
            }
            if (src != dest)
                // Relative by-hash ref so the serialized state + the peer resolve the same
                // stem. repointWaveClipSource stores it relative to the edit file's PARENT
                // dir (not setToDirectFileReference's edit-FILE-relative "../" form, which
                // would escape the session dir and hang a later export — PR #104).
                repointWaveClipSource (*w, dest, eng.editFile().getParentDirectory(), true);
            auto* r = new DynamicObject(); r->setProperty ("hash", hash); r->setProperty ("ext", ext);
            audioRefs.add (var (r));
            stemFiles.add (dest);
        }

    eng.edit().flushState();
    const auto blob = trackcommit::serialize (*t);
    const auto lid  = logicalid::ensureTrack (t->state);

    // PR-2: everything above is synchronous engine work (an immutable content-
    // addressed snapshot, so further edits during the upload are safe by
    // construction). mpSession_->commit() does the upload + publish + lock release
    // on its transfer worker (or inline under MOSH_MP_SYNC_TRANSFER=1) and reports
    // completion via an additive `mp_commit_done` event — this returns immediately.
    bool asyncTransfer = false;
    if (blob.isNotEmpty())
    {
        asyncTransfer = ! mpSession_->syncTransferMode();
        mpSession_->commit (lid, blob, var (audioRefs), stemFiles);
    }

    auto* o = new DynamicObject();
    o->setProperty ("logicalId", lid);
    o->setProperty ("audioRefs", var (audioRefs));
    o->setProperty ("status", asyncTransfer ? "uploading" : "committed");
    logLine ("mp_commit_track", logArgs, true, {}, false);
    return okResult ("mp_commit_track", var (o));
}

juce::var MoshOps::cmdMpBroadcastSelection (const juce::var& args)
{
    mpSession_->broadcastSelection (args.getProperty ("trackId", var()).toString(),
                                    args.getProperty ("clipId", var()).toString());
    return okResult ("mp_broadcast_selection");
}

juce::var MoshOps::cmdMpSendSignal (const juce::var& args)
{
    // Point-to-point WebRTC handshake (SDP/ICE) to one peer — the UI's video room owns
    // the negotiation; this only ferries the opaque payload over the relay.
    mpSession_->sendSignal (args.getProperty ("to", var()).toString(),
                            args.getProperty ("payload", var()));
    return okResult ("mp_send_signal");
}

juce::var MoshOps::broadcastStructuralIfActive (const juce::String& name, const juce::var& args, juce::var result)
{
    // Mirror a successful local session-global scalar op to the peer (LWW). Skipped
    // when single-player, while applying a peer's op (echo-free), or when the command
    // is outside the same closed registry enforced at the inbound boundary.
    if (isStructuralCommand (name) && mpSession_ != nullptr && mpSession_->active() && ! applyingRemote_
        && (bool) result.getProperty ("ok", false))
        mpSession_->broadcastStructural (name, args);
    return result;
}

juce::var MoshOps::translateTrackGroupTrackIds (const juce::String& command, const juce::var& args, bool toLogical)
{
    static const std::set<juce::String> trackIdCommands {
        "create_track_group", "configure_track_group", "duplicate_track_group", "set_track_group_members"
    };
    if (! trackIdCommands.count (command))
        return args;

    auto* srcArray = args.getProperty ("trackIds", var()).getArray();
    if (srcArray == nullptr)
        return args;

    Array<var> translated;
    for (auto& v : *srcArray)
    {
        const auto id = v.toString();
        if (toLogical)
        {
            if (auto* t = findTrack (id))
            {
                const auto lid = logicalid::ensureTrack (t->state);
                if (lid.isNotEmpty())
                    translated.add (lid);
            }
        }
        else if (auto* t = findTrackByLogicalId (id))
            translated.add (t->itemID.toString());
    }

    // Copy every other property through unchanged, then replace trackIds.
    auto* out = new DynamicObject();
    if (auto* src = args.getDynamicObject())
        out->getProperties() = src->getProperties();
    out->setProperty ("trackIds", translated);
    return var (out);
}

juce::var MoshOps::cmdMpApplyStructural (const juce::var& args)
{
    const auto name = args.getProperty ("command", var()).toString();
    if (! isStructuralCommand (name) || ! args.getProperty ("args", var()).isObject())
        return errResult ("mp_apply_structural", "structural command is not allowed");

    // MP-003 — groups: `trackIds` (create/configure/duplicate_track_group,
    // set_track_group_members) arrives in the SENDER's cross-peer-stable
    // moshLogicalId form (see cmdCreateTrackGroup etc.'s own broadcast); translate
    // it back into OUR local raw ids before replaying — a no-op for every other
    // command (see translateTrackGroupTrackIds's doc comment).
    const auto commandArgs = translateTrackGroupTrackIds (name, args.getProperty ("args", var()), false);

    // Re-execute a peer's structural op locally: applyingRemote_ bypasses the lock
    // guard (it is incoming history) AND short-circuits broadcastStructuralIfActive
    // (no echo). The inner command's own emit repaints the UI.
    auto* c = new DynamicObject();
    c->setProperty ("command", name);
    c->setProperty ("args", commandArgs);

    const ScopedValueSetter<bool> remoteApply (applyingRemote_, true);
    auto r = execute (var (c));
    return okResult ("mp_apply_structural", r);
}

// PR-2: shared by cmdMpSerializeProject (the public, directly-callable command,
// which uploads synchronously itself right after — kept behavior-compatible for
// existing direct-call tests) and serializeProjectForBootstrapAnswer (the live-
// session bootstrap-answer path, whose worker uploads instead). Content-addresses
// + rewrites + serializes every track's clips; uploads NOTHING itself. Returns
// {tracks:[{logicalId,blob,audioRefs}], count, annotations, stemFiles:[{hash,ext,path}]}
// — stemFiles is the flattened list across all tracks (what a bootstrap-answer
// upload job needs; audioRefs stays nested per-track for the wire message, as before).
juce::var MoshOps::contentAddressWholeProjectNoUpload()
{
    // Each track's wave clips are content-addressed into <editDir>/audio/by-hash/ and
    // rewritten to that RELATIVE ref, with the by-hash refs attached to the track
    // entry — so a guest who joins mid-session adopts pre-existing AUDIO, not just
    // structure/MIDI. Mirrors the commit path (cmdMpCommitTrack).
    auto byHashDir = eng.editFile().getParentDirectory().getChildFile ("audio").getChildFile ("by-hash");
    juce::Array<var> tracks;
    juce::Array<var> stemFiles;
    for (auto* t : te::getAudioTracks (eng.edit()))
    {
        if (t == nullptr) continue;

        Array<var> audioRefs;
        for (auto* c : t->getClips())
            if (auto* w = dynamic_cast<te::WaveAudioClip*> (c))
            {
                auto src = w->getCurrentSourceFile();
                if (! src.existsAsFile()) continue;
                juce::FileInputStream fis (src);
                if (! fis.openedOk()) continue;
                const auto hash = juce::SHA256 (fis).toHexString();
                const auto ext  = src.getFileExtension().removeCharacters (".");
                auto dest = byHashDir.getChildFile (hash + "." + ext);
                if (! dest.existsAsFile())
                {
                    byHashDir.createDirectory();
                    src.copyFileTo (dest);
                }
                if (src != dest)
                    // Relative by-hash ref (repointWaveClipSource's PARENT-relative form, not
                    // setToDirectFileReference's edit-FILE-relative "../" — PR #104), so the
                    // serialized blob + the joiner resolve the same path once bytes are fetched.
                    repointWaveClipSource (*w, dest, eng.editFile().getParentDirectory(), true);
                auto* r = new DynamicObject(); r->setProperty ("hash", hash); r->setProperty ("ext", ext);
                audioRefs.add (var (r));

                auto* sf = new DynamicObject();
                sf->setProperty ("hash", hash);
                sf->setProperty ("ext", ext);
                sf->setProperty ("path", dest.getFullPathName());
                stemFiles.add (var (sf));
            }

        eng.edit().flushState();   // AFTER the repoints, so the serialized state carries the by-hash refs
        auto* o = new DynamicObject();
        o->setProperty ("logicalId", logicalid::ensureTrack (t->state));
        o->setProperty ("blob", trackcommit::serialize (*t));
        // Refs ride INSIDE the track entry: MultiplayerSession's bootstrap marshaling copies
        // only `tracks`/`annotations`, so a top-level refs field would be dropped on the wire.
        o->setProperty ("audioRefs", var (audioRefs));
        tracks.add (var (o));
    }
    auto* d = new DynamicObject();
    d->setProperty ("tracks", tracks);
    d->setProperty ("count", tracks.size());
    d->setProperty ("stemFiles", var (stemFiles));
    // Annotations are a top-level Edit child (a sibling of the tracks), so the per-track
    // blobs above don't carry them — serialize the subtree so a late-joiner adopts the
    // host's existing pins, not just the ones created live after they join.
    if (auto a = eng.edit().state.getChildWithName (ids::MOSH_ANNOTATIONS); a.isValid())
        if (auto xml = a.createXml())
            d->setProperty ("annotations", xml->toString());

    // MP-003 — buses and track groups also ride the bootstrap bundle, not just the
    // live structural channel (create_bus/create_track_group's own broadcast).
    // Reason: cmdMpApplyBootstrap WIPES AND RE-CREATES every track below (fresh,
    // remapped local EditItemIDs) to adopt the host's whole project — a track
    // group applied EARLIER, e.g. from a live message a late-joiner's poll caught
    // in the same backlog batch as this bootstrap, would end up pointing at
    // EditItemIDs the wipe just deleted. Carrying groups/buses INSIDE the bundle
    // lets cmdMpApplyBootstrap (re-)apply them AFTER the wipe, against the
    // tracks it JUST created, so they can never be orphaned by it.
    Array<var> buses;
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr)
            if (auto* r = firstAuxReturnOn (*t))
            {
                const int bus = r->busNumber.get();
                auto* bo = new DynamicObject();
                bo->setProperty ("bus", bus);
                bo->setProperty ("name", eng.edit().getAuxBusName (bus).isNotEmpty()
                                             ? eng.edit().getAuxBusName (bus) : ("Bus " + String (bus + 1)));
                bo->setProperty ("mpBusId", logicalid::ensureBus (t->state));
                buses.add (var (bo));
            }
    d->setProperty ("buses", buses);

    Array<var> trackGroups;
    if (auto groups = eng.edit().state.getChildWithName (ids::MOSH_TRACK_GROUPS); groups.isValid())
        for (int i = 0; i < groups.getNumChildren(); ++i)
        {
            const auto group = groups.getChild (i);
            if (! group.hasType (ids::MOSH_TRACK_GROUP)) continue;
            auto* go = new DynamicObject();
            go->setProperty ("groupId", group[ids::id].toString());
            go->setProperty ("name", group[ids::trackGroupName].toString());
            go->setProperty ("kind", group[ids::trackGroupKind].toString());
            go->setProperty ("enabled", (bool) group.getProperty (ids::trackGroupEnabled, true));
            Array<var> mixAttrs;
            for (const auto& a : TrackGroup::mixAttributes (group)) mixAttrs.add (a);
            go->setProperty ("mixAttributes", mixAttrs);
            // Member ids translated to the cross-peer-stable moshLogicalId (raw
            // EditItemIDs are per-engine — see translateTrackGroupTrackIds).
            Array<var> logicalTrackIds;
            for (const auto& trackId : TrackGroup::memberIds (group))
                if (auto* mt = findTrack (trackId))
                {
                    const auto lid = logicalid::ensureTrack (mt->state);
                    if (lid.isNotEmpty()) logicalTrackIds.add (lid);
                }
            go->setProperty ("trackIds", logicalTrackIds);
            trackGroups.add (var (go));
        }
    d->setProperty ("trackGroups", trackGroups);

    return var (d);
}

juce::var MoshOps::cmdMpSerializeProject (const juce::var&)
{
    // P6 — the whole project as a bundle of per-track blobs, for a late-joiner.
    // Closes the old "bootstrap audio not wired" gap. Graceful on the local relay
    // (uploadBlob no-ops there pre-PR-1; now the local relay has a blob store too).
    auto d = contentAddressWholeProjectNoUpload();

    // Upload the stems (content-addressed dedup) so the joiner can fetch what it
    // lacks. Kept SYNCHRONOUS here (unlike the live-session bootstrap-answer path,
    // PR-2, whose worker uploads instead) so this public, directly-callable command
    // stays behavior-compatible with existing direct-call tests.
    if (auto* sf = d.getProperty ("stemFiles", var()).getArray())
        for (auto& s : *sf)
        {
            const auto h = s.getProperty ("hash", var()).toString();
            const auto e = s.getProperty ("ext", var()).toString();
            const auto p = s.getProperty ("path", var()).toString();
            mpSession_->uploadBlob (h, e, juce::File (p));
        }
    return okResult ("mp_serialize_project", d);
}

juce::var MoshOps::serializeProjectForBootstrapAnswer()
{
    // PR-2: the message-thread part of the host's bootstrap answer -- content-
    // address + serialize (touches the engine, so it must run here, on the message
    // thread) WITHOUT uploading; the session's transfer worker uploads the returned
    // stemFiles[] and then publishes bootstrap_state (see MultiplayerSession::pollLoop's
    // "bootstrap_request" handling).
    return contentAddressWholeProjectNoUpload();
}

juce::String MoshOps::validateBootstrapBundle (const juce::var& args) const
{
    if (! args.isObject())
        return "bootstrap bundle must be an object";

    const auto tracksValue = args.getProperty ("tracks", var());
    auto* tracksArray = tracksValue.getArray();
    if (tracksArray == nullptr)
        return "bootstrap bundle requires a tracks array";

    StringArray logicalIds;
    for (const auto& track : *tracksArray)
    {
        if (! track.isObject())
            return "bootstrap track entry must be an object";

        const auto logicalIdValue = track.getProperty ("logicalId", var());
        const auto blobValue = track.getProperty ("blob", var());
        if (! logicalIdValue.isString() || logicalIdValue.toString().isEmpty())
            return "bootstrap track requires a string logicalId";
        if (! blobValue.isString() || blobValue.toString().isEmpty())
            return "bootstrap track requires a string blob";

        const auto logicalId = logicalIdValue.toString();
        if (logicalIds.contains (logicalId))
            return "bootstrap contains duplicate logicalId";
        logicalIds.add (logicalId);

        if (auto validated = trackcommit::validate (blobValue.toString(), logicalId); ! validated.ok)
            return validated.error;

        if (const auto refs = audioref::validate (track.getProperty ("audioRefs", var())); ! refs.ok())
            return bootstrapAudioRefError (refs.error);
    }

    const auto annotationsValue = args.getProperty ("annotations", var());
    if (! annotationsValue.isVoid())
    {
        if (! annotationsValue.isString())
            return "bootstrap annotations must be XML text";
        const auto text = annotationsValue.toString();
        if (text.isNotEmpty())
        {
            auto xml = parseXML (text);
            if (xml == nullptr)
                return "bootstrap annotations are not valid XML";
            auto annotations = ValueTree::fromXml (*xml);
            if (! annotations.isValid() || ! annotations.hasType (ids::MOSH_ANNOTATIONS))
                return "bootstrap annotations have the wrong root";
            for (int i = 0; i < annotations.getNumChildren(); ++i)
                if (! annotations.getChild (i).hasType (ids::MOSH_ANNOTATION))
                    return "bootstrap annotations contain an invalid child";
        }
    }

    // MP-003 — buses/trackGroups are ADDITIVE (a bundle from a peer that predates
    // this feature simply omits them, same posture as annotations above): absent
    // is fine, present must be well-formed so a malformed/tampered bundle can't
    // reach the destructive apply phase.
    const auto busesValue = args.getProperty ("buses", var());
    if (! busesValue.isVoid())
    {
        auto* busesArray = busesValue.getArray();
        if (busesArray == nullptr)
            return "bootstrap buses must be an array";
        for (const auto& bus : *busesArray)
        {
            if (! bus.isObject())
                return "bootstrap bus entry must be an object";
            if (! bus.getProperty ("bus", var()).isInt() && ! bus.getProperty ("bus", var()).isInt64())
                return "bootstrap bus entry requires an integer bus number";
            if (! bus.getProperty ("mpBusId", var()).isString() || bus.getProperty ("mpBusId", var()).toString().isEmpty())
                return "bootstrap bus entry requires a string mpBusId";
        }
    }

    const auto trackGroupsValue = args.getProperty ("trackGroups", var());
    if (! trackGroupsValue.isVoid())
    {
        auto* groupsArray = trackGroupsValue.getArray();
        if (groupsArray == nullptr)
            return "bootstrap trackGroups must be an array";
        for (const auto& group : *groupsArray)
        {
            if (! group.isObject())
                return "bootstrap track group entry must be an object";
            if (! group.getProperty ("groupId", var()).isString() || group.getProperty ("groupId", var()).toString().isEmpty())
                return "bootstrap track group entry requires a string groupId";
            if (auto* memberIds = group.getProperty ("trackIds", var()).getArray())
            {
                for (const auto& memberId : *memberIds)
                    if (! memberId.isString())
                        return "bootstrap track group trackIds must be strings";
            }
            else if (! group.getProperty ("trackIds", var()).isVoid())
                return "bootstrap track group trackIds must be an array";
        }
    }

    return {};
}

juce::var MoshOps::cmdMpApplyBootstrap (const juce::var& args)
{
    if (const auto error = validateBootstrapBundle (args); error.isNotEmpty())
        return errResult ("mp_apply_bootstrap", error);

    auto& edit = eng.edit();

    // PR-2: bundles arriving through the LIVE SESSION path (MultiplayerSession's
    // "bootstrap_state" handling) have already had every stem prefetched by the
    // transfer worker before this is called — stemsPrefetched:true skips the inline
    // download loop below entirely. Direct calls (the harness/agents/`mp_apply_bootstrap`
    // outside a live session) never set this flag, so their own inline download runs
    // exactly as before — the direct-command contract is unchanged.
    const bool stemsPrefetched = (bool) args.getProperty ("stemsPrefetched", false);

    auto* tracksArray = args.getProperty ("tracks", var()).getArray();
    auto byHashDir = eng.editFile().getParentDirectory().getChildFile ("audio").getChildFile ("by-hash");
    for (auto& tv : *tracksArray)
    {
        if (! stemsPrefetched)
            if (auto* refs = tv.getProperty ("audioRefs", var()).getArray())
                for (auto& a : *refs)
                {
                    const auto h = a.getProperty ("hash", var()).toString();
                    const auto e = a.getProperty ("ext", var()).toString();
                    const auto resolved = audioref::resolveContainedDestination (byHashDir, a);
                    if (! resolved.ok())
                        return errResult ("mp_apply_bootstrap", bootstrapAudioRefError (resolved.error));
                    if (! resolved.destination.existsAsFile())
                        mpSession_->downloadBlob (h, e, resolved.destination);
                }
    }

    // Validate again immediately before the destructive phase. The first pass protects
    // prefetch; this pass protects deletion if the command is ever refactored to yield.
    if (const auto error = validateBootstrapBundle (args); error.isNotEmpty())
        return errResult ("mp_apply_bootstrap", error);

    for (auto* t : te::getAudioTracks (edit))
        if (t != nullptr)
        {
            auto state = t->state;
            state.getParent().removeChild (state, nullptr);
        }

    int applied = 0;
    for (auto& tv : *tracksArray)
    {
        const auto logicalId = tv.getProperty ("logicalId", var()).toString();
        const auto result = trackcommit::apply (edit, tv.getProperty ("blob", var()).toString(), logicalId);
        if (! result.ok)
            return errResult ("mp_apply_bootstrap", "validated track failed to apply: " + result.error);
        ++applied;
    }

    // Adopt the host's annotations (a top-level Edit child, outside the per-track blobs):
    // drop ours, graft the host's subtree. nullptr UndoManager — incoming history, like
    // the track splices above.
    if (auto existing = edit.state.getChildWithName (ids::MOSH_ANNOTATIONS); existing.isValid())
        edit.state.removeChild (existing, nullptr);
    if (const auto annXml = args.getProperty ("annotations", var()).toString(); annXml.isNotEmpty())
        if (auto xml = juce::parseXML (annXml))
            if (auto vt = juce::ValueTree::fromXml (*xml); vt.isValid())
                edit.state.appendChild (vt, nullptr);

    int annotationCount = 0;
    if (auto annotations = edit.state.getChildWithName (ids::MOSH_ANNOTATIONS); annotations.isValid())
        annotationCount = annotations.getNumChildren();

    // MP-003 — buses and track groups. The track wipe above already removed any
    // LOCAL bus (a bus's return track is a regular AudioTrack), so just
    // (re)create each of the host's; drop any local track groups, then adopt
    // the host's, translating member ids from the sender's stable moshLogicalId
    // to the LOCAL ids the track-apply loop above JUST (re)created — never
    // against anything from before this bootstrap (see
    // contentAddressWholeProjectNoUpload's doc comment for why that matters:
    // a live create_track_group message a late-joiner's poll caught in the same
    // backlog batch as this bootstrap would otherwise point at EditItemIDs the
    // wipe above just deleted). applyingRemote_ suppresses the inner commands'
    // own re-broadcast (this bundle IS the sync, not a new local edit) the same
    // way cmdMpApplyStructural does for a single op; routed through execute()
    // so each still gets its normal transaction/journal treatment. Best-effort:
    // one failed bus/group must not fail the whole adoption.
    {
        const ScopedValueSetter<bool> remoteApply (applyingRemote_, true);
        if (auto* busesArray = args.getProperty ("buses", var()).getArray())
            for (auto& bv : *busesArray)
            {
                auto* busArgs = new DynamicObject();
                busArgs->setProperty ("name", bv.getProperty ("name", var()));
                busArgs->setProperty ("bus", bv.getProperty ("bus", var()));
                busArgs->setProperty ("mpBusId", bv.getProperty ("mpBusId", var()));
                auto* busCmd = new DynamicObject();
                busCmd->setProperty ("command", "create_bus");
                busCmd->setProperty ("args", var (busArgs));
                execute (var (busCmd));
            }

        if (auto existingGroups = edit.state.getChildWithName (ids::MOSH_TRACK_GROUPS); existingGroups.isValid())
            edit.state.removeChild (existingGroups, nullptr);
        if (auto* groupsArray = args.getProperty ("trackGroups", var()).getArray())
            for (auto& gv : *groupsArray)
            {
                auto* groupArgs = new DynamicObject();
                groupArgs->setProperty ("groupId", gv.getProperty ("groupId", var()));
                groupArgs->setProperty ("name", gv.getProperty ("name", var()));
                groupArgs->setProperty ("kind", gv.getProperty ("kind", var()));
                groupArgs->setProperty ("mixAttributes", gv.getProperty ("mixAttributes", var()));
                groupArgs->setProperty ("trackIds", gv.getProperty ("trackIds", var()));
                auto* groupCmd = new DynamicObject();
                groupCmd->setProperty ("command", "create_track_group");
                groupCmd->setProperty ("args", translateTrackGroupTrackIds ("create_track_group", var (groupArgs), false));
                execute (var (groupCmd));

                if (! (bool) gv.getProperty ("enabled", true))
                {
                    auto* enabledArgs = new DynamicObject();
                    enabledArgs->setProperty ("groupId", gv.getProperty ("groupId", var()));
                    enabledArgs->setProperty ("enabled", false);
                    auto* enabledCmd = new DynamicObject();
                    enabledCmd->setProperty ("command", "set_track_group_enabled");
                    enabledCmd->setProperty ("args", var (enabledArgs));
                    execute (var (enabledCmd));
                }
            }
    }

    undoManager().clearUndoHistory();
    ++editRevision_;
    eng.markDirty();
    emitProjectReplaced ("multiplayer_bootstrap");

    // P4 self-heal (PR-1): the download loop above ignores its result, so a transient
    // upload/download failure during THIS bootstrap (or a peer's blob that hadn't
    // finished landing) can leave a just-applied clip sourceMissing. Kick off a retry
    // pass so the guest doesn't need the host to notice and re-commit that track — a
    // no-op (synchronous, effectively free) when nothing is missing.
    cmdMpFetchMissingStems (var (new DynamicObject()));

    const auto source = args.getProperty ("source", var()).toString() == "peer" ? String ("peer")
                                                                                 : String ("direct");
    auto* logArgsObject = new DynamicObject();
    logArgsObject->setProperty ("trackCount", applied);
    logArgsObject->setProperty ("annotationCount", annotationCount);
    logArgsObject->setProperty ("source", source);
    logLine ("mp_apply_bootstrap", var (logArgsObject), true, {}, false);

    auto* d = new DynamicObject();
    d->setProperty ("applied", applied);
    d->setProperty ("annotationCount", annotationCount);
    d->setProperty ("source", source);
    return okResult ("mp_apply_bootstrap", var (d));
}

juce::var MoshOps::cmdMpFetchMissingStems (const juce::var& args)
{
    // Self-heal (P4/PR-1): every uploadBlob/downloadBlob result in mp_commit_track,
    // mp_serialize_project, mp_apply_bootstrap, and applyMultiplayerCommitMessage is
    // ignored at its call site — a single transient HTTP failure otherwise leaves a
    // clip's audio sourceMissing forever, with the host manually re-committing that
    // track as the only prior recovery ("nudging"). This command self-heals: it
    // enumerates every wave clip whose source is currently missing, recognizes the
    // ones referencing a content-addressed by-hash stem (repointWaveClipSource's own
    // form: ".../audio/by-hash/<64-hex-sha256>.<ext>" — the hash IS the fetch key, no
    // separate bookkeeping needed), and retries the download for exactly those. A
    // clip missing its source for any OTHER reason (a plain moved/deleted local file)
    // is untouched — that is relink_clip's job, not a peer blob store's.
    struct Missing
    {
        juce::String clipId, hash, ext;
        juce::File dest;
    };
    juce::Array<Missing> missing;

    for (auto* t : te::getAudioTracks (eng.edit()))
    {
        if (t == nullptr) continue;
        for (auto* c : t->getClips())
            if (auto* w = dynamic_cast<te::WaveAudioClip*> (c))
            {
                const auto resolved = w->getCurrentSourceFile();
                if (resolved.existsAsFile()) continue;

                if (resolved.getParentDirectory().getFileName() != "by-hash") continue;
                const auto stem = resolved.getFileNameWithoutExtension();
                if (stem.length() != 64 || ! stem.containsOnly ("0123456789abcdef")) continue;

                // Adversarial-review finding #3 (originally a MoshOps-local, message-
                // thread-only set) — a concurrent pass is already fetching this exact
                // hash; skip it here rather than spawn a second downloadBlob into the
                // SAME dest file (delete-then-create-then-stream), whose partial state
                // the other pass's existsAsFile()/size check could otherwise observe.
                // SHOULD-FIX (PR-2 review): this registry now lives on mpSession_
                // (thread-safe, mutex-guarded) instead of a MoshOps-local set, because
                // the transfer worker's OWN prefetch (MultiplayerSession::prefetchAudioRefs,
                // a DIFFERENT OS thread) can want the SAME hash concurrently — a
                // message-thread-only set couldn't see across that boundary.
                // claimStem() atomically tests-and-claims: a false here means someone
                // else (this same scan's earlier duplicate, or the worker thread) has
                // it, so skip rather than add it to `missing` at all. A null mpSession_
                // can't claim anything -- fall through and add it anyway (the download
                // attempt below safely no-ops on a null session).
                if (mpSession_ != nullptr && ! mpSession_->claimStem (stem)) continue;

                missing.add ({ c->itemID.toString(), stem,
                              resolved.getFileExtension().removeCharacters ("."), resolved });
            }
    }

    // Runs on the message thread: re-resolve each clip by id (it may have been
    // removed/undone since the scan above — findClip returns nullptr, skipped), write
    // the fetched bytes' arrival into the clip's cached source (sourceMediaChanged,
    // mirroring repointWaveClipSource's own post-repoint call), and emit exactly one
    // snapshot_invalidated if anything actually landed. downloadBlob (adversarial-review
    // finding #1) now verifies the downloaded bytes' SHA-256 against `hash` itself before
    // reporting success, so a truncated/corrupt transfer is never blessed as resolved here.
    auto land = [this] (const juce::Array<Missing>& items) -> juce::var
    {
        int fetched = 0, failed = 0;
        juce::Array<var> stillMissing;
        for (auto& m : items)
        {
            const bool got = mpSession_ != nullptr
                             && mpSession_->downloadBlob (m.hash, m.ext, m.dest)
                             && m.dest.existsAsFile();
            if (got)
            {
                if (auto* w = dynamic_cast<te::WaveAudioClip*> (findClip (m.clipId)))
                    w->sourceMediaChanged();
                ++fetched;
            }
            else
            {
                ++failed;
                stillMissing.add (m.hash);
            }
            if (mpSession_ != nullptr) mpSession_->releaseStem (m.hash);
        }
        if (fetched > 0)
            emitSnapshotInvalidated();

        auto* d = new DynamicObject();
        d->setProperty ("fetched", fetched);
        d->setProperty ("failed", failed);
        d->setProperty ("stillMissing", var (stillMissing));
        return okResult ("mp_fetch_missing_stems", var (d));
    };

    const bool wait = (bool) args.getProperty ("wait", false);
    if (missing.isEmpty() || wait)
        return land (missing);

    // Async (GUI / the bootstrap auto-trigger): downloadBlob does blocking HTTP, so it
    // must not run on the message thread (mirrors cmdTranscribeClip's dual-mode shape).
    // The clip lookup + sourceMediaChanged()/emitSnapshotInvalidated() are message-
    // thread-only, so only the network round-trip runs on the background thread;
    // results land back via callAsync. releaseStem() is thread-safe (SHOULD-FIX, PR-2
    // review), so each item's claim is released right on the background thread,
    // immediately after its own download attempt — shorter hold time than batching
    // every release into the final callAsync.
    std::thread ([this, missing]
    {
        if (mpSession_ == nullptr || ! mpSession_->active())
        {
            // Bailed before attempting anything -- still release the in-flight marks
            // so a later pass isn't permanently skipped.
            for (auto& m : missing)
                if (mpSession_ != nullptr) mpSession_->releaseStem (m.hash);
            return;
        }

        struct Result { juce::String clipId, hash; bool ok; };
        juce::Array<Result> results;
        for (auto& m : missing)
        {
            const bool got = mpSession_->downloadBlob (m.hash, m.ext, m.dest) && m.dest.existsAsFile();
            results.add ({ m.clipId, m.hash, got });
            mpSession_->releaseStem (m.hash);
        }

        juce::MessageManager::callAsync ([this, results]
        {
            int fetched = 0;
            for (auto& r : results)
            {
                if (r.ok)
                {
                    if (auto* w = dynamic_cast<te::WaveAudioClip*> (findClip (r.clipId)))
                        w->sourceMediaChanged();
                    ++fetched;
                }
            }
            if (fetched > 0)
                emitSnapshotInvalidated();
        });
    }).detach();

    auto* data = new DynamicObject();
    data->setProperty ("status", "started");
    return okResult ("mp_fetch_missing_stems", var (data));
}

} // namespace mosh
