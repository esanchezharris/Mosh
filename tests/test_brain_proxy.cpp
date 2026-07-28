#include <catch2/catch_test_macros.hpp>
#include "brain/BrainProxy.h"
#include <cstdlib>

// Hermetic coverage for the brain-proxy cutover (docs/brain-proxy/RUNBOOK.md): proxy-URL
// selection, install-id resolution, and the proxy-unreachable -> direct-provider
// fallthrough. NO real network call is ever made — proxy/provider URLs point at ports
// that refuse instantly on loopback (127.0.0.1:1, an unbound/privileged port), so every
// case here resolves fast without depending on external infrastructure.
//
// ScopedEnv mirrors tests/test_generative_jobmanager.cpp's helper exactly (restores the
// prior value, or unsets, on scope exit).

using namespace mosh;
using namespace juce;

namespace
{
    struct ScopedEnv
    {
        const char* key;
        juce::String prev;
        bool had = false;
        ScopedEnv (const char* k, const juce::String& v) : key (k)
        {
            if (auto* p = std::getenv (k)) { prev = p; had = true; }
           #if JUCE_WINDOWS
            _putenv_s (k, v.toRawUTF8());
           #else
            ::setenv (k, v.toRawUTF8(), 1);
           #endif
        }
        ~ScopedEnv()
        {
           #if JUCE_WINDOWS
            _putenv_s (key, had ? prev.toRawUTF8() : "");
           #else
            if (had) ::setenv (key, prev.toRawUTF8(), 1); else ::unsetenv (key);
           #endif
        }
    };

    // Clears/pins every var BrainProxy reads so a test's result never depends on
    // whatever the developer's real shell happens to export (this dev machine has real
    // provider keys configured for actual brain use — see CLAUDE.md's working notes).
    struct ScopedCleanBrainEnv
    {
        ScopedEnv a { "MOSH_BRAIN_PROXY_URL", "" };
        ScopedEnv b { "MOSH_BRAIN_PROXY_APIKEY", "" };
        ScopedEnv c { "MOSH_BRAIN_INSTALL_ID", "" };
        ScopedEnv d { "MOSHI_BRAIN_PROVIDER", "" };
        ScopedEnv e { "DEEPSEEK_BASE_URL", "" };
        ScopedEnv f { "DEEPSEEK_API_KEY", "" };
        ScopedEnv g { "DEEPSEEK_MODEL", "" };
        ScopedEnv h { "OPENAI_BASE_URL", "" };
        ScopedEnv i { "OPENAI_API_KEY", "" };
        ScopedEnv j { "OPENAI_MODEL", "" };
        ScopedEnv k { "XAI_BASE_URL", "" };
        ScopedEnv l { "XAI_API_KEY", "" };
        ScopedEnv m { "XAI_MODEL", "" };
        // The `local` (MLX) seat. Load-bearing for hermeticity, not just completeness:
        // this dev machine serves a local model on 8080 for the agent bench, so leaving
        // LOCAL_* set would make `local` a CONFIGURED provider and flip the
        // "no provider configured" cases below into passes-for-the-wrong-reason.
        ScopedEnv n { "LOCAL_BASE_URL", "" };
        ScopedEnv o { "LOCAL_API_KEY", "" };
        ScopedEnv p { "LOCAL_MODEL", "" };
        ScopedEnv q { "MOSH_IGNORE_BUNDLED_BRAIN_CONFIG", "1" };   // also skip any stray bundled brain.env
    };
}

TEST_CASE ("BrainProxy proxy mode is off by default (byte-identical pre-proxy behaviour)", "[brain][proxy]")
{
    ScopedCleanBrainEnv clean;
    CHECK_FALSE (BrainProxy::proxyEnabled());
    CHECK (BrainProxy::proxyUrl().isEmpty());
}

TEST_CASE ("BrainProxy proxy mode activates on MOSH_BRAIN_PROXY_URL", "[brain][proxy]")
{
    ScopedCleanBrainEnv clean;
    ScopedEnv url ("MOSH_BRAIN_PROXY_URL", "https://example.invalid/functions/v1/brain");
    CHECK (BrainProxy::proxyEnabled());
    CHECK (BrainProxy::proxyUrl() == "https://example.invalid/functions/v1/brain");
}

