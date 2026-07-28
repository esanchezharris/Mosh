#include "BrainProxy.h"

namespace mosh
{
using namespace juce;

namespace
{
    // A bundled brain config (key=value lines) read from Contents/Resources/brain.env,
    // used ONLY as a FALLBACK when the OS environment doesn't carry the value. The deploy
    // writes the user's key there so a Finder/Dock launch (which inherits no shell env, so
    // run-mosh.sh's exports are absent) still has a working brain. In dev the file doesn't
    // exist, so behaviour is unchanged (env wins). Loaded once.
    const StringPairArray& bundledBrainConfig()
    {
        static const StringPairArray cfg = []
        {
            StringPairArray m;
           #if JUCE_WINDOWS
            // Flat layout (Windows): brain.env sits directly next to Mosh.exe, written
            // by `run-mosh.ps1 -Package` (mirrors GenerativeJobManager's flat service/
            // lookup + BuildUI.cmake's MOSH_UI_STAGE_DIR APPLE/else fork).
            const auto f = File::getSpecialLocation (File::currentExecutableFile)
                               .getParentDirectory()       // <exe dir>
                               .getChildFile ("brain.env");
           #else
            // macOS bundle layout: Contents/MacOS/Mosh → up to Contents → Resources/brain.env.
            const auto f = File::getSpecialLocation (File::currentExecutableFile)
                               .getParentDirectory()       // Contents/MacOS
                               .getParentDirectory()       // Contents
                               .getChildFile ("Resources")
                               .getChildFile ("brain.env");
           #endif
            if (f.existsAsFile())
            {
                StringArray lines;
                f.readLines (lines);
                for (auto line : lines)
                {
                    line = line.trim();
                    if (line.isEmpty() || line.startsWithChar ('#')) continue;
                    const auto eq = line.indexOfChar ('=');
                    if (eq <= 0) continue;
                    auto v = line.substring (eq + 1).trim();
                    if (v.startsWithChar ('"') && v.endsWithChar ('"') && v.length() >= 2)
                        v = v.substring (1, v.length() - 1);
                    m.set (line.substring (0, eq).trim(), v);
                }
            }
            return m;
        }();
        return cfg;
    }

    String env (const char* name)
    {
        const auto v = SystemStats::getEnvironmentVariable (name, {});
        if (v.isNotEmpty())
            return v;

        const auto ignoreBundled = SystemStats::getEnvironmentVariable ("MOSH_IGNORE_BUNDLED_BRAIN_CONFIG", {});
        if (ignoreBundled == "1" || ignoreBundled.equalsIgnoreCase ("true"))
            return {};

        return bundledBrainConfig().getValue (name, {});
    }

    // OpenAI reasoning models (gpt-5/6, o-series) reject `temperature` and use
    // `max_completion_tokens`. Mirrors the dev proxy's /^(gpt-5|gpt-6|o[0-9])/.
    bool isReasoningModel (const String& model)
    {
        if (model.startsWith ("gpt-5") || model.startsWith ("gpt-6")) return true;
        return model.length() >= 2 && model[0] == 'o' && CharacterFunctions::isDigit (model[1]);
    }

    var makeError (const String& message)
    {
        auto* o = new DynamicObject();
        o->setProperty ("ok", false);
        o->setProperty ("error", message);
        return var (o);
    }

