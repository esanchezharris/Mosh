#pragma once

#include <juce_core/juce_core.h>

namespace mosh
{
/**
    Moshi's brain, server side — the native equivalent of the Vite `/api/brain/chat`
    dev proxy. In the packaged app the WebView has no dev server, so this performs
    the LLM chat round-trip in C++: it resolves an OpenAI-compatible provider from
    the ENVIRONMENT (so API keys never reach the WebView / client bundle) and POSTs
    the chat completion.

    Mirrors the dev proxy exactly (ui/vite.config.ts → moshiBrain):
      • providers: deepseek | openai | xai | local, each via <PREFIX>_BASE_URL / _API_KEY
        / _MODEL (`local` defaults its key, so a URL + model are enough)
      • default: MOSHI_BRAIN_PROVIDER if fully configured, else the first complete one
      • request: POST {url}/chat/completions, response_format=json_object, max 800 tokens
      • OpenAI reasoning models (gpt-5/6, o-series) use max_completion_tokens + no temp

    The bridge calls chat() OFF the message thread (it blocks on HTTP) and resolves
    the WebView promise with the returned var.
*/
struct BrainProxy
{
    struct Provider
    {
        juce::String id, label, url, key, model;
        bool isComplete() const { return key.isNotEmpty() && url.isNotEmpty() && model.isNotEmpty(); }
    };

    /** The known providers with their env-resolved fields (regardless of whether they
        are fully configured). Order: deepseek, openai, xai, local — `local` is LAST so
        adding it did not change which provider an existing install auto-defaults to. */
    static juce::Array<Provider> providers();

    /** Pick the provider to use: `requested` if it is complete, else
        MOSHI_BRAIN_PROVIDER if complete, else the first complete provider. Returns a
        Provider with empty fields (isComplete()==false) when none is configured. */
    static Provider resolve (const juce::String& requested = {});

    /** Blocking chat round-trip. `messages` is a JSON array of {role,content}.
        Returns { ok:true, content, provider, model, ms } on success, or
        { ok:false, error } on any failure (no provider / network / upstream). Call
        OFF the message thread.

        Proxy-first: when proxyEnabled(), this POSTs to the server-side brain proxy
        (supabase/functions/brain) instead of calling a provider directly with a
        bundled key. Any proxy failure (unreachable / non-2xx / malformed reply) falls
        through to the direct-provider path below it — additive, never a regression
        from the pre-proxy behaviour (proxyEnabled()==false skips the branch entirely,
        so an unset MOSH_BRAIN_PROXY_URL is byte-identical to before this existed). */
    static juce::var chat (const juce::var& messages, const juce::String& requested = {});

    /** Which providers are configured — { providers:[{id,label,model,configured}],
        default }. Surfaced to the WebView by the `list_brain_providers` binding so the
        in-app picker can offer exactly the seats this install can actually reach. */
    static juce::var providersInfo();

    /** True when MOSH_BRAIN_PROXY_URL is set — the signal to prefer the server-side
        proxy over reading a bundled/env provider key directly. See
        docs/brain-proxy/RUNBOOK.md for the deploy + cutover story. */
    static bool proxyEnabled();

    /** The configured proxy endpoint (the supabase/functions/brain URL). Empty when
        proxyEnabled() is false. */
    static juce::String proxyUrl();

    /** The per-install id sent to the proxy for its daily token-cap bookkeeping
        (migrations/0003_brain_usage.sql) — an opaque bookkeeping key, never a secret.
        Reused from "<session>/identity.json"'s "uuid" field under the same
        ~/Library/Mosh app-data root MoshEngine uses (minted + persisted on first use
        if the file/field is absent). Two test seams: MOSH_BRAIN_INSTALL_ID overrides
        outright (no filesystem I/O at all); MOSH_SELFTEST_SESSION picks the session
        leaf, mirroring MoshEngine's own hermeticity boundary, so a harness run never
        touches the real ~/Library/Mosh/session/identity.json. */
    static juce::String installId();
};

} // namespace mosh