TEST_CASE ("BrainProxy installId honours the MOSH_BRAIN_INSTALL_ID test override (no filesystem I/O)", "[brain][proxy]")
{
    ScopedCleanBrainEnv clean;
    ScopedEnv id ("MOSH_BRAIN_INSTALL_ID", "test-install-abc123");
    CHECK (BrainProxy::installId() == "test-install-abc123");
}

TEST_CASE ("BrainProxy installId is minted once and reused, isolated from the real session", "[brain][proxy]")
{
    ScopedCleanBrainEnv clean;
    // MOSH_SELFTEST_SESSION mirrors MoshEngine's own hermeticity boundary
    // (src/engine/MoshEngine.cpp) so this never touches ~/Library/Mosh/session/identity.json.
    ScopedEnv leaf ("MOSH_SELFTEST_SESSION", "session-brainproxy-catch2-test");
    auto dir = File::getSpecialLocation (File::userApplicationDataDirectory)
                   .getChildFile ("Mosh")
                   .getChildFile ("session-brainproxy-catch2-test");
    dir.deleteRecursively();   // start clean regardless of a prior interrupted run

    const auto first = BrainProxy::installId();
    CHECK (first.isNotEmpty());
    CHECK (dir.getChildFile ("identity.json").existsAsFile());

    const auto second = BrainProxy::installId();
    CHECK (second == first);   // persisted + reused, not re-minted every call

    dir.deleteRecursively();   // leave no trace
}

TEST_CASE ("BrainProxy falls through to the direct-provider path when the proxy is unreachable", "[brain][proxy]")
{
    ScopedCleanBrainEnv clean;
    // Port 1 is privileged/unbound -> refuses instantly on loopback. No real network.
    ScopedEnv proxy ("MOSH_BRAIN_PROXY_URL", "http://127.0.0.1:1/brain");
    ScopedEnv id ("MOSH_BRAIN_INSTALL_ID", "test-install-fallthrough");

    // No provider configured either, so the fallthrough direct-provider path ALSO
    // fails — but with the provider-path's error message, proving the proxy branch
    // really fell through rather than the whole call short-circuiting on its own error.
    auto r = BrainProxy::chat (var (Array<var>{}), String());
    CHECK_FALSE ((bool) r.getProperty ("ok", true));
    CHECK (r.getProperty ("error", var()).toString().contains ("no brain provider configured"));
}

TEST_CASE ("BrainProxy falls through to a configured provider when the proxy is unreachable", "[brain][proxy]")
{
    ScopedCleanBrainEnv clean;
    ScopedEnv proxy ("MOSH_BRAIN_PROXY_URL", "http://127.0.0.1:1/brain");
    ScopedEnv id ("MOSH_BRAIN_INSTALL_ID", "test-install-fallthrough-2");
    // A "complete" deepseek provider pointed at another dead port — resolve() succeeds
    // (proving fallthrough reached the direct-provider path), but the HTTP call itself
    // also fails fast (still no real network), landing on the PROVIDER error shape.
    ScopedEnv burl ("DEEPSEEK_BASE_URL", "http://127.0.0.1:2");
    ScopedEnv bkey ("DEEPSEEK_API_KEY", "sk-test");
    ScopedEnv bmodel ("DEEPSEEK_MODEL", "deepseek-test");

    CHECK (BrainProxy::resolve().id == "deepseek");   // sanity: the fallthrough target is reachable-by-config

    auto r = BrainProxy::chat (var (Array<var>{}), String());
    CHECK_FALSE ((bool) r.getProperty ("ok", true));
    const auto err = r.getProperty ("error", var()).toString();
    CHECK (err.contains ("brain request failed"));   // the direct-provider path's own error shape
}

TEST_CASE ("BrainProxy default path (proxy unset) is unchanged: no provider configured", "[brain][proxy]")
{
    ScopedCleanBrainEnv clean;
    CHECK_FALSE (BrainProxy::resolve().isComplete());
    auto r = BrainProxy::chat (var (Array<var>{}), String());
    CHECK_FALSE ((bool) r.getProperty ("ok", true));
    CHECK (r.getProperty ("error", var()).toString().contains ("no brain provider configured"));
}

