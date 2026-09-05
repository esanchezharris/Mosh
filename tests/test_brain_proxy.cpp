#include <catch2/catch_test_macros.hpp>
#include "brain/BrainProxy.h"
#include "engine/SessionPaths.h"
#include <cstdlib>
#include <cmath>

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
        ScopedEnv n { "MOSH_IGNORE_BUNDLED_BRAIN_CONFIG", "1" };   // also skip any stray bundled brain.env
        ScopedEnv o { "OPENROUTER_BASE_URL", "" };
        ScopedEnv p { "OPENROUTER_API_KEY", "" };
        ScopedEnv q { "OPENROUTER_MODEL", "" };
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
    const auto name = "session-brainproxy-catch2-" + Uuid().toString().substring (0, 8);
    ScopedEnv leaf ("MOSH_SELFTEST_SESSION", "_harness/" + name);
    auto dir = File::getSpecialLocation (File::userApplicationDataDirectory)
                   .getChildFile ("Mosh")
                   .getChildFile ("_harness")
                   .getChildFile (name);
    REQUIRE (mosh::sessionpaths::createOwnedHarnessSession (
        File::getSpecialLocation (File::userApplicationDataDirectory).getChildFile ("Mosh"), dir));

    const auto first = BrainProxy::installId();
    CHECK (first.isNotEmpty());
    CHECK (dir.getChildFile ("identity.json").existsAsFile());

    const auto second = BrainProxy::installId();
    CHECK (second == first);   // persisted + reused, not re-minted every call

    CHECK (mosh::sessionpaths::resetOwnedHarnessSession (
        File::getSpecialLocation (File::userApplicationDataDirectory).getChildFile ("Mosh"), dir));
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

TEST_CASE ("BrainProxy local MLX payload disables hidden thinking for interactive latency", "[brain][local]")
{
    const BrainProxy::Provider local { "local", "LOCAL 30B", "http://127.0.0.1:8091/v1", "local", "/models/r5" };
    const auto payload = BrainProxy::requestPayload (local, var (Array<var>{}));
    const auto kwargs = payload.getProperty ("chat_template_kwargs", var());

    REQUIRE (kwargs.isObject());
    CHECK_FALSE ((bool) kwargs.getProperty ("enable_thinking", true));
    CHECK (BrainProxy::requestTimeoutMs (local) == 120000);

    const BrainProxy::Provider cloud { "openai", "OPENAI", "https://example.invalid/v1", "test", "gpt-5" };
    CHECK (BrainProxy::requestTimeoutMs (cloud) == 30000);
}

TEST_CASE ("BrainProxy direct response rejects malformed successful envelopes", "[brain][response]")
{
    const BrainProxy::Provider local { "local", "LOCAL 30B", "http://127.0.0.1:8091/v1", "local", "/models/r5" };

    for (const auto& body : { "not-json", "{}", R"({"choices":[]})", R"({"choices":[{"message":{"content":""}}]})" })
    {
        const auto result = BrainProxy::parseDirectResponse (body, 200, local, 12);
        CHECK_FALSE ((bool) result.getProperty ("ok", true));
        CHECK (result.getProperty ("error", var()).toString().contains ("malformed completion"));
    }

    const auto good = BrainProxy::parseDirectResponse (
        R"({"choices":[{"message":{"content":"{\"p\":[60,62,64,65,64,62,60,57]}"}}]})", 200, local, 12);
    CHECK ((bool) good.getProperty ("ok", false));
    CHECK (good.getProperty ("content", var()).toString().contains ("p"));
}

// ── W1.1 — ChatOptions + the openrouter provider ────────────────────────────────

TEST_CASE ("BrainProxy providers() carries a fourth openrouter provider, appended last", "[brain][providers]")
{
    ScopedCleanBrainEnv clean;
    ScopedEnv url ("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1");
    ScopedEnv key ("OPENROUTER_API_KEY", "sk-or-test");
    ScopedEnv model ("OPENROUTER_MODEL", "anthropic/claude-sonnet-5");

    const auto all = BrainProxy::providers();
    REQUIRE (all.size() == 4);
    CHECK (all[0].id == "deepseek");
    CHECK (all[1].id == "openai");
    CHECK (all[2].id == "xai");
    CHECK (all[3].id == "openrouter");
    CHECK (all[3].isComplete());
    CHECK (all[3].url == "https://openrouter.ai/api/v1");
    CHECK (all[3].model == "anthropic/claude-sonnet-5");

    // Only openrouter is complete -> it's the resolved default.
    CHECK (BrainProxy::resolve().id == "openrouter");

    // Completing deepseek too proves appending openrouter LAST didn't shift the
    // existing first-complete-wins order: deepseek (earlier in `all`) still wins.
    ScopedEnv burl ("DEEPSEEK_BASE_URL", "https://api.deepseek.test");
    ScopedEnv bkey ("DEEPSEEK_API_KEY", "sk-test");
    ScopedEnv bmodel ("DEEPSEEK_MODEL", "deepseek-test");
    CHECK (BrainProxy::resolve().id == "deepseek");

    // An explicit request for openrouter is still honoured over the default.
    CHECK (BrainProxy::resolve ("openrouter").id == "openrouter");
}

