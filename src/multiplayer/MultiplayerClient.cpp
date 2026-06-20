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
    if (auto* k = std::getenv ("MOSH_RELAY_APIKEY"); k != nullptr)
        apiKey_ = String (k);
}

void MultiplayerClient::setError (const String& e)
{
    const std::lock_guard<std::mutex> lk (m_);
    lastError_ = e;
}

juce::String MultiplayerClient::extraHeaders (bool includeContentType) const
{
    // base_/apiKey_ are immutable after the ctor, so no lock is needed.
    StringArray h;
    if (includeContentType) h.add ("Content-Type: application/json");
    if (apiKey_.isNotEmpty()) h.add ("apikey: " + apiKey_);
    return h.joinIntoString ("\r\n");
}

juce::var MultiplayerClient::httpGet (const String& path)
{
    URL url (base_ + path);
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inAddress)
                    .withConnectionTimeoutMs (5000)
                    .withExtraHeaders (extraHeaders (false));
    if (auto s = url.createInputStream (opts))
        return JSON::parse (s->readEntireStreamAsString());
    setError ("GET " + path + " failed (no relay?)");
    return {};
}

juce::var MultiplayerClient::httpPost (const String& path, const juce::var& body)
{
    URL url = URL (base_ + path).withPOSTData (JSON::toString (body));
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inPostData)
                    .withConnectionTimeoutMs (5000)
                    .withExtraHeaders (extraHeaders (true));
    if (auto s = url.createInputStream (opts))
        return JSON::parse (s->readEntireStreamAsString());
    setError ("POST " + path + " failed (no relay?)");
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
        const std::lock_guard<std::mutex> lk (m_);
        roomCode_ = code;
        haveSeq_ = 0;
        needsResync_ = false;
    }
    else
    {
        setError ("create failed: " + JSON::toString (res));
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
        const std::lock_guard<std::mutex> lk (m_);
        roomCode_ = code;
        haveSeq_ = 0;
        needsResync_ = false;
        return true;
    }
    setError ("join failed: " + JSON::toString (res));
    return false;
}

int MultiplayerClient::publish (const juce::var& msg)
{
    String code;
    { const std::lock_guard<std::mutex> lk (m_); code = roomCode_; }
    if (code.isEmpty())
    {
        setError ("publish: not in a room");
        return -1;
    }
    auto* o = new DynamicObject();
    o->setProperty ("code", code);
    o->setProperty ("peerId", peerId_);
    o->setProperty ("msg", msg);
    auto res = httpPost ("/mp/publish", var (o));

    if (res.hasProperty ("seq"))
        return (int) res.getProperty ("seq", -1);
    setError ("publish failed: " + JSON::toString (res));
    return -1;
}

juce::Array<juce::var> MultiplayerClient::poll()
{
    Array<var> out;
    String code;
    int since = 0;
    { const std::lock_guard<std::mutex> lk (m_); code = roomCode_; since = haveSeq_; }
    if (code.isEmpty())
    {
        setError ("poll: not in a room");
        return out;
    }

    URL url = URL (base_ + "/mp/events")
                  .withParameter ("code", code)
                  .withParameter ("peerId", peerId_)
                  .withParameter ("since", String (since));
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inAddress)
                    .withConnectionTimeoutMs (5000)
                    .withExtraHeaders (extraHeaders (false));

    std::unique_ptr<InputStream> s (url.createInputStream (opts));
    if (s == nullptr)
    {
        setError ("poll failed (no relay?)");
        return out;
    }

    auto res = JSON::parse (s->readEntireStreamAsString());

    // Only a successful events payload carries "latest"; an error/throttle response
    // (404 dead room, 429 rate_limited, anything malformed) does NOT — and createInputStream
    // returns a non-null stream for 4xx on macOS. Treat such a response like the "no relay"
    // branch above: report it but DON'T overwrite lastLocks_/lastPeers_/haveSeq_, so a
    // transient error can't blank the guard's lock mirror or the presence roster.
    if (! res.hasProperty ("latest") || res.hasProperty ("error"))
    {
        setError ("poll: " + JSON::toString (res));
        return out;
    }

    if (auto* arr = res.getProperty ("frames", var()).getArray())
        for (auto& f : *arr)
            out.add (f);

    // Advance the cursor to the room's latest (own frames are excluded by the relay
    // but still bump the global seq, so jumping to latest avoids re-polling them).
    const int latest = (int) res.getProperty ("latest", since);
    {
        const std::lock_guard<std::mutex> lk (m_);
        needsResync_ = (bool) res.getProperty ("resync", false);
        lastLocks_ = res.getProperty ("locks", var());
        lastPeers_ = res.getProperty ("peers", var());
        haveSeq_ = jmax (haveSeq_, latest);
    }
    return out;
}

