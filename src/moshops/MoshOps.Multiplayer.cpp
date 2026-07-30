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
#include "engine/SourceRef.h"
#include "multiplayer/LogicalId.h"
#include "multiplayer/TrackCommit.h"
#include <juce_cryptography/juce_cryptography.h>
#include <thread>

namespace mosh
{
using namespace juce;

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
    auto* applyArgs = new DynamicObject();
    applyArgs->setProperty ("blob", msg.getProperty ("blob", var()));
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

    auto res = trackcommit::apply (eng.edit(), blob);
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
    const auto code = mpSession_->createSession (args.getProperty ("name", var()).toString(),
                                                 args.getProperty ("color", var()).toString());
    if (code.isEmpty())
        return errResult ("mp_create_session", "could not reach the relay (MOSH_RELAY_URL)");
    refreshMpStemDir();   // PR-2: defensive re-stamp (also done at construction + project-file changes)
    auto* o = new DynamicObject();
    o->setProperty ("code", code);
    o->setProperty ("selfPeer", mpSession_->selfPeer());
    return okResult ("mp_create_session", var (o));
}

juce::var MoshOps::cmdMpJoinSession (const juce::var& args)
{
    if (! mpSession_->joinSession (args.getProperty ("code", var()).toString(),
                                   args.getProperty ("name", var()).toString(),
                                   args.getProperty ("color", var()).toString()))
        return errResult ("mp_join_session", "join failed (bad code / relay unreachable)");
    refreshMpStemDir();   // PR-2: defensive re-stamp (also done at construction + project-file changes)
    auto* o = new DynamicObject();
    o->setProperty ("selfPeer", mpSession_->selfPeer());
    return okResult ("mp_join_session", var (o));
}

juce::var MoshOps::cmdMpLeaveSession (const juce::var&)
{
    mpSession_->leaveSession();
    return okResult ("mp_leave_session");
}

juce::var MoshOps::cmdMpClaimTrack (const juce::var& args)
{
    auto* t = findTrack (args.getProperty ("trackId", var()).toString());
    if (t == nullptr)
        return errResult ("mp_claim_track", "no track");
    const auto lid = logicalid::ensureTrack (t->state);
    const int epoch = mpSession_->claim (lid);
    auto* o = new DynamicObject();
    o->setProperty ("granted", epoch >= 0);
    o->setProperty ("logicalId", lid);
    return okResult ("mp_claim_track", var (o));
}

juce::var MoshOps::cmdMpCommitTrack (const juce::var& args)
{
    auto* t = findTrack (args.getProperty ("trackId", var()).toString());
    if (t == nullptr)
        return errResult ("mp_commit_track", "no track");

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
    // when single-player, or while applying a peer's op (echo-free).
    if (mpSession_ != nullptr && mpSession_->active() && ! applyingRemote_
        && (bool) result.getProperty ("ok", false))
        mpSession_->broadcastStructural (name, args);
    return result;
}

juce::var MoshOps::cmdMpApplyStructural (const juce::var& args)
{
    // Re-execute a peer's structural op locally: applyingRemote_ bypasses the lock
    // guard (it is incoming history) AND short-circuits broadcastStructuralIfActive
    // (no echo). The inner command's own emit repaints the UI.
    auto* c = new DynamicObject();
    c->setProperty ("command", args.getProperty ("command", var()));
    c->setProperty ("args", args.getProperty ("args", var()));

    applyingRemote_ = true;
    auto r = execute (var (c));
    applyingRemote_ = false;
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

juce::var MoshOps::cmdMpApplyBootstrap (const juce::var& args)
{
    // P6 — adopt a peer's project: drop our local tracks, rebuild from the bundle.
    // nullptr UndoManager + no relay echo (this is incoming history, like a commit).
    auto& edit = eng.edit();
    for (auto* t : te::getAudioTracks (edit))
        if (t != nullptr)
        {
            auto st = t->state;
            st.getParent().removeChild (st, nullptr);
        }

    // PR-2: bundles arriving through the LIVE SESSION path (MultiplayerSession's
    // "bootstrap_state" handling) have already had every stem prefetched by the
    // transfer worker before this is called — stemsPrefetched:true skips the inline
    // download loop below entirely. Direct calls (the harness/agents/`mp_apply_bootstrap`
    // outside a live session) never set this flag, so their own inline download runs
    // exactly as before — the direct-command contract is unchanged.
    const bool stemsPrefetched = (bool) args.getProperty ("stemsPrefetched", false);

    int applied = 0;
    auto byHashDir = eng.editFile().getParentDirectory().getChildFile ("audio").getChildFile ("by-hash");
    if (auto* arr = args.getProperty ("tracks", var()).getArray())
        for (auto& tv : *arr)
        {
            // Fetch any by-hash stems this track references (into audio/by-hash/) BEFORE
            // applying, so its pre-existing wave clips resolve without a host re-commit —
            // the late-join analogue of the commit-apply download. The result is ignored
            // here (a transient failure just leaves the clip sourceMissing) — the
            // self-heal pass below retries anything still missing once the tracks land.
            if (! stemsPrefetched)
                if (auto* refs = tv.getProperty ("audioRefs", var()).getArray())
                    for (auto& a : *refs)
                    {
                        const auto h = a.getProperty ("hash", var()).toString();
                        const auto e = a.getProperty ("ext", var()).toString();
                        if (h.isEmpty()) continue;
                        if (auto dest = byHashDir.getChildFile (h + "." + e); ! dest.existsAsFile())
                            mpSession_->downloadBlob (h, e, dest);
                    }
            const auto blob = tv.getProperty ("blob", var()).toString();
            if (blob.isNotEmpty() && trackcommit::apply (edit, blob).ok)
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

    eng.markDirty();
    emitSnapshotInvalidated();

    // P4 self-heal (PR-1): the download loop above ignores its result, so a transient
    // upload/download failure during THIS bootstrap (or a peer's blob that hadn't
    // finished landing) can leave a just-applied clip sourceMissing. Kick off a retry
    // pass so the guest doesn't need the host to notice and re-commit that track — a
    // no-op (synchronous, effectively free) when nothing is missing.
    cmdMpFetchMissingStems (var (new DynamicObject()));

    auto* d = new DynamicObject();
    d->setProperty ("applied", applied);
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