    // ── Brain proxy (supabase/functions/brain) — keeps provider keys off the client ──
    //
    // Sends { messages, provider?, install_id } and expects { ok:true, content } back
    // (or { ok:false, error } on a clean upstream/cap-reached failure). Never sends or
    // receives a provider key. See docs/brain-proxy/RUNBOOK.md for the deploy story.
    var chatViaProxy (const String& proxyUrl, const var& messages, const String& requested)
    {
        auto* payload = new DynamicObject();
        payload->setProperty ("messages", messages);
        if (requested.isNotEmpty())
            payload->setProperty ("provider", requested);
        payload->setProperty ("install_id", BrainProxy::installId());

        StringArray headerLines;
        headerLines.add ("Content-Type: application/json");
        if (const auto apikey = env ("MOSH_BRAIN_PROXY_APIKEY"); apikey.isNotEmpty())
            headerLines.add ("apikey: " + apikey);

        URL url = URL (proxyUrl).withPOSTData (JSON::toString (var (payload)));
        int statusCode = 0;
        auto opts = URL::InputStreamOptions (URL::ParameterHandling::inPostData)
                        .withConnectionTimeoutMs (30000)
                        .withExtraHeaders (headerLines.joinIntoString ("\r\n"))
                        .withStatusCode (&statusCode);

        auto stream = url.createInputStream (opts);
        if (stream == nullptr)
            return makeError ("brain proxy unreachable - " + proxyUrl);

        const auto bodyStr = stream->readEntireStreamAsString();
        const auto j = JSON::parse (bodyStr);

        if (statusCode < 200 || statusCode >= 300 || ! (bool) j.getProperty ("ok", false))
        {
            const auto errVar = j.getProperty ("error", var());
            const auto detail = errVar.isVoid() ? ("upstream HTTP " + String (statusCode))
                                                : JSON::toString (errVar);
            return makeError ("brain proxy error: " + detail);
        }

        // Normalize to the SAME shape the direct-provider path returns so callers
        // (WebBridge's brain_chat, the --brain-smoke CLI) don't need to know which
        // path served the request. The proxy deliberately never discloses which
        // upstream provider it used (see functions/brain/index.ts), so this fills in
        // a fixed "proxy" identity rather than echoing anything from the response.
        auto* o = new DynamicObject();
        o->setProperty ("ok", true);
        o->setProperty ("content", j.getProperty ("content", var()).toString());
        o->setProperty ("provider", "proxy");
        o->setProperty ("label", "MOSH BRAIN PROXY");
        return var (o);
    }
}

Array<BrainProxy::Provider> BrainProxy::providers()
{
    Array<Provider> all;
    all.add ({ "deepseek", "DEEPSEEK", env ("DEEPSEEK_BASE_URL"), env ("DEEPSEEK_API_KEY"), env ("DEEPSEEK_MODEL") });
    all.add ({ "openai",   "OPENAI",   env ("OPENAI_BASE_URL"),   env ("OPENAI_API_KEY"),   env ("OPENAI_MODEL") });
    all.add ({ "xai",      "GROK",     env ("XAI_BASE_URL"),      env ("XAI_API_KEY"),      env ("XAI_MODEL") });
    // The MLX seat: an OpenAI-compatible server on this machine (mlx_lm.server serving a
    // fused local model). Its key is a formality, so default it whenever LOCAL_BASE_URL is
    // set — LOCAL_BASE_URL + LOCAL_MODEL then suffice, exactly as in the Vite dev proxy
    // (ui/vite.config.ts → moshiBrain). Appended LAST so the auto-default order for an
    // install with no LOCAL_* is byte-identical to before this entry existed.
    const auto localUrl = env ("LOCAL_BASE_URL");
    const auto localKey = env ("LOCAL_API_KEY");
    all.add ({ "local", "LOCAL", localUrl,
               localKey.isNotEmpty() ? localKey : (localUrl.isNotEmpty() ? String ("local") : String()),
               env ("LOCAL_MODEL") });
    return all;
}

BrainProxy::Provider BrainProxy::resolve (const String& requested)
{
    const auto all = providers();
    auto find = [&all] (const String& id) -> Provider
    {
        for (const auto& p : all) if (p.id == id) return p;
        return {};
    };

    if (requested.isNotEmpty())
        if (auto p = find (requested); p.isComplete())
            return p;

    if (auto envDefault = env ("MOSHI_BRAIN_PROVIDER"); envDefault.isNotEmpty())
        if (auto p = find (envDefault); p.isComplete())
            return p;

    for (const auto& p : all)
        if (p.isComplete())
            return p;

    return {};
}

bool BrainProxy::proxyEnabled()
{
    return env ("MOSH_BRAIN_PROXY_URL").isNotEmpty();
}

String BrainProxy::proxyUrl()
{
    return env ("MOSH_BRAIN_PROXY_URL");
}

String BrainProxy::installId()
{
    // Test/CI seam: skip the filesystem entirely so hermetic checks never depend on
    // (or mutate) real machine state.
    if (const auto ov = SystemStats::getEnvironmentVariable ("MOSH_BRAIN_INSTALL_ID", {}); ov.isNotEmpty())
        return ov;

    // Same app-data root MoshEngine::MoshEngine uses (src/engine/MoshEngine.cpp):
    // ~/Library/<Mosh>/<leaf>. MOSH_SELFTEST_SESSION mirrors the engine's own leaf
    // override so a harness run resolves to the isolated "session-selftest"-style dir
    // instead of touching the real ~/Library/Mosh/session/identity.json.
    const auto leaf = SystemStats::getEnvironmentVariable ("MOSH_SELFTEST_SESSION", {}).trim();
    const auto identityFile = File::getSpecialLocation (File::userApplicationDataDirectory)
                                   .getChildFile ("Mosh")
                                   .getChildFile (leaf.isNotEmpty() ? leaf : "session")
                                   .getChildFile ("identity.json");

    if (identityFile.existsAsFile())
    {
        const auto uuid = JSON::parse (identityFile.loadFileAsString()).getProperty ("uuid", var()).toString();
        if (uuid.isNotEmpty())
            return uuid;
    }

    // First use on this machine (or the file exists but predates a "uuid" field, e.g.
    // a hand-seeded identity.json): mint one and persist it ONLY if there was no file
    // at all, so we never clobber fields we don't understand on a malformed existing
    // file — worst case that rare situation just re-mints a non-persisted id per call,
    // never worse than not proxying.
    const auto fresh = Uuid().toString();
    if (! identityFile.existsAsFile())
    {
        identityFile.getParentDirectory().createDirectory();
        auto* o = new DynamicObject();
        o->setProperty ("uuid", fresh);
        identityFile.replaceWithText (JSON::toString (var (o)));
    }
    return fresh;
}

var BrainProxy::chat (const var& messages, const String& requested)
{
    if (proxyEnabled())
    {
        auto result = chatViaProxy (proxyUrl(), messages, requested);
        if ((bool) result.getProperty ("ok", false))
            return result;
        // Fall through to the direct-provider path below (dev-only in practice: a
        // production build that relies on the proxy carries no bundled keys, so
        // resolve() below will itself return "no provider configured" — the existing,
        // already-handled degrade path the UI falls back to a mock brain from).
    }

    const auto p = resolve (requested);
    if (! p.isComplete())
        return makeError ("no brain provider configured - set <PROVIDER>_API_KEY / _BASE_URL / _MODEL "
                          "in the environment (deepseek | openai | xai)");

    if (! messages.isArray())
        return makeError ("brain: messages must be an array of {role,content}");

    // Build the OpenAI-compatible chat payload (json_object response, capped tokens).
    auto* payload = new DynamicObject();
    payload->setProperty ("model", p.model);
    payload->setProperty ("messages", messages);
    auto* rf = new DynamicObject();
    rf->setProperty ("type", "json_object");
    payload->setProperty ("response_format", var (rf));
    if (p.id == "openai" && isReasoningModel (p.model))
    {
        payload->setProperty ("max_completion_tokens", 800);
    }
    else
    {
        payload->setProperty ("max_tokens", 800);
        payload->setProperty ("temperature", 0.6);
    }

    const auto headers = "Content-Type: application/json\r\nAuthorization: Bearer " + p.key;
    URL url = URL (p.url + "/chat/completions").withPOSTData (JSON::toString (var (payload)));

    int statusCode = 0;
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inPostData)
                    .withConnectionTimeoutMs (30000)
                    .withExtraHeaders (headers)
                    .withStatusCode (&statusCode);