TEST_CASE ("BrainProxy requestPayload/requestTimeoutMs default ChatOptions reproduce the exact pre-W1.1 payload", "[brain][options]")
{
    const BrainProxy::Provider p { "deepseek", "DEEPSEEK", "https://api.deepseek.test", "sk-test", "deepseek-test" };
    const auto payload = BrainProxy::requestPayload (p, var (Array<var>{}));   // default opts
    CHECK ((int) payload.getProperty ("max_tokens", 0) == 800);
    CHECK (std::abs ((double) payload.getProperty ("temperature", 0.0) - 0.6) < 1e-9);
    CHECK (payload.getProperty ("max_completion_tokens", var()).isVoid());
    CHECK (BrainProxy::requestTimeoutMs (p) == 30000);   // default opts.timeoutMs==0 -> the cloud split
}

TEST_CASE ("BrainProxy ChatOptions override max_tokens / temperature / timeoutMs", "[brain][options]")
{
    const BrainProxy::Provider p { "deepseek", "DEEPSEEK", "https://api.deepseek.test", "sk-test", "deepseek-test" };
    BrainProxy::ChatOptions opts;
    opts.maxTokens = 8192;
    opts.temperature = 0.9;
    opts.timeoutMs = 180000;

    const auto payload = BrainProxy::requestPayload (p, var (Array<var>{}), opts);
    CHECK ((int) payload.getProperty ("max_tokens", 0) == 8192);
    CHECK (std::abs ((double) payload.getProperty ("temperature", 0.0) - 0.9) < 1e-9);
    CHECK (BrainProxy::requestTimeoutMs (p, opts) == 180000);   // overrides the 30s cloud default outright
}

TEST_CASE ("BrainProxy reasoning-model payload honours ChatOptions.maxTokens via max_completion_tokens", "[brain][options]")
{
    const BrainProxy::Provider p { "openai", "OPENAI", "https://api.openai.test", "sk-test", "gpt-5" };
    BrainProxy::ChatOptions opts;
    opts.maxTokens = 4096;

    const auto payload = BrainProxy::requestPayload (p, var (Array<var>{}), opts);
    CHECK ((int) payload.getProperty ("max_completion_tokens", 0) == 4096);
    CHECK (payload.getProperty ("max_tokens", var()).isVoid());     // reasoning models reject max_tokens...
    CHECK (payload.getProperty ("temperature", var()).isVoid());    // ...and temperature
}

TEST_CASE ("BrainProxy optionsFromVar clamps out-of-range fields and keeps defaults for missing/absent ones", "[brain][options]")
{
    // Every field present, all out of bounds.
    auto* tooHigh = new DynamicObject();
    tooHigh->setProperty ("maxTokens", 999999);
    tooHigh->setProperty ("timeoutMs", 999999999);
    tooHigh->setProperty ("temperature", 9.0);
    const auto highClamped = BrainProxy::optionsFromVar (var (tooHigh));
    CHECK (highClamped.maxTokens == 32768);
    CHECK (highClamped.timeoutMs == 600000);
    CHECK (std::abs (highClamped.temperature - 2.0) < 1e-9);

    auto* tooLow = new DynamicObject();
    tooLow->setProperty ("maxTokens", 0);
    tooLow->setProperty ("timeoutMs", 1);
    tooLow->setProperty ("temperature", -5.0);
    const auto lowClamped = BrainProxy::optionsFromVar (var (tooLow));
    CHECK (lowClamped.maxTokens == 1);
    CHECK (lowClamped.timeoutMs == 1000);
    CHECK (std::abs (lowClamped.temperature - 0.0) < 1e-9);

    // No `options` object at all (the common case — most callers omit it) and an
    // empty object both fall back to the DOSAGE defaults untouched.
    const auto absent = BrainProxy::optionsFromVar (var());
    CHECK (absent.maxTokens == 800);
    CHECK (std::abs (absent.temperature - 0.6) < 1e-9);
    CHECK (absent.timeoutMs == 0);

    const auto empty = BrainProxy::optionsFromVar (var (new DynamicObject()));
    CHECK (empty.maxTokens == 800);
    CHECK (empty.timeoutMs == 0);
}
