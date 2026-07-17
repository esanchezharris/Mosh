#include "MultiplayerClient.h"
#include <juce_cryptography/juce_cryptography.h>

namespace mosh
{
using namespace juce;

namespace
{
    // The live cloud relay (Supabase Edge Function) is the BUILT-IN default so a
    // double-clicked Mosh.app reaches multiplayer with zero setup. Point at a local
    // self-host relay instead with:  MOSH_RELAY_URL=http://127.0.0.1:8771
    constexpr const char* kCloudRelayUrl = "https://tpvkqaqydafpgockzchm.supabase.co/functions/v1/relay";
    // Supabase anon (publishable) key — safe to embed: it is a CLIENT key. The room
    // code (a ~128-bit bearer), deny-all RLS on the mp.* tables, and service-role-only
    // RPCs are the real auth boundary, not this key. Override with MOSH_RELAY_APIKEY.
    constexpr const char* kCloudRelayApiKey =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRwdmtxYXF5ZGFmcGdvY2t6Y2htIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2OTIzNDcsImV4cCI6MjA5NDI2ODM0N30.AD_DZddse2ozoGx3yhzAp8ivE7d6JgFdRUs3aB97wuo";

    String defaultRelayUrl()
    {
        if (auto* env = std::getenv ("MOSH_RELAY_URL"); env != nullptr && std::strlen (env) > 0)
            return String (env);
        return kCloudRelayUrl;
    }
}

MultiplayerClient::MultiplayerClient (const String& relayBaseUrl)
    : base_ (relayBaseUrl.isNotEmpty() ? relayBaseUrl : defaultRelayUrl()),
      peerId_ (Uuid().toString())
{
    // Strip a trailing slash so base_ + "/mp/..." never doubles up.
    if (base_.endsWithChar ('/'))
        base_ = base_.dropLastCharacters (1);
    if (auto* k = std::getenv ("MOSH_RELAY_APIKEY"); k != nullptr && std::strlen (k) > 0)
        apiKey_ = String (k);
    else
        apiKey_ = String (kCloudRelayApiKey);   // bake the cloud key so a Dock launch authenticates
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

juce::var MultiplayerClient::httpPost (const String& path, const juce::var& body, int* outStatus)
{
    URL url = URL (base_ + path).withPOSTData (JSON::toString (body));
    int statusCode = 0;
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inPostData)
                    .withConnectionTimeoutMs (5000)
                    .withExtraHeaders (extraHeaders (true))
                    .withStatusCode (&statusCode);
    if (auto s = url.createInputStream (opts))
    {
        if (outStatus != nullptr) *outStatus = statusCode;
        return JSON::parse (s->readEntireStreamAsString());
    }
    if (outStatus != nullptr) *outStatus = 0;
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

bool MultiplayerClient::uploadBlob (const String& hash, const String& ext, const File& file,
                                    std::function<bool()> shouldAbort)
{
    String code;
    { const std::lock_guard<std::mutex> lk (m_); code = roomCode_; }
    if (code.isEmpty() || ! file.existsAsFile())
        return false;
    if (shouldAbort && shouldAbort())
        { setError ("upload aborted"); return false; }

    auto body = [&] { auto* o = new DynamicObject();
        o->setProperty ("code", code); o->setProperty ("peerId", peerId_);
        o->setProperty ("hash", hash); o->setProperty ("ext", ext); return var (o); };

    // Adversarial-review BLOCKER (PR-2 review): every step below now checks the
    // HTTP status explicitly rather than trusting "did I get a response object
    // with the field I expected" — a 4xx/5xx JSON error body can coincidentally
    // lack the field (falling through as if it were a legitimate "not found"/
    // "no url"), and createInputStream() itself returns non-null for 4xx/5xx on
    // macOS regardless. See httpPost's outStatus doc comment.
    int headStatus = 0;
    const auto headRes = httpPost ("/mp/blob/head", body(), &headStatus);
    if (headStatus / 100 == 2 && (bool) headRes.getProperty ("exists", false))
        return true;   // already on the server (content-addressed dedup)
    if (shouldAbort && shouldAbort())
        { setError ("upload aborted"); return false; }

    int putUrlStatus = 0;
    const auto putUrlRes = httpPost ("/mp/blob/put-url", body(), &putUrlStatus);
    if (putUrlStatus / 100 != 2)
    {
        setError ("blob put-url failed (HTTP " + String (putUrlStatus) + ")");
        return false;
    }
    const auto putUrl = putUrlRes.getProperty ("url", var()).toString();
    if (putUrl.isEmpty())
    {
        setError ("no put-url (cloud relay only)");
        return false;
    }
    if (shouldAbort && shouldAbort())
        { setError ("upload aborted"); return false; }

    MemoryBlock mb;
    if (! file.loadFileAsData (mb))
        return false;
    URL u = URL (putUrl).withPOSTData (mb);
    // inAddress (NOT inPostData) so the signed URL's ?token=… stays in the address;
    // the file bytes still go in the body (postData is set). httpRequestCmd -> PUT.
    // withProgressCallback (PR-2): JUCE calls this during the POST/PUT body send
    // (WebInputStream::postDataSendProgress); returning false there aborts the
    // in-flight request instead of only checking between the coarse steps above.
    int putStatus = 0;
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inAddress)
                    .withConnectionTimeoutMs (60000)
                    .withHttpRequestCmd ("PUT")
                    .withExtraHeaders ("content-type: application/octet-stream")
                    .withProgressCallback ([shouldAbort] (int, int) { return ! (shouldAbort && shouldAbort()); })
                    .withStatusCode (&putStatus);
    if (auto s = u.createInputStream (opts))
    {
        const auto ack = s->readEntireStreamAsString();   // drain the (small) JSON body
        // BLOCKER fix: createInputStream() returns a non-null stream for 4xx/5xx on
        // macOS (only a total connection failure is null — same caveat poll() already
        // documents) — a rejected upload (quota/auth/a transient 5xx) must NOT be
        // reported as success just because a stream came back.
        if (putStatus / 100 == 2)
            return true;
        setError ("blob PUT rejected (HTTP " + String (putStatus) + "): " + ack);
        return false;
    }
    setError ("blob PUT failed (no connection)");
    return false;
}

bool MultiplayerClient::downloadBlob (const String& hash, const String& ext, const File& dest,
                                      std::function<bool()> shouldAbort)
{
    String code;
    { const std::lock_guard<std::mutex> lk (m_); code = roomCode_; }
    if (code.isEmpty())
        return false;
    if (shouldAbort && shouldAbort())
        { setError ("download aborted"); return false; }

    auto* o = new DynamicObject();
    o->setProperty ("code", code); o->setProperty ("peerId", peerId_);
    o->setProperty ("hash", hash); o->setProperty ("ext", ext);
    int getUrlStatus = 0;
    const auto getUrlRes = httpPost ("/mp/blob/get-url", var (o), &getUrlStatus);
    if (getUrlStatus / 100 != 2)
    {
        setError ("blob get-url failed (HTTP " + String (getUrlStatus) + ")");
        return false;
    }
    const auto getUrl = getUrlRes.getProperty ("url", var()).toString();
    if (getUrl.isEmpty())
        return false;
    if (shouldAbort && shouldAbort())
        { setError ("download aborted"); return false; }

    int getStatus = 0;
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inAddress)
                    .withConnectionTimeoutMs (60000)
                    .withStatusCode (&getStatus);
    if (auto s = URL (getUrl).createInputStream (opts))
    {
        // Belt-and-suspenders alongside the SHA-256 verify below: a rejected raw GET
        // (4xx/5xx) is caught HERE directly instead of relying on the downloaded
        // bytes (an error page body) happening to fail the hash check further down.
        if (getStatus != 0 && getStatus / 100 != 2)
        {
            setError ("blob GET rejected (HTTP " + String (getStatus) + ")");
            return false;
        }
        dest.getParentDirectory().createDirectory();
        dest.deleteFile();
        FileOutputStream os (dest);
        if (os.openedOk())
        {
            // PR-2: chunked read-then-write (was one blocking writeFromInputStream(*s,-1))
            // so an abort mid-transfer is possible between chunks — a large stem no
            // longer has to run to completion once the caller has given up on it.
            constexpr int kChunkBytes = 65536;
            juce::HeapBlock<char> buf ((size_t) kChunkBytes);
            for (;;)
            {
                if (shouldAbort && shouldAbort())
                {
                    os.flush();
                    dest.deleteFile();   // never leave a truncated stem on disk
                    setError ("download aborted");
                    return false;
                }
                const int n = s->read (buf, kChunkBytes);
                if (n <= 0)
                    break;
                if (! os.write (buf, (size_t) n))
                {
                    setError ("blob GET write failed");
                    return false;
                }
            }
            os.flush();
            if (! (dest.existsAsFile() && dest.getSize() > 0))
            {
                setError ("blob GET produced no bytes");
                return false;
            }

            // Integrity check (adversarial-review finding): this transfer is
            // content-addressed -- `hash` IS the SHA-256 the caller already expects,
            // so verify the bytes that actually landed before ever calling this a
            // successful fetch. Without this, a dropped/truncated GET (the exact
            // transient failure self-heal exists to recover from) would pass the bare
            // exists+size>0 check, get marked resolved by the caller (sourceMediaChanged),
            // and then the resolver's OWN "already exists -> skip" gate would PERMANENTLY
            // exempt the corrupt file from ever being retried: silent garbage audio with
            // sourceMissing:false, worse than the pre-fix "still missing" state. On a
            // mismatch: delete the bad file and report failure so the clip is left
            // genuinely missing for a future retry, never blessed as resolved.
            juce::FileInputStream verify (dest);
            if (! verify.openedOk() || ! hash.equalsIgnoreCase (juce::SHA256 (verify).toHexString()))
            {
                dest.deleteFile();
                setError ("blob GET hash mismatch (corrupt/truncated download)");
                return false;
            }
            return true;
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