// ── The `local` (MLX) seat + the picker's provider list ──────────────────────────
// Added with the in-app brain picker. The seat exists so a model served on THIS machine
// (mlx_lm.server) is selectable from the packaged app, not only from the Vite dev proxy.

TEST_CASE ("BrainProxy local seat needs no API key — URL + model are enough", "[brain][provider]")
{
    ScopedCleanBrainEnv clean;
    // Deliberately NO LOCAL_API_KEY: a loopback server has nothing to authenticate, so
    // requiring one would make the seat unusable exactly where it is meant to be used.
    ScopedEnv url ("LOCAL_BASE_URL", "http://127.0.0.1:8080/v1");
    ScopedEnv model ("LOCAL_MODEL", "some-fused-local-model");

    const auto p = BrainProxy::resolve ("local");
    CHECK (p.id == "local");
    CHECK (p.isComplete());        // the defaulted key is what makes this true
    CHECK (p.key.isNotEmpty());
}

TEST_CASE ("BrainProxy local seat stays absent when LOCAL_BASE_URL is unset", "[brain][provider]")
{
    ScopedCleanBrainEnv clean;
    // The key must NOT be defaulted into existence on its own — otherwise every install
    // would carry a half-configured "local" entry that the picker would then offer.
    ScopedEnv model ("LOCAL_MODEL", "some-fused-local-model");

    bool sawLocal = false;
    for (const auto& p : BrainProxy::providers())
        if (p.id == "local") { sawLocal = true; CHECK_FALSE (p.isComplete()); CHECK (p.key.isEmpty()); }
    CHECK (sawLocal);              // present in the list, just not usable
}

TEST_CASE ("BrainProxy adding the local seat did not change the auto-default", "[brain][provider]")
{
    ScopedCleanBrainEnv clean;
    // The additive claim, pinned: with a cloud seat AND a local seat both complete and no
    // explicit preference, resolve() must still pick the cloud one — `local` is appended
    // LAST, so an existing install's default is untouched by this entry's existence.
    ScopedEnv burl ("DEEPSEEK_BASE_URL", "http://127.0.0.1:2");
    ScopedEnv bkey ("DEEPSEEK_API_KEY", "sk-test");
    ScopedEnv bmodel ("DEEPSEEK_MODEL", "deepseek-test");
    ScopedEnv lurl ("LOCAL_BASE_URL", "http://127.0.0.1:8080/v1");
    ScopedEnv lmodel ("LOCAL_MODEL", "some-fused-local-model");

    CHECK (BrainProxy::resolve().id == "deepseek");
    CHECK (BrainProxy::resolve ("local").id == "local");   // ...but an explicit pick still wins
}

TEST_CASE ("BrainProxy providersInfo reports reachability and leaks no key", "[brain][provider]")
{
    ScopedCleanBrainEnv clean;
    ScopedEnv burl ("OPENAI_BASE_URL", "http://127.0.0.1:2");
    ScopedEnv bkey ("OPENAI_API_KEY", "sk-secret-not-for-the-webview");
    ScopedEnv bmodel ("OPENAI_MODEL", "some-model");

    const auto info = BrainProxy::providersInfo();
    const auto listVar = info.getProperty ("providers", var());
    auto* list = listVar.getArray();          // bind first: a var temporary would die here
    REQUIRE (list != nullptr);

    bool sawConfiguredOpenAI = false, sawUnconfigured = false;
    for (const auto& e : *list)
    {
        const bool configured = (bool) e.getProperty ("configured", false);
        if (e.getProperty ("id", var()).toString() == "openai") { CHECK (configured); sawConfiguredOpenAI = true; }
        else if (! configured) sawUnconfigured = true;
    }
    CHECK (sawConfiguredOpenAI);
    CHECK (sawUnconfigured);                  // the picker can tell reachable from not

    // The whole point of resolving keys natively: the payload the WebView receives
    // carries ids/labels/models only. If this ever fails, a key is on its way to the UI.
    CHECK_FALSE (JSON::toString (info).contains ("sk-secret-not-for-the-webview"));
    CHECK (info.getProperty ("default", var()).toString() == "openai");
}
