#include "MultiplayerSession.h"
#include "AudioRefValidation.h"
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <limits>

namespace mosh
{
using namespace juce;

namespace
{
    // PR-2 kill switch: MOSH_MP_SYNC_TRANSFER=1 reverts every transfer path (commit,
    // received commit/bootstrap_state/structural, the host's bootstrap answer) to the
    // original fully synchronous/inline behaviour — cheap playtest insurance if the
    // async path ever misbehaves live. See docs/MULTIPLAYER.md.
    bool readSyncTransferEnv()
    {
        if (auto* env = std::getenv ("MOSH_MP_SYNC_TRANSFER"); env != nullptr && std::strlen (env) > 0)
            return String (env) != "0";
        return false;
    }
}

MultiplayerSession::MultiplayerSession (ApplyCommitFn applyCommit, EmitFn emit, SyncLocksFn syncLocks,
                                        ProvideBootstrapFn provideBootstrap, ValidateBootstrapFn validateBootstrap,
                                        ApplyBootstrapFn applyBootstrap,
                                        ApplyStructuralFn applyStructural)
    : applyCommit_ (std::move (applyCommit)), emit_ (std::move (emit)), syncLocks_ (std::move (syncLocks)),
      provideBootstrap_ (std::move (provideBootstrap)), validateBootstrap_ (std::move (validateBootstrap)),
      applyBootstrap_ (std::move (applyBootstrap)),
      applyStructural_ (std::move (applyStructural)),
      syncMode_ (readSyncTransferEnv())
{
}

MultiplayerSession::~MultiplayerSession()
{
    stopPoll();
    clearPendingBootstrapRequests();
    // transferQueue_'s own destructor aborts + joins its worker if one is still
    // alive (idempotent with the explicit reset() in leaveSession()).
}

juce::String MultiplayerSession::createSession (const String& name, const String& color)
{
    clearPendingBootstrapRequests();
    const auto code = client_.createSession (name, color);
    if (code.isNotEmpty())
    {
        // PR-2: a fresh worker for this session (a TransferQueue is not restartable
        // after a prior leaveSession()'s abort() — see TransferQueue.h).
        transferQueue_ = std::make_unique<TransferQueue> (
            [] (std::function<void()> f) { MessageManager::callAsync (std::move (f)); });
        startPoll();
    }
    return code;
}

bool MultiplayerSession::joinSession (const String& code, const String& name, const String& color)
{
    clearPendingBootstrapRequests();
    if (! client_.joinSession (code, name, color))
        return false;
    transferQueue_ = std::make_unique<TransferQueue> (
        [] (std::function<void()> f) { MessageManager::callAsync (std::move (f)); });
    startPoll();
    // P6 — ask the host for the full project so a late-joiner starts from their
    // state (the host answers in its poll loop with a bootstrap_state).
    requestBootstrap();
    return true;
}

void MultiplayerSession::leaveSession()
{
    stopPoll();             // no more poll callAsyncs after this (they no-op on !running_)
    transferQueue_.reset(); // PR-2: abort() + join the worker before it's gone for good
    clearPendingBootstrapRequests();
    client_.leave();
    syncLocks_ (false, {}, {});
    auto* o = new DynamicObject();
    o->setProperty ("active", false);
    emit_ ("mp_state", var (o));
}

void MultiplayerSession::requestBootstrap()
{
    const auto requestId = Uuid().toString();
    {
        const std::lock_guard<std::mutex> lock (bootstrapMutex_);
        pendingBootstrapRequests_.clear();
        // Keep legacy acceptance closed until publish() returns the relay sequence
        // that separates retained history from a fresh response.
        pendingBootstrapRequests_.emplace (requestId, std::numeric_limits<int>::max());
    }

    auto* request = new DynamicObject();
    request->setProperty ("type", "bootstrap_request");
    request->setProperty ("requestId", requestId);
    const auto publishSequence = client_.publish (var (request));
    const std::lock_guard<std::mutex> lock (bootstrapMutex_);
    const auto found = pendingBootstrapRequests_.find (requestId);
    if (found == pendingBootstrapRequests_.end())
        return;
    if (publishSequence < 1)
        pendingBootstrapRequests_.erase (found);
    else
    {
        found->second = publishSequence;
    }
}

void MultiplayerSession::clearPendingBootstrapRequests()
{
    const std::lock_guard<std::mutex> lock (bootstrapMutex_);
    pendingBootstrapRequests_.clear();
}

bool MultiplayerSession::acceptBootstrapState (const var& msg, const String& self, int frameSequence)
{
    auto* object = msg.getDynamicObject();
    if (object == nullptr)
        return false;

    const bool hasRequestId = object->hasProperty ("requestId");
    const bool hasTo = object->hasProperty ("to");
    if (hasRequestId != hasTo)
        return false;

    String requestId;
    bool legacy = ! hasRequestId;
    if (! hasRequestId)
    {
        const std::lock_guard<std::mutex> lock (bootstrapMutex_);
        if (pendingBootstrapRequests_.size() == 1)
        {
            const auto& pending = *pendingBootstrapRequests_.begin();
            if (frameSequence > pending.second)
                requestId = pending.first;
        }
    }
    else
    {
        const auto requestIdValue = object->getProperty ("requestId");
        const auto toValue = object->getProperty ("to");
        if (! requestIdValue.isString() || ! toValue.isString())
            return false;
        requestId = requestIdValue.toString();
        if (requestId.isEmpty() || toValue.toString() != self)
            return false;
        const std::lock_guard<std::mutex> lock (bootstrapMutex_);
        if (pendingBootstrapRequests_.find (requestId) == pendingBootstrapRequests_.end())
            requestId.clear();
    }

    if (requestId.isEmpty())
        return false;
    if (validateBootstrap_ && validateBootstrap_ (msg).isNotEmpty())
        return false;

    const std::lock_guard<std::mutex> lock (bootstrapMutex_);
    const auto found = pendingBootstrapRequests_.find (requestId);
    if (found == pendingBootstrapRequests_.end())
        return false;
    if (legacy && (pendingBootstrapRequests_.size() != 1 || frameSequence <= found->second))
        return false;
    pendingBootstrapRequests_.erase (found);
    return true;
}

int MultiplayerSession::claim (const String& logicalId)
{
    auto res = client_.tryLock (logicalId);
    if ((bool) res.getProperty ("granted", false))
    {
        const int epoch = (int) res.getProperty ("epoch", 0);
        heldEpochs_[logicalId] = epoch;
        return epoch;
    }
    return -1;
}

void MultiplayerSession::setStemBaseDir (const String& absoluteDir)
{
    const std::lock_guard<std::mutex> lk (stemBaseDirMutex_);
    stemBaseDir_ = absoluteDir;
}

juce::String MultiplayerSession::stemBaseDir() const
{
    const std::lock_guard<std::mutex> lk (stemBaseDirMutex_);
    return stemBaseDir_;
}

juce::File MultiplayerSession::byHashDirFor (const String& base) const
{
    return File (base).getChildFile ("audio").getChildFile ("by-hash");
}

bool MultiplayerSession::transferAborting() const
{
    return transferQueue_ == nullptr || transferQueue_->isAborting();
}

void MultiplayerSession::emitCommitDone (const String& logicalId, bool ok, const String& error)
{
    auto* o = new DynamicObject();
    o->setProperty ("logicalId", logicalId);
    o->setProperty ("ok", ok);
    if (! ok && error.isNotEmpty())
        o->setProperty ("error", error);
    if (emit_)
        emit_ ("mp_commit_done", var (o));
}

void MultiplayerSession::prefetchAudioRefs (const juce::var& audioRefsArr, const juce::String& baseDir)
{
    // SHOULD-FIX (PR-2 review): `baseDir` is captured by the CALLER at enqueue time
    // (when the job.prefetch closure is built), not re-read here. This runs on the
    // worker thread, potentially long after enqueue if the FIFO has a backlog ahead
    // of it (e.g. a slow upload) -- if stemBaseDir() changed in the meantime (a
    // save_as/new_project/open_project while this job was still queued), reading it
    // fresh here would download this job's stems into the WRONG (new) session's
    // directory instead of the one that was current when the peer's message
    // actually arrived.
    if (baseDir.isEmpty())
        return;   // no session-stamped directory yet (shouldn't happen once a session is live)
    if (! audioref::validate (audioRefsArr).ok())
        return;
    auto byHashDir = byHashDirFor (baseDir);
    if (auto* arr = audioRefsArr.getArray())
        for (auto& a : *arr)
        {
            if (transferAborting())
                return;
            const auto resolved = audioref::resolveContainedDestination (byHashDir, a);
            if (! resolved.ok())
                return;
            const auto h = a.getProperty ("hash", var()).toString();
            const auto e = a.getProperty ("ext", var()).toString();
            const auto dest = resolved.destination;
            if (dest.existsAsFile())
                continue;
            // SHOULD-FIX (PR-2 review): claim the hash before fetching -- the message
            // thread's self-heal pass (MoshOps::cmdMpFetchMissingStems) can be trying
            // to downloadBlob() this SAME hash/dest concurrently (a different OS
            // thread). If someone else already claimed it, skip rather than race a
            // second delete-then-create-then-stream into the same file.
            if (! claimStem (h))
                continue;
            client_.downloadBlob (h, e, dest, [this] { return transferAborting(); });
            releaseStem (h);
        }
}

void MultiplayerSession::routeStateMutatingJob (TransferQueue::Job job)
{
    if (syncMode_ || transferQueue_ == nullptr)
    {
        // Kill-switch / defensive fallback (no live queue, e.g. called outside an
        // active session): run inline, right here, exactly like the pre-PR-2 code.
        if (job.prefetch) job.prefetch();
        if (job.apply)    job.apply();
        return;
    }
    transferQueue_->enqueue (std::move (job));
}

void MultiplayerSession::commit (const String& logicalId, const String& blob, const var& audioRefs,
                                 const juce::Array<juce::File>& stemFiles)
{
    const int epoch = [&]
    {
        const auto it = heldEpochs_.find (logicalId);
        return it != heldEpochs_.end() ? it->second : 0;
    }();
    heldEpochs_.erase (logicalId);   // captured NOW, on the message thread -- heldEpochs_ is not otherwise synchronized

    auto* msg = new DynamicObject();
    msg->setProperty ("type", "commit");
    msg->setProperty ("logicalId", logicalId);
    msg->setProperty ("epoch", epoch);
    msg->setProperty ("blob", blob);
    msg->setProperty ("audioRefs", audioRefs);
    const var msgVar (msg);

    Array<var> refs;
    if (auto* a = audioRefs.getArray())
        refs = *a;

    if (syncMode_ || transferQueue_ == nullptr)
    {
        // Original pre-PR-2 behaviour: upload + publish + release, all inline.
        bool allOk = true;
        for (int i = 0; i < refs.size() && i < stemFiles.size(); ++i)
        {
            const auto h = refs[i].getProperty ("hash", var()).toString();
            const auto e = refs[i].getProperty ("ext", var()).toString();
            if (! client_.uploadBlob (h, e, stemFiles[i]))
                allOk = false;
        }
        const int seq = allOk ? client_.publish (msgVar) : -1;
        client_.releaseLock (logicalId);   // released either way -- a failed upload must not leave the track stuck locked
        emitCommitDone (logicalId, allOk && seq >= 1, allOk ? String() : String ("upload failed"));
        return;
    }

    // Async: the caller (MoshOps::cmdMpCommitTrack) has ALREADY done every bit of
    // synchronous engine work (hash/copy-to-by-hash/repoint/serialize -- an
    // immutable content-addressed snapshot, so further edits during the upload are
    // safe by construction) and returns immediately; only the network round-trip
    // (upload each stem, then publish, then release the lock) runs on the worker.
    auto ok  = std::make_shared<bool> (true);
    auto err = std::make_shared<String>();

    TransferQueue::Job job;
    job.prefetch = [this, logicalId, msgVar, refs, stemFiles, ok, err]
    {
        for (int i = 0; i < refs.size() && i < stemFiles.size(); ++i)
        {
            if (transferAborting())
                { *ok = false; if (err->isEmpty()) *err = "aborted"; break; }
            const auto h = refs[i].getProperty ("hash", var()).toString();
            const auto e = refs[i].getProperty ("ext", var()).toString();
            if (! client_.uploadBlob (h, e, stemFiles[i], [this] { return transferAborting(); }))
                { *ok = false; if (err->isEmpty()) *err = "upload failed"; }
        }
        // PR-2 review: after the (abort-aware) upload loop, bail before the publish +
        // releaseLock round-trips if a leave/teardown fired -- otherwise leaveSession()'s
        // transferQueue_.reset() join() waits on them. Skipping releaseLock on abort is
        // safe: leaveSession() calls client_.leave() straight after, and the relay's
        // /mp/leave releases every lock this peer holds. (Residual: an abort landing
        // *inside* the sub-second publish/releaseLock call still runs to its timeout --
        // bounded, and the same class as the pre-existing client_.leave() call.)
        if (transferAborting())
            { *ok = false; if (err->isEmpty()) *err = "aborted"; return; }
        int seq = -1;
        if (*ok)
            seq = client_.publish (msgVar);
        if (seq < 1)
            { *ok = false; if (err->isEmpty()) *err = "publish failed"; }
        client_.releaseLock (logicalId);   // ALWAYS -- success or failure (design point 3)
    };
    job.apply = [this, logicalId, ok, err]
    {
        // SHOULD-FIX (PR-2 review): pollLoop's own callAsync guards every dispatch
        // with `if (! running_.load()) return;` (a stale tick after leaveSession()
        // is dropped) -- this worker's job.apply closures need the SAME guard. The
        // race: the worker thread can have ALREADY handed this apply to callAsync
        // (queued on the message thread) before leaveSession() runs; leaveSession()
        // sets running_ false and tears down transferQueue_/client_, but that
        // teardown cannot retroactively cancel an apply already sitting in the
        // message thread's queue -- without this guard it would fire AFTER the
        // session is gone and emit a stale mp_commit_done.
        if (! running_.load()) return;
        emitCommitDone (logicalId, *ok, *err);
    };
    transferQueue_->enqueue (std::move (job));
}

bool MultiplayerSession::uploadBlob (const String& hash, const String& ext, const File& file)
{
    return client_.uploadBlob (hash, ext, file);
}

bool MultiplayerSession::downloadBlob (const String& hash, const String& ext, const File& dest)
{
    return client_.downloadBlob (hash, ext, dest);
}

bool MultiplayerSession::claimStem (const String& hash)
{
    const std::lock_guard<std::mutex> lk (inFlightMutex_);
    return inFlightStems_.insert (hash).second;   // true only if newly inserted (claimed)
}

void MultiplayerSession::releaseStem (const String& hash)
{
    const std::lock_guard<std::mutex> lk (inFlightMutex_);
    inFlightStems_.erase (hash);
}

// All four broadcasts below are fire-and-forget (their publish result is ignored), so
// they ENQUEUE rather than block the message thread on HTTP — the poll thread drains
// outbox_ and publishes. presence/selection are "current state", so they COALESCE
// (latest wins) to collapse any backlog during a slow round-trip; structural/webrtc
// are ordered ops, so they go FIFO (every distinct op preserved, in order).

void MultiplayerSession::broadcastSelection (const String& trackId, const String& clipId)
{
    auto* msg = new DynamicObject();
    msg->setProperty ("type", "selection");
    msg->setProperty ("trackId", trackId);
    msg->setProperty ("clipId", clipId);
    outbox_.pushCoalesced ("selection", var (msg));
}

void MultiplayerSession::broadcastPresence (double position, bool playing, bool recording)
{
    auto* msg = new DynamicObject();
    msg->setProperty ("type", "presence");
    msg->setProperty ("position", position);
    msg->setProperty ("playing", playing);
    msg->setProperty ("recording", recording);
    outbox_.pushCoalesced ("presence", var (msg));
}

void MultiplayerSession::broadcastStructural (const String& command, const var& args)
{
    auto* msg = new DynamicObject();
    msg->setProperty ("type", "structural");
    msg->setProperty ("command", command);
    msg->setProperty ("args", args);
    outbox_.pushFifo (var (msg));
}

void MultiplayerSession::sendSignal (const String& toPeer, const var& payload)
{
    auto* msg = new DynamicObject();
    msg->setProperty ("type", "webrtc");
    msg->setProperty ("to", toPeer);     // the relay fans out; the addressed peer filters
    msg->setProperty ("payload", payload);
    outbox_.pushFifo (var (msg));
}

void MultiplayerSession::startPoll()
{
    if (running_.exchange (true))
        return;   // already polling
    pollThread_ = std::thread ([this] { pollLoop(); });
}

void MultiplayerSession::stopPoll()
{
    if (! running_.exchange (false))
        return;
    if (pollThread_.joinable())
        pollThread_.join();
}

void MultiplayerSession::pollLoop()
{
    while (running_.load())
    {
        // Flush the fire-and-forget publishes the message thread queued (presence/
        // selection/structural/webrtc). The blocking HTTP runs HERE, off the message
        // thread — coalesced presence collapses to its latest frame, so even a slow
        // relay sends one frame per tick, never a stale burst.
        for (auto& m : outbox_.drain())
            client_.publish (m);

        auto frames = client_.poll();
        auto locks  = client_.lastLocks();
        auto peers  = client_.lastPeers();
        const auto code = client_.roomCode();
        const auto self = client_.peerId();

        // Reconnect self-heal: if we fell behind the relay's ring (e.g. after being
        // offline), the incremental frames can't catch us up — re-request the full
        // project. poll() has already jumped haveSeq to latest, so this fires once.
        if (running_.load() && client_.needsResync())
            requestBootstrap();

        // Marshal everything to the message thread (engine + WebView live there).
        MessageManager::callAsync ([this, frames, locks, peers, code, self]
        {
            if (! running_.load())
                return;   // a stale tick after leaveSession() — drop it (no re-activation)

            for (auto& f : frames)
            {
                auto msg = f.getProperty ("msg", var());
                const auto type = msg.getProperty ("type", var()).toString();
                if (type == "commit")
                {
                    if (! audioref::validate (msg.getProperty ("audioRefs", var())).ok())
                        continue;
                    // PR-2: prefetch (download any missing stems) on the transfer
                    // worker, THEN apply (the existing applyCommit_ callback) —
                    // routed through the SAME ordered pipeline as bootstrap_state/
                    // structural below, so this commit's apply can never be jumped
                    // by a later-arriving frame's own (possibly prefetch-free, fast)
                    // job.
                    TransferQueue::Job job;
                    // SHOULD-FIX (PR-2 review): capture stemBaseDir() NOW (message
                    // thread, enqueue time), not inside prefetchAudioRefs -- see its
                    // doc comment for why a re-read on the worker thread is wrong.
                    const auto commitBaseDir = stemBaseDir();
                    job.prefetch = [this, msg, commitBaseDir]
                        { prefetchAudioRefs (msg.getProperty ("audioRefs", var()), commitBaseDir); };
                    // SHOULD-FIX (PR-2 review): running_ teardown guard -- see the
                    // commit()/emitCommitDone job.apply's doc comment above.
                    job.apply    = [this, msg] { if (running_.load()) applyCommit_ (msg); };
                    routeStateMutatingJob (std::move (job));
                }
                else if (type == "selection")
                {
                    auto* p = new DynamicObject();
                    p->setProperty ("peerId", f.getProperty ("from", var()));
                    p->setProperty ("trackId", msg.getProperty ("trackId", var()));
                    p->setProperty ("clipId", msg.getProperty ("clipId", var()));
                    emit_ ("peer_selection", var (p));
                }
                else if (type == "presence")
                {
                    const auto from = f.getProperty ("from", var()).toString();
                    if (from != self)
                    {
                        auto* p = new DynamicObject();
                        p->setProperty ("peerId", from);
                        p->setProperty ("position", msg.getProperty ("position", 0.0));
                        p->setProperty ("playing", msg.getProperty ("playing", false));
                        p->setProperty ("recording", msg.getProperty ("recording", false));
                        emit_ ("peer_presence", var (p));
                    }
                }
                else if (type == "bootstrap_request")
                {
                    // A late-joiner wants our project. PR-2: the message-thread part
                    // (provideBootstrap_ -> MoshOps::serializeProjectForBootstrapAnswer)
                    // does the engine-touching content-addressing/serialize and
                    // returns {tracks, annotations, stemFiles[]} WITHOUT uploading;
                    // one worker job then uploads every stem THEN publishes
                    // bootstrap_state (in-job ordering guarantees the guest's
                    // prefetch finds the blobs already on the relay).
                    auto* requestObject = msg.getDynamicObject();
                    const bool hasRequestId = requestObject != nullptr && requestObject->hasProperty ("requestId");
                    if (hasRequestId && (! msg.getProperty ("requestId", var()).isString()
                                         || msg.getProperty ("requestId", var()).toString().isEmpty()))
                        continue;

                    auto answer = provideBootstrap_ ? provideBootstrap_() : var();
                    auto* msgOut = new DynamicObject();
                    msgOut->setProperty ("type", "bootstrap_state");
                    if (hasRequestId)
                    {
                        msgOut->setProperty ("requestId", msg.getProperty ("requestId", var()));
                        msgOut->setProperty ("to", f.getProperty ("from", var()));
                    }
                    msgOut->setProperty ("tracks", answer.getProperty ("tracks", var()));
                    msgOut->setProperty ("annotations", answer.getProperty ("annotations", var()));
                    const var msgOutVar (msgOut);
                    const auto stemFiles = answer.getProperty ("stemFiles", var());

                    TransferQueue::Job job;
                    job.prefetch = [this, msgOutVar, stemFiles]
                    {
                        if (auto* sf = stemFiles.getArray())
                            for (auto& s : *sf)
                            {
                                if (transferAborting())
                                    return;
                                const auto h = s.getProperty ("hash", var()).toString();
                                const auto e = s.getProperty ("ext", var()).toString();
                                const auto p = s.getProperty ("path", var()).toString();
                                if (h.isEmpty() || p.isEmpty())
                                    continue;
                                client_.uploadBlob (h, e, File (p), [this] { return transferAborting(); });
                            }
                        client_.publish (msgOutVar);
                    };
                    // No apply stage -- nothing to apply locally on the host side.
                    routeStateMutatingJob (std::move (job));
                }
                else if (type == "bootstrap_state")
                {
                    if (! acceptBootstrapState (msg, self, (int) f.getProperty ("seq", 0)))
                        continue;
                    TransferQueue::Job job;
                    // SHOULD-FIX (PR-2 review): captured NOW (message thread, enqueue
                    // time) -- see prefetchAudioRefs's doc comment.
                    const auto bootstrapBaseDir = stemBaseDir();
                    job.prefetch = [this, msg, bootstrapBaseDir]
                    {
                        if (auto* tarr = msg.getProperty ("tracks", var()).getArray())
                            for (auto& tv : *tarr)
                            {
                                if (transferAborting())
                                    return;
                                prefetchAudioRefs (tv.getProperty ("audioRefs", var()), bootstrapBaseDir);
                            }
                    };
                    job.apply = [this, msg]
                    {
                        // SHOULD-FIX (PR-2 review): running_ teardown guard -- see the
                        // commit()/emitCommitDone job.apply's doc comment above.
                        if (! running_.load())
                            return;
                        if (! applyBootstrap_)
                            return;
                        // Tell cmdMpApplyBootstrap the worker already prefetched every
                        // stem it could (PR-2) so its own inline per-track download
                        // loop (PR-1) can skip re-attempting them. The direct-command
                        // contract (a raw mp_apply_bootstrap call outside a live
                        // session — the harness/agents) is UNCHANGED: this flag is
                        // only ever set here, on bundles arriving through the session.
                        auto* withFlag = new DynamicObject();
                        withFlag->setProperty ("tracks", msg.getProperty ("tracks", var()));
                        withFlag->setProperty ("annotations", msg.getProperty ("annotations", var()));
                        withFlag->setProperty ("stemsPrefetched", true);
                        withFlag->setProperty ("source", "peer");
                        const auto result = applyBootstrap_ (var (withFlag));
                        if (! (bool) result.getProperty ("ok", false))
                        {
                            auto* diagnostic = new DynamicObject();
                            diagnostic->setProperty ("stage", "apply");
                            diagnostic->setProperty ("reason", "rejected");
                            emit_ ("mp_bootstrap_rejected", var (diagnostic));
                        }
                    };
                    routeStateMutatingJob (std::move (job));
                }
                else if (type == "structural")
                {
                    // No prefetch (nothing to download) -- routed through the SAME
                    // FIFO purely for ordering: a fast tempo change enqueued right
                    // after a slow commit upload must still apply strictly after it.
                    TransferQueue::Job job;
                    // SHOULD-FIX (PR-2 review): running_ teardown guard -- see the
                    // commit()/emitCommitDone job.apply's doc comment above.
                    job.apply = [this, msg] { if (running_.load() && applyStructural_) applyStructural_ (msg); };
                    routeStateMutatingJob (std::move (job));
                }
                else if (type == "webrtc")
                {
                    // Point-to-point video handshake: deliver only the frames addressed to us.
                    if (msg.getProperty ("to", var()).toString() == self)
                    {
                        auto* p = new DynamicObject();
                        p->setProperty ("from", f.getProperty ("from", var()));
                        p->setProperty ("payload", msg.getProperty ("payload", var()));
                        emit_ ("webrtc_signal", var (p));
                    }
                }
            }

            // Feed the relay lock table into the local guard.
            std::map<String, String> lockMap;
            if (auto* lo = locks.getDynamicObject())
                for (auto& kv : lo->getProperties())
                    lockMap[kv.name.toString()] = kv.value.toString();
            syncLocks_ (true, self, lockMap);

            // Push the live session state to the WebView (off-snapshot presence).
            auto* st = new DynamicObject();
            st->setProperty ("active", true);
            st->setProperty ("roomCode", code);
            st->setProperty ("selfPeer", self);
            st->setProperty ("peers", peers);
            st->setProperty ("locks", locks);
            emit_ ("mp_state", var (st));
        });

        // Interruptible ~250 ms cadence so leaveSession() is responsive.
        for (int i = 0; i < 25 && running_.load(); ++i)
            std::this_thread::sleep_for (std::chrono::milliseconds (10));
    }
}

} // namespace mosh
