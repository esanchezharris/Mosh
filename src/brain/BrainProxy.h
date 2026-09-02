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
      • providers: deepseek | openai | xai, each via <PREFIX>_BASE_URL / _API_KEY / _MODEL
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

    /** Per-call overrides for a chat request, layered on top of the DOSAGE defaults
        (max_tokens 800 / temperature 0.6 / provider-default timeout). Default-
        constructed ChatOptions is BYTE-IDENTICAL to the pre-W1.1 hardcoded payload —
        every existing caller that doesn't pass options keeps producing the exact same
        wire request. timeoutMs==0 is the sentinel for "use requestTimeoutMs's existing
        local/cloud split"; a positive value (after optionsFromVar's clamp) overrides it —
        the produce lane needs this to raise the ~30s JUCE-side wait so an 8k-token
        completion isn't cut off mid-flight. */
    struct ChatOptions
    {
        int maxTokens = 800;
        double temperature = 0.6;
        int timeoutMs = 0;
    };

    /** Parses a `{maxTokens?, temperature?, timeoutMs?}` var (the shape bridge.ts's
        BrainChatOptions sends as brain_chat's `options` argument) into a clamped
        ChatOptions: maxTokens 1..32768, timeoutMs 1000..600000, temperature 0..2.
        A void/non-object `options` (the common case — most callers omit it) or a
        missing field yields the corresponding ChatOptions default untouched. */
    static ChatOptions optionsFromVar (const juce::var& options);

    /** The known providers with their env-resolved fields (regardless of whether
        they are fully configured). Order: deepseek, openai, xai, openrouter — plus a
        machine-local "local" entry FIRST when configureLocal() has been called.
        openrouter is appended LAST so it can never shift resolve()'s first-complete
        default away from an already-configured deepseek/openai/xai. */
    static juce::Array<Provider> providers();

    /** Pick the provider to use: `requested` if it is complete, else
        MOSHI_BRAIN_PROVIDER if complete, else the first complete provider. Returns a
        Provider with empty fields (isComplete()==false) when none is configured. */
    static Provider resolve (const juce::String& requested = {});

    /** Build the direct OpenAI-compatible request body for a resolved provider.
        Kept as a pure seam so provider-specific payload policy is unit-testable
        without making a network request. Default `opts` reproduces the exact
        800-token/0.6-temperature payload this always sent. */
    static juce::var requestPayload (const Provider&, const juce::var& messages, const ChatOptions& opts = {});

    /** Default `opts` (timeoutMs==0) reproduces the pre-W1.1 120s-local/30s-cloud
        split exactly. A positive opts.timeoutMs (already clamped by optionsFromVar)
        overrides that split outright. */
    static int requestTimeoutMs (const Provider&, const ChatOptions& opts = {});

    static juce::var parseDirectResponse (const juce::String& body, int statusCode,
                                          const Provider&, int elapsedMs);

    /** Blocking chat round-trip. `messages` is a JSON array of {role,content}.
        Returns { ok:true, content, provider, model, ms } on success, or
        { ok:false, error } on any failure (no provider / network / upstream). Call
        OFF the message thread.

        Proxy-first: when proxyEnabled(), this POSTs to the server-side brain proxy
        (supabase/functions/brain) instead of calling a provider directly with a
        bundled key. Any proxy failure (unreachable / non-2xx / malformed reply) falls
        through to the direct-provider path below it — additive, never a regression
        from the pre-proxy behaviour (proxyEnabled()==false skips the branch entirely,
        so an unset MOSH_BRAIN_PROXY_URL is byte-identical to before this existed).

        Default `opts` keeps every existing caller's wire payload byte-identical. */
    static juce::var chat (const juce::var& messages, const juce::String& requested = {}, const ChatOptions& opts = {});

    /** Diagnostics for a future picker / the log: which providers are configured. */
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
        Reused from "<session>/identity.json" under the same validated SessionPaths
        boundary MoshEngine uses. MOSH_BRAIN_INSTALL_ID overrides without filesystem
        I/O; unsafe explicit sessions resolve to per-process safety storage. */
    static juce::String installId();

    /** App-owned, loopback-only owner runtime. Activated only after /v1/models
        reports the exact configured fused path. */
    static void configureLocal (const juce::String& endpoint, const juce::String& exactModel);
};

} // namespace mosh
