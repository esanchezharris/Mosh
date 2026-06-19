#include "MultiplayerClient.h"

namespace mosh
{
using namespace juce;

namespace
{
    String defaultRelayUrl()
    {
        if (auto* env = std::getenv ("MOSH_RELAY_URL"); env != nullptr && std::strlen (env) > 0)
            return String (env);
        return "http://127.0.0.1:8771";
    }
}

MultiplayerClient::MultiplayerClient (const String& relayBaseUrl)
    : base_ (relayBaseUrl.isNotEmpty() ? relayBaseUrl : defaultRelayUrl()),
      peerId_ (Uuid().toString())
{
    // Strip a trailing slash so base_ + "/mp/..." never doubles up.
    if (base_.endsWithChar ('/'))
        base_ = base_.dropLastCharacters (1);
}

juce::var MultiplayerClient::httpGet (const String& path)
{
    URL url (base_ + path);
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inAddress)
                    .withConnectionTimeoutMs (5000);
    if (auto s = url.createInputStream (opts))
        return JSON::parse (s->readEntireStreamAsString());
    lastError_ = "GET " + path + " failed (no relay?)";
    return {};
}

juce::var MultiplayerClient::httpPost (const String& path, const juce::var& body)
{
    URL url = URL (base_ + path).withPOSTData (JSON::toString (body));
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inPostData)
                    .withConnectionTimeoutMs (5000)
                    .withExtraHeaders ("Content-Type: application/json");
    if (auto s = url.createInputStream (opts))
        return JSON::parse (s->readEntireStreamAsString());
    lastError_ = "POST " + path + " failed (no relay?)";
    return {};
}

juce::String MultiplayerClient::createSession (const String& name, const String& color)
{
    auto* o = new DynamicObject();
    o->setProperty ("peerId", peerId_);
    o->setProperty ("name", name);
    o->setProperty ("color", color);
    auto res = httpPost ("/mp/create", var (o));

    const auto code = res.getProperty ("code", var()).toString();
    if (code.isNotEmpty())
    {
        roomCode_ = code;
        haveSeq_ = 0;
        needsResync_ = false;
    }
    else
    {
        lastError_ = "create failed: " + JSON::toString (res);
    }
    return code;
}

bool MultiplayerClient::joinSession (const String& code, const String& name, const String& color)
{
    auto* o = new DynamicObject();
    o->setProperty ("code", code);
    o->setProperty ("peerId", peerId_);
    o->setProperty ("name", name);
    o->setProperty ("color", color);
    auto res = httpPost ("/mp/join", var (o));

    if ((bool) res.getProperty ("ok", false))
    {
        roomCode_ = code;
        haveSeq_ = 0;
        needsResync_ = false;
        return true;
    }
    lastError_ = "join failed: " + JSON::toString (res);
    return false;
}

int MultiplayerClient::publish (const juce::var& msg)
{
    if (roomCode_.isEmpty())
    {
        lastError_ = "publish: not in a room";
        return -1;
    }
    auto* o = new DynamicObject();
    o->setProperty ("code", roomCode_);
    o->setProperty ("peerId", peerId_);
    o->setProperty ("msg", msg);
    auto res = httpPost ("/mp/publish", var (o));

    if (res.hasProperty ("seq"))
        return (int) res.getProperty ("seq", -1);
    lastError_ = "publish failed: " + JSON::toString (res);
    return -1;
}

juce::Array<juce::var> MultiplayerClient::poll()
{
    Array<var> out;
    if (roomCode_.isEmpty())
    {
        lastError_ = "poll: not in a room";
        return out;
    }

    URL url = URL (base_ + "/mp/events")
                  .withParameter ("code", roomCode_)
                  .withParameter ("peerId", peerId_)
                  .withParameter ("since", String (haveSeq_));
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inAddress)
                    .withConnectionTimeoutMs (5000);

    std::unique_ptr<InputStream> s (url.createInputStream (opts));
    if (s == nullptr)
    {
        lastError_ = "poll failed (no relay?)";
        return out;
    }

    auto res = JSON::parse (s->readEntireStreamAsString());
    needsResync_ = (bool) res.getProperty ("resync", false);

    if (auto* arr = res.getProperty ("frames", var()).getArray())
        for (auto& f : *arr)
            out.add (f);

    // Advance the cursor to the room's latest (own frames are excluded by the relay
    // but still bump the global seq, so jumping to latest avoids re-polling them).
    const int latest = (int) res.getProperty ("latest", haveSeq_);
    haveSeq_ = jmax (haveSeq_, latest);
    return out;
}

void MultiplayerClient::leave()
{
    if (roomCode_.isEmpty())
        return;
    auto* o = new DynamicObject();
    o->setProperty ("code", roomCode_);
    o->setProperty ("peerId", peerId_);
    httpPost ("/mp/leave", var (o));
    roomCode_.clear();
    haveSeq_ = 0;
}

} // namespace mosh
