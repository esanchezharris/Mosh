#include "MultiplayerSession.h"
#include <chrono>

namespace mosh
{
using namespace juce;

MultiplayerSession::MultiplayerSession (ApplyCommitFn applyCommit, EmitFn emit, SyncLocksFn syncLocks,
                                        ProvideBootstrapFn provideBootstrap, ApplyBootstrapFn applyBootstrap,
                                        ApplyStructuralFn applyStructural)
    : applyCommit_ (std::move (applyCommit)), emit_ (std::move (emit)), syncLocks_ (std::move (syncLocks)),
      provideBootstrap_ (std::move (provideBootstrap)), applyBootstrap_ (std::move (applyBootstrap)),
      applyStructural_ (std::move (applyStructural))
{
}

MultiplayerSession::~MultiplayerSession()
{
    stopPoll();
}

juce::String MultiplayerSession::createSession (const String& name, const String& color)
{
    const auto code = client_.createSession (name, color);
    if (code.isNotEmpty())
        startPoll();
    return code;
}

bool MultiplayerSession::joinSession (const String& code, const String& name, const String& color)
{
    if (! client_.joinSession (code, name, color))
        return false;
    startPoll();
    // P6 — ask the host for the full project so a late-joiner starts from their
    // state (the host answers in its poll loop with a bootstrap_state).
    auto* req = new DynamicObject();
    req->setProperty ("type", "bootstrap_request");
    client_.publish (var (req));
    return true;
}

void MultiplayerSession::leaveSession()
{
    stopPoll();             // no more poll callAsyncs after this (they no-op on !running_)
    client_.leave();
    syncLocks_ (false, {}, {});
    auto* o = new DynamicObject();
    o->setProperty ("active", false);
    emit_ ("mp_state", var (o));
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

void MultiplayerSession::commit (const String& logicalId, const String& blob)
{
    auto* msg = new DynamicObject();
    msg->setProperty ("type", "commit");
    msg->setProperty ("logicalId", logicalId);
    const auto it = heldEpochs_.find (logicalId);
    msg->setProperty ("epoch", it != heldEpochs_.end() ? it->second : 0);
    msg->setProperty ("blob", blob);
    client_.publish (var (msg));
    client_.releaseLock (logicalId);
    heldEpochs_.erase (logicalId);
}

void MultiplayerSession::broadcastSelection (const String& trackId, const String& clipId)
{
    auto* msg = new DynamicObject();
    msg->setProperty ("type", "selection");
    msg->setProperty ("trackId", trackId);
    msg->setProperty ("clipId", clipId);
    client_.publish (var (msg));
}

void MultiplayerSession::broadcastStructural (const String& command, const var& args)
{
    auto* msg = new DynamicObject();
    msg->setProperty ("type", "structural");
    msg->setProperty ("command", command);
    msg->setProperty ("args", args);
    client_.publish (var (msg));
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
        auto frames = client_.poll();
        auto locks  = client_.lastLocks();
        auto peers  = client_.lastPeers();
        const auto code = client_.roomCode();
        const auto self = client_.peerId();

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
                    applyCommit_ (msg.getProperty ("blob", var()).toString());
                }
                else if (type == "selection")
                {
                    auto* p = new DynamicObject();
                    p->setProperty ("peerId", f.getProperty ("from", var()));
                    p->setProperty ("trackId", msg.getProperty ("trackId", var()));
                    p->setProperty ("clipId", msg.getProperty ("clipId", var()));
                    emit_ ("peer_selection", var (p));
                }
                else if (type == "bootstrap_request")
                {
                    // A late-joiner wants our project: serialize it + reply. (One-time,
                    // small JSON; the brief publish on the message thread is fine.)
                    auto bundle = provideBootstrap_ ? provideBootstrap_() : var();
                    auto* msgOut = new DynamicObject();
                    msgOut->setProperty ("type", "bootstrap_state");
                    msgOut->setProperty ("tracks", bundle.getProperty ("tracks", var()));
                    client_.publish (var (msgOut));
                }
                else if (type == "bootstrap_state")
                {
                    if (applyBootstrap_)
                        applyBootstrap_ (msg);   // adopt the host's project
                }
                else if (type == "structural")
                {
                    if (applyStructural_)
                        applyStructural_ (msg);  // mirror a peer's tempo/master/key op
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