    const auto t0 = Time::getMillisecondCounter();
    auto stream = url.createInputStream (opts);
    if (stream == nullptr)
        return makeError ("brain request failed - could not reach " + p.url + " (network / provider down)");

    const auto bodyStr = stream->readEntireStreamAsString();
    const auto ms = (int) (Time::getMillisecondCounter() - t0);
    const auto j = JSON::parse (bodyStr);

    if (statusCode < 200 || statusCode >= 300)
    {
        auto errVar = j.getProperty ("error", var());
        const auto detail = errVar.isVoid() ? ("upstream HTTP " + String (statusCode))
                                            : JSON::toString (errVar);
        return makeError ("brain provider error (" + p.label + "): " + detail);
    }

    // Pull choices[0].message.content defensively (var indexing, no exceptions).
    String content;
    if (auto* choices = j.getProperty ("choices", var()).getArray(); choices != nullptr && choices->size() > 0)
    {
        const auto message = (*choices)[0].getProperty ("message", var());
        content = message.getProperty ("content", var()).toString();
    }

    auto* o = new DynamicObject();
    o->setProperty ("ok", true);
    o->setProperty ("content", content);
    o->setProperty ("provider", p.id);
    o->setProperty ("label", p.label);
    o->setProperty ("model", p.model);
    o->setProperty ("ms", ms);
    return var (o);
}

var BrainProxy::providersInfo()
{
    Array<var> arr;
    for (const auto& p : providers())
    {
        auto* o = new DynamicObject();
        o->setProperty ("id", p.id);
        o->setProperty ("label", p.label);
        o->setProperty ("model", p.model);
        o->setProperty ("configured", p.isComplete());
        arr.add (var (o));
    }
    auto* root = new DynamicObject();
    root->setProperty ("providers", arr);
    root->setProperty ("default", resolve().id);
    return var (root);
}

} // namespace mosh