juce::var MultiplayerClient::tryLock (const String& key, bool steal)
{
    String code;
    { const std::lock_guard<std::mutex> lk (m_); code = roomCode_; }
    if (code.isEmpty())
    {
        setError ("lock: not in a room");
        return {};
    }
    auto* o = new DynamicObject();
    o->setProperty ("code", code);
    o->setProperty ("peerId", peerId_);
    o->setProperty ("key", key);
    o->setProperty ("steal", steal);
    return httpPost ("/mp/lock", var (o));
}

bool MultiplayerClient::releaseLock (const String& key)
{
    String code;
    { const std::lock_guard<std::mutex> lk (m_); code = roomCode_; }
    if (code.isEmpty())
        return false;
    auto* o = new DynamicObject();
    o->setProperty ("code", code);
    o->setProperty ("peerId", peerId_);
    o->setProperty ("key", key);
    return (bool) httpPost ("/mp/unlock", var (o)).getProperty ("released", false);
}

bool MultiplayerClient::uploadBlob (const String& hash, const String& ext, const File& file)
{
    String code;
    { const std::lock_guard<std::mutex> lk (m_); code = roomCode_; }
    if (code.isEmpty() || ! file.existsAsFile())
        return false;

    auto body = [&] { auto* o = new DynamicObject();
        o->setProperty ("code", code); o->setProperty ("peerId", peerId_);
        o->setProperty ("hash", hash); o->setProperty ("ext", ext); return var (o); };

    if ((bool) httpPost ("/mp/blob/head", body()).getProperty ("exists", false))
        return true;   // already on the server (content-addressed dedup)

    const auto putUrl = httpPost ("/mp/blob/put-url", body()).getProperty ("url", var()).toString();
    if (putUrl.isEmpty())
    {
        setError ("no put-url (cloud relay only)");
        return false;
    }

    MemoryBlock mb;
    if (! file.loadFileAsData (mb))
        return false;
    URL u = URL (putUrl).withPOSTData (mb);
    // inAddress (NOT inPostData) so the signed URL's ?token=… stays in the address;
    // the file bytes still go in the body (postData is set). httpRequestCmd -> PUT.
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inAddress)
                    .withConnectionTimeoutMs (60000)
                    .withHttpRequestCmd ("PUT")
                    .withExtraHeaders ("content-type: application/octet-stream");
    if (auto s = u.createInputStream (opts))
    {
        s->readEntireStreamAsString();   // drain the small JSON ack
        return true;
    }
    setError ("blob PUT failed");
    return false;
}

bool MultiplayerClient::downloadBlob (const String& hash, const String& ext, const File& dest)
{
    String code;
    { const std::lock_guard<std::mutex> lk (m_); code = roomCode_; }
    if (code.isEmpty())
        return false;

    auto* o = new DynamicObject();
    o->setProperty ("code", code); o->setProperty ("peerId", peerId_);
    o->setProperty ("hash", hash); o->setProperty ("ext", ext);
    const auto getUrl = httpPost ("/mp/blob/get-url", var (o)).getProperty ("url", var()).toString();
    if (getUrl.isEmpty())
        return false;

    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inAddress).withConnectionTimeoutMs (60000);
    if (auto s = URL (getUrl).createInputStream (opts))
    {
        dest.getParentDirectory().createDirectory();
        dest.deleteFile();
        FileOutputStream os (dest);
        if (os.openedOk())
        {
            os.writeFromInputStream (*s, -1);
            os.flush();
            return dest.existsAsFile() && dest.getSize() > 0;
        }
    }
    setError ("blob GET failed");
    return false;
}

void MultiplayerClient::leave()
{
    String code;
    { const std::lock_guard<std::mutex> lk (m_); code = roomCode_; }
    if (code.isEmpty())
        return;
    auto* o = new DynamicObject();
    o->setProperty ("code", code);
    o->setProperty ("peerId", peerId_);
    httpPost ("/mp/leave", var (o));
    {
        const std::lock_guard<std::mutex> lk (m_);
        roomCode_.clear();
        haveSeq_ = 0;
    }
}

} // namespace mosh
